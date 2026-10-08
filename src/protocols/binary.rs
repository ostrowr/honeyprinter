use crate::session::{Session, invalid};
use std::io;

pub async fn handle(protocol: &str, s: &mut Session) -> io::Result<()> {
    match protocol {
        "mysql" => mysql(s).await,
        "postgres" => postgres(s).await,
        "mqtt" => mqtt(s).await,
        "ldap" => ldap(s).await,
        "amqp" => amqp(s).await,
        "socks5" => {
            let h = s.read(2).await?;
            if h[0] != 5 || h[1] == 0 {
                return Err(invalid("invalid SOCKS greeting"));
            }
            s.read(h[1] as usize).await?;
            s.detail("action", "method negotiation");
            s.send([5, 255]).await
        }
        "vnc" => {
            s.send("RFB 003.008\n").await?;
            let version = s.read(12).await?;
            if !version.starts_with(b"RFB 003.") {
                return Err(invalid("invalid RFB version"));
            }
            s.detail("client_version", String::from_utf8_lossy(&version));
            let mut response = if &version[8..11] == b"003" {
                vec![0; 4]
            } else {
                vec![0]
            };
            if &version[8..11] != b"007" {
                response.extend_from_slice(&21u32.to_be_bytes());
                response.extend_from_slice(b"Authentication failed");
            }
            s.send(response).await
        }
        "rdp" => {
            let header = s.read(4).await?;
            let len = u16::from_be_bytes([header[2], header[3]]) as usize;
            if header[..2] != [3, 0] || len < 11 {
                return Err(invalid("invalid TPKT header"));
            }
            let body = s.read(len - 4).await?;
            if body[1] != 0xe0 {
                return Err(invalid("expected X.224 connection request"));
            }
            s.detail("action", "X.224 negotiation");
            // X.224 Connection Confirm + RDP_NEG_FAILURE (HYBRID_REQUIRED_BY_SERVER).
            s.send([3, 0, 0, 19, 14, 0xd0, 0, 0, 0, 0, 0, 3, 0, 8, 0, 5, 0, 0, 0])
                .await
        }
        "mssql" => {
            let header = s.read(8).await?;
            let len = u16::from_be_bytes([header[2], header[3]]) as usize;
            if header[0] != 0x12 || header[1] != 1 || len < 9 {
                return Err(invalid("expected single TDS PRELOGIN packet"));
            }
            s.read(len - 8).await?;
            s.detail("action", "TDS prelogin");
            // PRELOGIN VERSION and ENCRYPTION=NOT_SUP. No LOGIN7 processing.
            let payload = [0, 0, 11, 0, 6, 1, 0, 17, 0, 1, 255, 15, 0, 7, 208, 0, 0, 2];
            let mut reply = vec![4, 1, 0, 26, 0, 0, 1, 0];
            reply.extend_from_slice(&payload);
            s.send(reply).await
        }
        "smb" => smb(s).await,
        _ => Err(invalid("unknown binary protocol")),
    }
}

async fn mysql(s: &mut Session) -> io::Result<()> {
    let caps: u32 = 0x0008_8208; // Protocol41, secure connection, plugin auth, connect-with-db.
    let mut hello = vec![10];
    hello.extend_from_slice(b"8.0.36\0");
    hello.extend_from_slice(&1u32.to_le_bytes());
    hello.extend_from_slice(b"abcdefgh\0");
    hello.extend_from_slice(&(caps as u16).to_le_bytes());
    hello.push(45);
    hello.extend_from_slice(&2u16.to_le_bytes());
    hello.extend_from_slice(&((caps >> 16) as u16).to_le_bytes());
    hello.push(21);
    hello.extend_from_slice(&[0; 10]);
    hello.extend_from_slice(b"ijklmnopqrst\0mysql_native_password\0");
    mysql_packet(s, 0, &hello).await?;
    let header = s.read(4).await?;
    let len = u32::from_le_bytes([header[0], header[1], header[2], 0]) as usize;
    if len < 32 || header[3] != 1 {
        return Err(invalid("invalid MySQL handshake response"));
    }
    let body = s.read(len).await?;
    let capabilities = u32::from_le_bytes(body[..4].try_into().unwrap());
    s.detail("client_capabilities", format!("0x{capabilities:08x}"));
    // Do not retain the authentication response or any credentials.
    let mut error = vec![0xff, 0x15, 0x04]; // ER_ACCESS_DENIED_ERROR (1045).
    error.extend_from_slice(b"#28000Access denied");
    mysql_packet(s, 2, &error).await
}

async fn mysql_packet(s: &mut Session, sequence: u8, body: &[u8]) -> io::Result<()> {
    let len = (body.len() as u32).to_le_bytes();
    let mut packet = vec![len[0], len[1], len[2], sequence];
    packet.extend_from_slice(body);
    s.send(packet).await
}

async fn postgres(s: &mut Session) -> io::Result<()> {
    for _ in 0..3 {
        let header = s.read(4).await?;
        let len = u32::from_be_bytes(header.try_into().unwrap()) as usize;
        if len < 8 {
            return Err(invalid("invalid PostgreSQL message length"));
        }
        let body = s.read(len - 4).await?;
        let code = u32::from_be_bytes(body[..4].try_into().unwrap());
        match code {
            80877103 | 80877104 if len == 8 => {
                s.detail(
                    "encryption_request",
                    if code == 80877103 { "SSL" } else { "GSS" },
                );
                s.send(b"N").await?;
            }
            196608 => {
                let fields: Vec<_> = body[4..].split(|b| *b == 0).collect();
                for pair in fields.as_chunks::<2>().0 {
                    if pair[0] == b"database" || pair[0] == b"application_name" {
                        s.detail(
                            &String::from_utf8_lossy(pair[0]),
                            String::from_utf8_lossy(pair[1]),
                        );
                    }
                }
                let payload = b"SFATAL\0VFATAL\0C28000\0MAuthentication required\0\0";
                let mut response = vec![b'E'];
                response.extend_from_slice(&((payload.len() + 4) as u32).to_be_bytes());
                response.extend_from_slice(payload);
                return s.send(response).await;
            }
            _ => return Err(invalid("unsupported PostgreSQL startup")),
        }
    }
    Err(invalid("too many encryption requests"))
}

async fn mqtt(s: &mut Session) -> io::Result<()> {
    if s.read(1).await?[0] != 0x10 {
        return Err(invalid("expected MQTT CONNECT"));
    }
    let mut len = 0usize;
    let mut complete = false;
    for shift in [0, 7, 14, 21] {
        let byte = s.read(1).await?[0];
        len |= ((byte & 127) as usize) << shift;
        if byte & 128 == 0 {
            complete = true;
            break;
        }
    }
    if !complete {
        return Err(invalid("invalid MQTT remaining length"));
    }
    let body = s.read(len).await?;
    if body.len() < 7 {
        return Err(invalid("short MQTT CONNECT"));
    }
    let name_len = u16::from_be_bytes([body[0], body[1]]) as usize;
    let version_offset = 2 + name_len;
    let version = *body
        .get(version_offset)
        .ok_or_else(|| invalid("short MQTT protocol name"))?;
    if !matches!(
        (&body[2..version_offset], version),
        (b"MQTT", 4 | 5) | (b"MQIsdp", 3)
    ) {
        return Err(invalid("unsupported MQTT version"));
    }
    if body.len() < version_offset + 4 {
        return Err(invalid("short MQTT variable header"));
    }
    s.detail("version", version.to_string());
    if version == 5 {
        s.send([0x20, 3, 0, 0x87, 0]).await
    } else {
        s.send([0x20, 2, 0, 5]).await
    }
}

async fn ldap(s: &mut Session) -> io::Result<()> {
    if s.read(1).await?[0] != 0x30 {
        return Err(invalid("expected LDAP sequence"));
    }
    let first = s.read(1).await?[0];
    let len = if first < 128 {
        first as usize
    } else {
        let count = (first & 127) as usize;
        if count == 0 || count > 4 {
            return Err(invalid("invalid BER length"));
        }
        s.read(count)
            .await?
            .iter()
            .fold(0usize, |n, b| (n << 8) | *b as usize)
    };
    let body = s.read(len).await?;
    if body.len() < 4 || body[0] != 2 {
        return Err(invalid("invalid LDAP message ID"));
    }
    let id_len = body[1] as usize;
    if !(1..=4).contains(&id_len) || body.len() < id_len + 4 {
        return Err(invalid("invalid LDAP message ID"));
    }
    let op = body[id_len + 2];
    let (response_op, code) = match op {
        0x60 => (0x61, 49), // BindResponse: invalidCredentials.
        0x63 => (0x65, 50), // SearchResultDone: insufficientAccessRights.
        0x77 => (0x78, 53), // ExtendedResponse: unwillingToPerform.
        0x42 => return Ok(()),
        _ => return Err(invalid("unsupported LDAP operation")),
    };
    s.detail("operation", format!("0x{op:02x}"));
    let mut response = vec![0x30, (id_len + 11) as u8];
    response.extend_from_slice(&body[..id_len + 2]);
    response.extend_from_slice(&[response_op, 7, 10, 1, code, 4, 0, 4, 0]);
    s.send(response).await
}

async fn amqp(s: &mut Session) -> io::Result<()> {
    let header = s.read(8).await?;
    if header != b"AMQP\0\0\x09\x01" {
        return s.send(b"AMQP\0\0\x09\x01").await;
    }
    s.detail("version", "0-9-1");
    let mut start = vec![0, 10, 0, 10, 0, 9];
    start.extend_from_slice(&[0; 4]); // Empty server-properties table.
    for text in [b"PLAIN".as_slice(), b"en_US".as_slice()] {
        start.extend_from_slice(&(text.len() as u32).to_be_bytes());
        start.extend_from_slice(text);
    }
    amqp_frame(s, &start).await?;
    let frame = s.read(7).await?;
    let len = u32::from_be_bytes(frame[3..7].try_into().unwrap()) as usize;
    if frame[..3] != [1, 0, 0] || len < 4 {
        return Err(invalid("expected AMQP method frame"));
    }
    s.read(len).await?;
    if s.read(1).await?[0] != 0xce {
        return Err(invalid("invalid AMQP frame end"));
    }
    let mut close = vec![0, 10, 0, 50, 1, 147, 14]; // Connection.Close, 403.
    close.extend_from_slice(b"Access refused");
    close.extend_from_slice(&[0; 4]);
    amqp_frame(s, &close).await
}

async fn amqp_frame(s: &mut Session, body: &[u8]) -> io::Result<()> {
    let mut frame = vec![1, 0, 0];
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(body);
    frame.push(0xce);
    s.send(frame).await
}

async fn smb(s: &mut Session) -> io::Result<()> {
    let header = s.read(4).await?;
    if header[0] != 0 {
        return Err(invalid("expected SMB direct TCP frame"));
    }
    let len = u32::from_be_bytes([0, header[1], header[2], header[3]]) as usize;
    let request = s.read(len).await?;
    if request.len() < 64 || &request[..4] != b"\xfeSMB" || request[4..6] != [64, 0] {
        return Err(invalid("only SMB2 headers supported"));
    }
    let command = u16::from_le_bytes([request[12], request[13]]);
    s.detail("command", command.to_string());
    let mut response = vec![0; 64];
    response[..4].copy_from_slice(b"\xfeSMB");
    response[4] = 64;
    response[8..12].copy_from_slice(&0xc00000bbu32.to_le_bytes()); // STATUS_NOT_SUPPORTED.
    response[12..14].copy_from_slice(&request[12..14]);
    response[14] = 1;
    response[16] = 1; // SERVER_TO_REDIR.
    response[24..48].copy_from_slice(&request[24..48]);
    response.extend_from_slice(&[9, 0, 0, 0, 1, 0, 0, 0, 0]);
    let mut frame = (response.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(&response);
    s.send(frame).await
}
