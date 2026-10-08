use serde_json::{Map, Value};
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

pub struct Session {
    stream: BufReader<Box<dyn Io>>,
    pub bytes_in: usize,
    pub bytes_out: usize,
    pub details: Map<String, Value>,
    limit: usize,
}

pub fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Only printable, bounded metadata is allowed into the queue. No raw payloads.
pub fn clean(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(160)
        .collect()
}

impl Session {
    pub fn new(stream: Box<dyn Io>, limit: usize) -> Self {
        Self {
            stream: BufReader::with_capacity(1024, stream),
            bytes_in: 0,
            bytes_out: 0,
            details: Map::new(),
            limit,
        }
    }
    pub fn detail(&mut self, key: &str, value: impl AsRef<str>) {
        if self.details.len() < 24 {
            self.details
                .insert(key.to_owned(), Value::String(clean(value.as_ref())));
        }
    }
    pub async fn read(&mut self, len: usize) -> io::Result<Vec<u8>> {
        if len > self.limit.saturating_sub(self.bytes_in) {
            return Err(invalid("read budget exceeded"));
        }
        let mut bytes = vec![0; len];
        let mut offset = 0;
        while offset < len {
            let n = self.stream.read(&mut bytes[offset..]).await?;
            self.bytes_in += n;
            if n == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "peer closed"));
            }
            offset += n;
        }
        Ok(bytes)
    }
    pub async fn line(&mut self) -> io::Result<String> {
        let mut bytes = Vec::new();
        loop {
            let b = self.read(1).await?[0];
            if b == b'\n' {
                break;
            }
            bytes.push(b);
            if bytes.len() > 2048 {
                return Err(invalid("line too long"));
            }
        }
        Ok(String::from_utf8_lossy(&bytes)
            .trim_end_matches('\r')
            .to_owned())
    }
    pub async fn send(&mut self, bytes: impl AsRef<[u8]>) -> io::Result<()> {
        let bytes = bytes.as_ref();
        if self.bytes_out + bytes.len() > 16384 {
            return Err(invalid("write budget exceeded"));
        }
        self.stream.write_all(bytes).await?;
        self.stream.flush().await?;
        self.bytes_out += bytes.len();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn fragmented_input_and_budget() {
        let (client, server) = tokio::io::duplex(64);
        let mut s = Session::new(Box::new(server), 4);
        tokio::spawn(async move {
            let mut client = client;
            client.write_all(b"ab").await.unwrap();
            tokio::task::yield_now().await;
            client.write_all(b"c\n").await.unwrap();
        });
        assert_eq!(s.line().await.unwrap(), "abc");
        assert!(s.read(1).await.is_err());
        assert_eq!(s.bytes_in, 4);
    }
    #[test]
    fn metadata_removes_controls_and_bounds_unicode() {
        assert_eq!(clean("a\x1b\n\0b"), "ab");
        assert_eq!(clean(&"🦀".repeat(1000)).chars().count(), 160);
    }
}
