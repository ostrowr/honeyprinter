mod catalog;
mod protocols;
mod queue;
mod session;
mod upload;

use catalog::Service;
use clap::Parser;
use queue::{Counters, Probe};
use session::{Io, Session};
use std::{
    io,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{Arc, atomic::Ordering},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{Semaphore, mpsc, watch},
    task::JoinSet,
    time::{Duration, Instant, timeout_at},
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{self, pki_types::PrivatePkcs8KeyDer},
};

#[derive(Parser, Debug)]
#[command(
    version,
    about = "Minimal TCP protocol decoys; JSONL mock queue and one summary per active minute"
)]
struct Args {
    /// Bind address; use 0.0.0.0 explicitly for public IPv4 exposure.
    #[arg(long, default_value = "127.0.0.1")]
    bind: IpAddr,
    /// Comma-separated service names, optionally name:port; see --list.
    #[arg(long, default_value = "all")]
    services: String,
    /// Added to every configured port. Set 0 to use standard service ports.
    #[arg(long, default_value_t = 10000)]
    port_offset: u16,
    /// List supported services and exit.
    #[arg(long)]
    list: bool,
    /// Append individual probe events to this JSONL file, or '-' for stdout.
    #[arg(long)]
    events: Option<PathBuf>,
    /// Total deadline per connection, including TLS negotiation.
    #[arg(long, default_value_t = 5, value_parser = clap::value_parser!(u64).range(1..=60))]
    timeout_secs: u64,
    #[arg(long, default_value_t = 128, value_parser = clap::value_parser!(u32).range(1..=4096))]
    max_connections: u32,
    #[arg(long, default_value_t = 1024, value_parser = clap::value_parser!(u32).range(1..=65536))]
    queue_capacity: u32,
    #[arg(long, default_value_t = 8192, value_parser = clap::value_parser!(u32).range(512..=65536))]
    max_read_bytes: u32,
    /// Summary interval. At least 60 seconds; empty windows emit nothing.
    #[arg(long, default_value_t = 60, value_parser = clap::value_parser!(u64).range(60..=86400))]
    summary_secs: u64,
    /// Deliver probe batches to this HTTPS endpoint; token comes from HONEYPRINTER_INGEST_TOKEN.
    #[arg(long)]
    ingest_url: Option<String>,
    /// Maximum waiting probes in memory, in addition to the current batch. Drops when full.
    #[arg(long, default_value_t = 1024, value_parser = clap::value_parser!(u32).range(1..=65536))]
    upload_capacity: u32,
    /// Minimum gap between upload requests. Empty buffers send nothing.
    #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u64).range(1..=60))]
    upload_interval_secs: u64,
    /// Maximum probes per upload request (also capped at 256 KiB).
    #[arg(long, default_value_t = 256, value_parser = clap::value_parser!(u32).range(1..=1000))]
    upload_batch_size: u32,
}

#[tokio::main(worker_threads = 2)]
async fn main() -> io::Result<()> {
    let args = Arc::new(Args::parse());
    if args.list {
        for service in catalog::SERVICES {
            println!(
                "{:<15} {:>5}/tcp  {}{}",
                service.name,
                service.port,
                service.handler,
                if service.tls { " over TLS" } else { "" }
            );
        }
        return Ok(());
    }
    let upload = match &args.ingest_url {
        Some(url) => {
            let token = std::env::var("HONEYPRINTER_INGEST_TOKEN")
                .map_err(|_| io::Error::other("set HONEYPRINTER_INGEST_TOKEN to enable uploads"))?;
            Some(upload::Uploader::new(
                url,
                &token,
                Duration::from_secs(args.upload_interval_secs),
                args.upload_batch_size as usize,
            )?)
        }
        None => None,
    };
    let selected = catalog::select(&args.services, args.port_offset)?;
    let tls = if selected.iter().any(|s| s.tls) {
        Some(tls_acceptor()?)
    } else {
        None
    };
    // Bind every port before accepting anything: a failed bind means failed startup.
    let mut listeners = Vec::new();
    for service in selected {
        let addr = SocketAddr::new(args.bind, service.port);
        let listener = TcpListener::bind(addr).await.map_err(|e| {
            io::Error::new(
                e.kind(),
                format!("cannot bind {} at {addr}: {e}", service.name),
            )
        })?;
        listeners.push((service, listener));
    }
    let permits = Arc::new(Semaphore::new(args.max_connections as usize));
    let counters = Arc::new(Counters::default());
    let (tx, rx) = mpsc::channel(args.queue_capacity as usize);
    let (upload_tx, mut uploader) = match upload {
        Some(upload) => {
            let (tx, rx) = mpsc::channel(args.upload_capacity as usize);
            (
                Some(tx),
                Some(tokio::spawn(upload.run(rx, counters.clone()))),
            )
        }
        None => (None, None),
    };
    let mut consumer = tokio::spawn(queue::run(
        rx,
        counters.clone(),
        args.events.clone(),
        args.summary_secs,
        upload_tx,
    ));
    let (stop_tx, stop_rx) = watch::channel(false);
    let mut tasks = JoinSet::new();
    for (service, listener) in listeners {
        eprintln!(
            "listening {} {}{}",
            service.name,
            listener.local_addr()?,
            if service.tls { " TLS" } else { "" }
        );
        let (args, permits, counters, tx, mut stop, tls) = (
            args.clone(),
            permits.clone(),
            counters.clone(),
            tx.clone(),
            stop_rx.clone(),
            tls.clone(),
        );
        tasks.spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    _ = stop.changed() => break,
                    result = connections.join_next(), if !connections.is_empty() => {
                        if let Some(Err(e)) = result { eprintln!("connection task failed: {e}"); }
                    }
                    accepted = listener.accept() => {
                        let (socket, peer) = accepted?;
                        match permits.clone().try_acquire_owned() {
                            Ok(permit) => {
                                let (args, counters, tx, tls) = (args.clone(), counters.clone(), tx.clone(), tls.clone());
                                connections.spawn(async move {
                                    let _permit = permit;
                                    let probe = serve(socket, peer, service, tls, &args).await;
                                    if tx.try_send(probe).is_err() { counters.queue_dropped.fetch_add(1, Ordering::Relaxed); }
                                });
                            }
                            Err(_) => { counters.connection_rejected.fetch_add(1, Ordering::Relaxed); }
                        }
                    }
                }
            }
            drop(listener);
            while let Some(result) = connections.join_next().await {
                if let Err(e) = result { eprintln!("connection task failed: {e}"); }
            }
            Ok::<_, io::Error>(())
        });
    }
    drop(tx);
    tokio::select! {
        signal = shutdown_signal() => signal?,
        result = async { uploader.as_mut().expect("uploader enabled").await }, if uploader.is_some() => {
            return result.map_err(io::Error::other)?.and(Err(io::Error::other("uploader stopped unexpectedly")));
        }
        result = &mut consumer => {
            return result.map_err(io::Error::other)?.and(Err(io::Error::other("mock queue stopped unexpectedly")));
        }
        result = tasks.join_next() => {
            return match result {
                Some(Ok(Err(e))) => Err(e),
                other => Err(io::Error::other(format!("listener stopped unexpectedly: {other:?}"))),
            };
        }
    }
    eprintln!("shutting down; draining active connections and mock queue");
    let _ = stop_tx.send(true);
    while let Some(result) = tasks.join_next().await {
        result.map_err(io::Error::other)??;
    }
    consumer.await.map_err(io::Error::other)??;
    if let Some(mut uploader) = uploader {
        // Best effort: drain when reachable, but never hang shutdown during an outage.
        match tokio::time::timeout(Duration::from_secs(5), &mut uploader).await {
            Ok(result) => result.map_err(io::Error::other)??,
            Err(_) => {
                eprintln!("upload shutdown deadline reached; discarding unsent in-memory probes");
                uploader.abort();
                let _ = uploader.await;
            }
        }
    }
    Ok(())
}

fn tls_acceptor() -> io::Result<TlsAcceptor> {
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(vec!["localhost".into(), "honeyprinter.local".into()])
            .map_err(io::Error::other)?;
    let key = PrivatePkcs8KeyDer::from(signing_key.serialize_der());
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert.der().clone()], key.into())
        .map_err(io::Error::other)?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

async fn serve(
    socket: TcpStream,
    peer: SocketAddr,
    service: Service,
    tls: Option<TlsAcceptor>,
    args: &Args,
) -> Probe {
    let start = Instant::now();
    let deadline = start + Duration::from_secs(args.timeout_secs);
    let mut probe = Probe {
        schema_version: 1,
        kind: "probe",
        event_id: uuid::Uuid::new_v4().to_string(),
        observed_at_ms: queue::now_ms(),
        source_ip: peer.ip().to_string(),
        source_port: peer.port(),
        destination_port: service.port,
        service: service.name,
        tls: service.tls,
        stage: "connected",
        outcome: "completed",
        duration_ms: 0,
        bytes_in: 0,
        bytes_out: 0,
        details: Default::default(),
    };
    let _ = socket.set_nodelay(true);
    let io: Box<dyn Io> = if service.tls {
        match timeout_at(
            deadline,
            tls.expect("TLS config initialized").accept(socket),
        )
        .await
        {
            Ok(Ok(stream)) => {
                probe.stage = "tls";
                if let Some(name) = stream.get_ref().1.server_name() {
                    probe
                        .details
                        .insert("sni".into(), session::clean(name).into());
                }
                if let Some(version) = stream.get_ref().1.protocol_version() {
                    probe
                        .details
                        .insert("tls_version".into(), format!("{version:?}").into());
                }
                Box::new(stream)
            }
            result => {
                probe.outcome = if result.is_err() {
                    "timeout"
                } else {
                    "tls_error"
                };
                probe.duration_ms = start.elapsed().as_millis() as u64;
                return probe;
            }
        }
    } else {
        Box::new(socket)
    };
    let mut session = Session::new(io, args.max_read_bytes as usize);
    match timeout_at(deadline, protocols::handle(service.handler, &mut session)).await {
        Ok(Ok(())) => (),
        Err(_) => probe.outcome = "timeout",
        Ok(Err(error)) => {
            probe.outcome = match error.kind() {
                io::ErrorKind::UnexpectedEof
                | io::ErrorKind::ConnectionReset
                | io::ErrorKind::BrokenPipe => "peer_closed",
                io::ErrorKind::InvalidData => "invalid_input",
                _ => "io_error",
            };
            if error.kind() == io::ErrorKind::InvalidData {
                session.detail("error", error.to_string());
            }
        }
    }
    if session.bytes_in > 0 {
        probe.stage = "application";
    }
    probe.bytes_in = session.bytes_in;
    probe.bytes_out = session.bytes_out;
    probe.details.extend(session.details);
    probe.duration_ms = start.elapsed().as_millis() as u64;
    probe
}

async fn shutdown_signal() -> io::Result<()> {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! { result = tokio::signal::ctrl_c() => result, _ = term.recv() => Ok(()) }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await
    }
}
