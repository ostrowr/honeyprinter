mod binary;
mod mongo;
mod text;

use crate::session::Session;
use std::io;

pub async fn handle(handler: &str, s: &mut Session) -> io::Result<()> {
    match handler {
        "ssh" | "ftp" | "smtp" | "pop3" | "imap" | "telnet" | "http" | "proxy" | "rtsp" | "sip"
        | "redis" | "memcached" | "irc" => text::handle(handler, s).await,
        "mongodb" => mongo::handle(s).await,
        _ => binary::handle(handler, s).await,
    }
}
