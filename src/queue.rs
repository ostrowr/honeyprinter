use serde::Serialize;
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncWrite, AsyncWriteExt},
    sync::mpsc,
    time::{Duration, Instant, MissedTickBehavior},
};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Serialize)]
pub struct Probe {
    pub schema_version: u8,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub event_id: String,
    pub observed_at_ms: u64,
    pub source_ip: String,
    pub source_port: u16,
    pub destination_port: u16,
    pub service: &'static str,
    pub tls: bool,
    pub stage: &'static str,
    pub outcome: &'static str,
    pub duration_ms: u64,
    pub bytes_in: usize,
    pub bytes_out: usize,
    pub details: Map<String, Value>,
}

#[derive(Default)]
pub struct Counters {
    pub queue_dropped: AtomicU64,
    pub connection_rejected: AtomicU64,
    pub upload_dropped: AtomicU64,
}

#[derive(Default)]
struct Window {
    total: u64,
    services: BTreeMap<&'static str, u64>,
    outcomes: BTreeMap<&'static str, u64>,
    sources: BTreeSet<String>,
    sources_truncated: bool,
    samples: Vec<Value>,
}

impl Window {
    fn add(&mut self, probe: &Probe) {
        self.total += 1;
        *self.services.entry(probe.service).or_default() += 1;
        *self.outcomes.entry(probe.outcome).or_default() += 1;
        if self.sources.len() < 1024 {
            self.sources.insert(probe.source_ip.clone());
        } else if !self.sources.contains(&probe.source_ip) {
            self.sources_truncated = true;
        }
        if self.samples.len() < 8 {
            self.samples.push(json!({"service": probe.service, "source_ip": probe.source_ip, "details": probe.details}));
        }
    }
    fn take(&mut self, counters: &Counters, start: u64, kind: &str) -> Option<Value> {
        let dropped = counters.queue_dropped.swap(0, Ordering::Relaxed);
        let rejected = counters.connection_rejected.swap(0, Ordering::Relaxed);
        let upload_dropped = counters.upload_dropped.swap(0, Ordering::Relaxed);
        if self.total == 0 && dropped == 0 && rejected == 0 && upload_dropped == 0 {
            return None;
        }
        let result = json!({
            "schema_version": 1, "type": kind, "window_start_ms": start, "window_end_ms": now_ms(),
            "probes": self.total, "services": self.services, "outcomes": self.outcomes,
            "distinct_source_ips": self.sources.len(), "distinct_source_ips_is_lower_bound": self.sources_truncated,
            "queue_dropped": dropped, "connections_rejected": rejected, "samples": self.samples,
            "upload_dropped": upload_dropped,
            "summarizer": "mock", "sample_policy": "first 8 events; counts include every dequeued event"
        });
        *self = Self::default();
        Some(result)
    }
}

async fn write_json(
    writer: &mut (dyn AsyncWrite + Unpin + Send),
    value: &impl Serialize,
) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    tokio::time::timeout(Duration::from_secs(5), async {
        writer.write_all(&bytes).await?;
        writer.flush().await
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "mock queue output blocked"))?
}

/// Bounded ingestion, optional in-memory uploads, and diagnostic mock summaries.
pub async fn run(
    mut rx: mpsc::Receiver<Probe>,
    counters: Arc<Counters>,
    events: Option<PathBuf>,
    seconds: u64,
    uploads: Option<mpsc::Sender<Probe>>,
) -> io::Result<()> {
    let mut events: Option<Box<dyn AsyncWrite + Unpin + Send>> = match events {
        Some(path) if path.as_os_str() == "-" => Some(Box::new(tokio::io::stdout())),
        Some(path) => Some(Box::new(
            tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .await?,
        )),
        None => None,
    };
    let mut stdout = tokio::io::stdout();
    let period = Duration::from_secs(seconds);
    let mut timer = tokio::time::interval_at(Instant::now() + period, period);
    timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut window = Window::default();
    let mut start = now_ms();
    loop {
        tokio::select! {
            // Prefer the timer when the queue is continuously busy.
            biased;
            _ = timer.tick() => {
                if let Some(summary) = window.take(&counters, start, "minute_summary") { write_json(&mut stdout, &summary).await?; }
                start = now_ms();
            }
            event = rx.recv() => match event {
                Some(event) => {
                    window.add(&event);
                    if let Some(writer) = events.as_mut() { write_json(writer.as_mut(), &event).await?; }
                    if let Some(uploads) = &uploads && uploads.try_send(event).is_err() {
                        counters.upload_dropped.fetch_add(1, Ordering::Relaxed);
                    }
                }
                None => {
                    // Diagnostic only: a consumer must not print this as an extra receipt.
                    if let Some(summary) = window.take(&counters, start, "shutdown_summary") { write_json(&mut stdout, &summary).await?; }
                    return Ok(());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn totals_survive_sample_and_distinct_source_limits() {
        let mut window = Window::default();
        for i in 0..2000 {
            window.add(&Probe {
                schema_version: 1,
                kind: "probe",
                event_id: i.to_string(),
                observed_at_ms: 0,
                source_ip: i.to_string(),
                source_port: 1,
                destination_port: 80,
                service: "http",
                tls: false,
                stage: "application",
                outcome: "completed",
                duration_ms: 0,
                bytes_in: 1,
                bytes_out: 1,
                details: Map::new(),
            });
        }
        let counters = Counters::default();
        counters.queue_dropped.store(7, Ordering::Relaxed);
        let summary = window.take(&counters, 0, "minute_summary").unwrap();
        assert_eq!(summary["probes"], 2000);
        assert_eq!(summary["services"]["http"], 2000);
        assert_eq!(summary["samples"].as_array().unwrap().len(), 8);
        assert_eq!(summary["distinct_source_ips"], 1024);
        assert_eq!(summary["distinct_source_ips_is_lower_bound"], true);
        assert_eq!(summary["queue_dropped"], 7);
        assert!(window.take(&counters, 0, "minute_summary").is_none());
    }
}
