//! Durable, bounded, at-least-once delivery. The receiver deduplicates event UUIDs.
use crate::queue::Probe;
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    io,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, watch};

#[derive(Clone)]
pub struct Outbox {
    db: Arc<Mutex<Connection>>,
    notify: Arc<Notify>,
    capacity: u32,
}

impl Outbox {
    pub fn open(path: &Path, capacity: u32) -> io::Result<Self> {
        let db = Connection::open(path).map_err(io::Error::other)?;
        db.busy_timeout(Duration::from_secs(2))
            .map_err(io::Error::other)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS outbox (
                id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
                payload TEXT NOT NULL, rejected_status INTEGER
            );
            CREATE INDEX IF NOT EXISTS pending ON outbox(id) WHERE rejected_status IS NULL;",
        )
        .map_err(io::Error::other)?;
        Ok(Self {
            db: Arc::new(Mutex::new(db)),
            notify: Arc::new(Notify::new()),
            capacity,
        })
    }

    async fn query<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    ) -> io::Result<T> {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            let mut db = db
                .lock()
                .map_err(|_| io::Error::other("outbox lock poisoned"))?;
            f(&mut db).map_err(io::Error::other)
        })
        .await
        .map_err(io::Error::other)?
    }

    pub async fn persist(&self, probe: &Probe) -> io::Result<bool> {
        let payload = serde_json::to_string(probe)?;
        let id = probe.event_id.clone();
        let capacity = self.capacity;
        let saved = self
            .query(move |db| {
                let tx = db.transaction()?;
                let count: u32 = tx.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0))?;
                if count >= capacity {
                    return Ok(false);
                }
                tx.execute(
                    "INSERT OR IGNORE INTO outbox(event_id, payload) VALUES (?, ?)",
                    params![id, payload],
                )?;
                tx.commit()?;
                Ok(true)
            })
            .await?;
        if saved {
            self.notify.notify_one();
        }
        Ok(saved)
    }

    pub async fn upload(
        &self,
        endpoint: String,
        token: String,
        mut stop: watch::Receiver<bool>,
    ) -> io::Result<()> {
        let mut authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| io::Error::other("invalid ingest token"))?;
        authorization.set_sensitive(true);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(io::Error::other)?;
        let mut backoff = 1;
        loop {
            if *stop.borrow() {
                return Ok(());
            }
            let row = self.query(|db| db.query_row("SELECT id, payload FROM outbox WHERE rejected_status IS NULL ORDER BY id LIMIT 1", [], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).optional()).await?;
            let Some((id, payload)) = row else {
                tokio::select! { _ = stop.changed() => return Ok(()), _ = self.notify.notified() => {}, _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
                continue;
            };
            let response = tokio::select! {
                _ = stop.changed() => return Ok(()),
                response = client.post(&endpoint).header(reqwest::header::AUTHORIZATION, authorization.clone()).header(reqwest::header::CONTENT_TYPE, "application/json").body(payload).send() => response,
            };
            match response {
                Ok(response) if response.status().is_success() => {
                    self.query(move |db| db.execute("DELETE FROM outbox WHERE id = ?", [id]))
                        .await?;
                    backoff = 1;
                    continue;
                }
                Ok(response) if matches!(response.status().as_u16(), 400 | 413 | 415 | 422) => {
                    let status = response.status().as_u16();
                    self.query(move |db| {
                        db.execute(
                            "UPDATE outbox SET rejected_status = ? WHERE id = ?",
                            params![status, id],
                        )
                    })
                    .await?;
                    eprintln!(
                        "upload rejected with HTTP {status}; event retained in outbox for inspection"
                    );
                    backoff = 1;
                    continue;
                }
                Ok(response) => eprintln!(
                    "upload returned HTTP {}; retrying in {backoff}s",
                    response.status().as_u16()
                ),
                Err(_) => eprintln!("upload unavailable; retrying in {backoff}s"),
            }
            tokio::select! { _ = stop.changed() => return Ok(()), _ = tokio::time::sleep(Duration::from_secs(backoff)) => {} }
            backoff = (backoff * 2).min(60);
        }
    }
}

pub fn validate_endpoint(value: &str) -> io::Result<()> {
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
