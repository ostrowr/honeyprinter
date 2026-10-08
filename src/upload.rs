//! Best-effort, rate-limited batches. Failed or excess events are dropped, not retried.
use crate::queue::{Counters, Probe};
use std::{
    io,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio::{sync::mpsc, time::Instant};

const MAX_BATCH_BYTES: usize = 256 * 1024;

pub struct Uploader {
    endpoint: String,
    authorization: reqwest::header::HeaderValue,
    client: reqwest::Client,
    interval: Duration,
    batch_size: usize,
}

impl Uploader {
    pub fn new(
        endpoint: &str,
        token: &str,
        interval: Duration,
        batch_size: usize,
    ) -> io::Result<Self> {
        validate_endpoint(endpoint)?;
        if token.trim().is_empty() {
            return Err(io::Error::other("ingest token is empty"));
        }
        let mut authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| io::Error::other("invalid ingest token"))?;
        authorization.set_sensitive(true);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(io::Error::other)?;
        Ok(Self {
            endpoint: endpoint.to_owned(),
            authorization,
            client,
            interval,
            batch_size,
        })
    }

    pub async fn run(
        self,
        mut rx: mpsc::Receiver<Probe>,
        counters: Arc<Counters>,
    ) -> io::Result<()> {
        let mut next_send = Instant::now() + self.interval;
        while let Some(first) = rx.recv().await {
            // A deadline based on completion avoids catch-up bursts after a slow request.
            tokio::time::sleep_until(next_send).await;
            let mut body = br#"{"schema_version":1,"type":"probe_batch","events":["#.to_vec();
            let mut count = 0;
            let mut next = Some(first);
            for _ in 0..self.batch_size {
                let Some(probe) = next.take() else { break };
                let encoded = serde_json::to_vec(&probe)?;
                if body.len() + encoded.len() + 3 > MAX_BATCH_BYTES {
                    counters.upload_dropped.fetch_add(1, Ordering::Relaxed);
                    break;
                }
                if count > 0 {
                    body.push(b',');
                }
                body.extend(encoded);
                count += 1;
                // Do not remove one extra event when the batch is already full.
                if count < self.batch_size {
                    next = rx.try_recv().ok();
                }
            }
            body.extend(b"]}");
            if count == 0 {
                continue;
            }
            let response = self
                .client
                .post(&self.endpoint)
                .header(reqwest::header::AUTHORIZATION, self.authorization.clone())
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body)
                .send()
                .await;
            next_send = Instant::now() + self.interval;
            match response {
                Ok(response) if response.status().is_success() => (),
                Ok(response) => {
                    counters
                        .upload_dropped
                        .fetch_add(count as u64, Ordering::Relaxed);
                    eprintln!(
                        "upload returned HTTP {}; dropped {count} probes",
                        response.status().as_u16()
                    );
                }
                Err(_) => {
                    counters
                        .upload_dropped
                        .fetch_add(count as u64, Ordering::Relaxed);
                    eprintln!("upload unavailable; dropped {count} probes");
                }
            }
        }
        Ok(())
    }
}

fn validate_endpoint(value: &str) -> io::Result<()> {
    let url = reqwest::Url::parse(value).map_err(|_| io::Error::other("invalid ingest URL"))?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(local && url.scheme() == "http"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(io::Error::other(
            "ingest URL must use HTTPS (HTTP allowed on localhost), without credentials, query, or fragment",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transport_requires_tls_except_loopback() {
        assert!(validate_endpoint("https://ostro.ws/honeyprinter/api/probes").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:8787/honeyprinter/api/probes").is_ok());
        assert!(validate_endpoint("http://example.com/").is_err());
        assert!(validate_endpoint("https://user:secret@example.com/").is_err());
    }
}
