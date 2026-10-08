use crate::session::{Session, invalid};
use std::io;

// We only inspect the first BSON key, never recursively decode untrusted documents.
fn command(doc: &[u8]) -> io::Result<&str> {
    if doc.len() < 7 {
        return Err(invalid("short BSON document"));
    }
    let len = i32::from_le_bytes(doc[..4].try_into().unwrap());
    if len < 7 || len as usize > doc.len() || doc[len as usize - 1] != 0 {
        return Err(invalid("invalid BSON length"));
    }
    let end = doc[5..len as usize]
        .iter()
        .position(|b| *b == 0)
        .ok_or_else(|| invalid("invalid BSON key"))?
        + 5;
    std::str::from_utf8(&doc[5..end]).map_err(|_| invalid("invalid BSON key"))
}

fn int(doc: &mut Vec<u8>, key: &str, value: i32) {
    doc.push(0x10);
    doc.extend_from_slice(key.as_bytes());
    doc.push(0);
    doc.extend_from_slice(&value.to_le_bytes());
}
fn boolean(doc: &mut Vec<u8>, key: &str) {
    doc.push(8);
    doc.extend_from_slice(key.as_bytes());
    doc.extend_from_slice(&[0, 1]);
}
fn string(doc: &mut Vec<u8>, key: &str, value: &str) {
    doc.push(2);
    doc.extend_from_slice(key.as_bytes());
    doc.push(0);
    doc.extend_from_slice(&((value.len() + 1) as i32).to_le_bytes());
    doc.extend_from_slice(value.as_bytes());
    doc.push(0);
}
fn document(hello: bool, ok: bool) -> Vec<u8> {
    let mut doc = vec![0; 4];
    if hello {
        for key in ["ismaster", "isWritablePrimary", "helloOk"] {
            boolean(&mut doc, key);
        }
        for (key, value) in [
            ("minWireVersion", 0),
            ("maxWireVersion", 17),
            ("maxBsonObjectSize", 16_777_216),
            ("maxMessageSizeBytes", 48_000_000),
            ("maxWriteBatchSize", 100_000),
        ] {
            int(&mut doc, key, value);
        }
    }
    if !ok {
        int(&mut doc, "code", 13);
        string(&mut doc, "errmsg", "Unauthorized");
    }
    doc.push(1);
    doc.extend_from_slice(b"ok\0");
    doc.extend_from_slice(&(if ok { 1f64 } else { 0f64 }).to_le_bytes());
    doc.push(0);
    let len = doc.len() as i32;
    doc[..4].copy_from_slice(&len.to_le_bytes());
    doc
}

pub async fn handle(s: &mut Session) -> io::Result<()> {
    for _ in 0..4 {
        let header = s.read(16).await?;
        let len = i32::from_le_bytes(header[..4].try_into().unwrap());
        if len < 21 {
            return Err(invalid("invalid MongoDB frame length"));
        }
        let op = i32::from_le_bytes(header[12..16].try_into().unwrap());
        let body = s.read(len as usize - 16).await?;
        let doc = match op {
            2013 => {
                if body.len() < 5 || body[4] != 0 {
                    return Err(invalid("expected OP_MSG body section"));
                }
                let flags = u32::from_le_bytes(body[..4].try_into().unwrap());
                if flags & 0xffff != 0 {
                    return Err(invalid("unsupported OP_MSG flags"));
                }
                &body[5..]
            }
            2004 => {
                if body.len() < 5 {
                    return Err(invalid("short OP_QUERY"));
                }
                let end = body[4..]
                    .iter()
                    .position(|b| *b == 0)
                    .ok_or_else(|| invalid("invalid namespace"))?
                    + 4;
                body.get(end + 9..)
                    .ok_or_else(|| invalid("short OP_QUERY"))?
            }
            _ => return Err(invalid("unsupported MongoDB opcode")),
        };
        let name = command(doc)?;
        s.detail("command", name);
        let hello = matches!(name, "hello" | "isMaster" | "ismaster");
        let ok = hello || name == "ping";
        let doc = document(hello, ok);
        let mut response_body = if op == 2013 {
            vec![0; 5]
        } else {
            let mut b = vec![0; 16]; // flags, cursorID, startingFrom.
            b.extend_from_slice(&1i32.to_le_bytes());
            b
        };
        response_body.extend_from_slice(&doc);
        let mut reply = ((16 + response_body.len()) as i32).to_le_bytes().to_vec();
        reply.extend_from_slice(&1i32.to_le_bytes());
        reply.extend_from_slice(&header[4..8]); // responseTo.
        reply.extend_from_slice(&(if op == 2013 { 2013i32 } else { 1i32 }).to_le_bytes());
        reply.extend_from_slice(&response_body);
        s.send(reply).await?;
        if !ok {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_truncated_and_negative_bson_lengths() {
        assert!(command(&[255; 16]).is_err());
        assert!(command(&[12, 0, 0, 0, 16, b'x', 0]).is_err());
        assert_eq!(command(&document(true, true)).unwrap(), "ismaster");
    }
}
