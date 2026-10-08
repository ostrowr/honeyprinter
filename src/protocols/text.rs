use crate::session::{Session, invalid};
use std::{collections::BTreeMap, io};

pub async fn handle(protocol: &str, s: &mut Session) -> io::Result<()> {
    match protocol {
        "http" | "proxy" | "rtsp" | "sip" => request(protocol, s).await,
        "ssh" => {
            s.send("SSH-2.0-OpenSSH_9.6\r\n").await?;
            let banner = s.line().await?;
            if !banner.starts_with("SSH-") {
                return Err(invalid("invalid SSH banner"));
            }
            s.detail("client_banner", banner);
            Ok(())
        }
        "telnet" => {
            s.send(b"\xff\xfb\x01\xff\xfb\x03login: ").await?;
            s.line().await?;
            s.detail("action", "login attempt");
            s.send("\r\nLogin incorrect\r\n").await
        }
        "redis" => redis(s).await,
        _ => dialogue(protocol, s).await,
    }
}

async fn request(protocol: &str, s: &mut Session) -> io::Result<()> {
    let line = s.line().await?;
    let fields: Vec<_> = line.split_whitespace().collect();
    if fields.len() != 3 {
        return Err(invalid("invalid request line"));
    }
    let version = if protocol == "rtsp" {
        "RTSP/1.0"
    } else if protocol == "sip" {
        "SIP/2.0"
    } else {
        "HTTP/1.1"
    };
    if !fields[2].starts_with(version.split('/').next().unwrap()) {
        return Err(invalid("invalid request version"));
    }
    s.detail("method", fields[0]);
    // Query strings and URI userinfo may contain credentials. Retain only the path.
    let target = fields[1].split(['?', '#']).next().unwrap_or("");
    let path = if let Some((_, rest)) = target.split_once("://") {
        rest.find('/').map(|p| &rest[p..]).unwrap_or("/")
    } else if target.starts_with('/') || target == "*" {
        target
    } else {
        "[redacted authority]"
    };
    s.detail("path", path);
    let mut headers = BTreeMap::new();
    for _ in 0..64 {
        let line = s.line().await?;
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim().to_owned();
            if ["host", "user-agent", "cseq", "via", "from", "to", "call-id"]
                .contains(&name.as_str())
            {
                headers.insert(name, value);
            }
        }
    }
    for name in ["host", "user-agent"] {
        if let Some(value) = headers.get(name) {
            s.detail(name, value);
        }
    }
    let response = match protocol {
        "proxy" => "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"proxy\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned(),
        "rtsp" => format!("RTSP/1.0 401 Unauthorized\r\nCSeq: {}\r\nWWW-Authenticate: Basic realm=\"camera\"\r\nContent-Length: 0\r\n\r\n", headers.get("cseq").filter(|s| s.bytes().all(|b| b.is_ascii_digit())).map(String::as_str).unwrap_or("1")),
        "sip" => {
            let mut response = "SIP/2.0 501 Not Implemented\r\n".to_owned();
            for name in ["via", "from", "to", "call-id", "cseq"] {
                if let Some(value) = headers.get(name)
                    && value.bytes().all(|b| (32..127).contains(&b)) {
                    response.push_str(&format!("{name}: {value}\r\n"));
                }
            }
            response.push_str("Content-Length: 0\r\n\r\n");
            response
        }
        _ => {
            let body = "Not found\n";
            let suffix = if fields[0] == "HEAD" { "" } else { body };
            format!("HTTP/1.1 404 Not Found\r\nServer: nginx\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{suffix}", body.len())
        }
    };
    s.send(response).await
}

async fn dialogue(protocol: &str, s: &mut Session) -> io::Result<()> {
    let greeting = match protocol {
        "ftp" => "220 FTP server ready\r\n",
        "smtp" => "220 mail.local ESMTP ready\r\n",
        "pop3" => "+OK POP3 server ready\r\n",
        "imap" => "* OK IMAP4rev1 server ready\r\n",
        "irc" => ":irc.local NOTICE AUTH :Checking connection\r\n",
        "memcached" => "",
        _ => return Err(invalid("unknown text protocol")),
    };
    s.send(greeting).await?;
    let mut commands = Vec::new();
    for _ in 0..16 {
        let line = s.line().await?;
        let mut words = line.split_whitespace();
        let first = words.next().unwrap_or("");
        let tag = first;
        let command = if protocol == "imap" {
            words.next().unwrap_or("")
        } else {
            first
        }
        .to_ascii_uppercase();
        // Only command verbs enter logs; never PASS/AUTH/LOGIN arguments.
        commands.push(crate::session::clean(&command));
        s.detail("commands", commands.join(", "));
        if protocol == "imap"
            && (tag.len() > 64
                || !tag
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_'))
        {
            return Err(invalid("invalid IMAP tag"));
        }
        let response = match (protocol, command.as_str()) {
            ("ftp", "USER") => "331 Password required\r\n".to_owned(),
            ("ftp", "PASS") => "530 Login incorrect\r\n".to_owned(),
            ("ftp", "SYST") => "215 UNIX Type: L8\r\n".to_owned(),
            ("ftp", "FEAT") => "211 End\r\n".to_owned(),
            ("ftp", "QUIT") => "221 Goodbye\r\n".to_owned(),
            ("ftp", _) => "530 Please login\r\n".to_owned(),
            ("smtp", "EHLO") => "250-mail.local\r\n250 SIZE 0\r\n".to_owned(),
            ("smtp", "HELO") => "250 mail.local\r\n".to_owned(),
            ("smtp", "NOOP" | "RSET") => "250 OK\r\n".to_owned(),
            ("smtp", "QUIT") => "221 Bye\r\n".to_owned(),
            ("smtp", _) => "530 Authentication required\r\n".to_owned(),
            ("pop3", "CAPA") => "+OK Capabilities\r\nUSER\r\n.\r\n".to_owned(),
            ("pop3", "USER") => "+OK Send password\r\n".to_owned(),
            ("pop3", "QUIT") => "+OK Bye\r\n".to_owned(),
            ("pop3", _) => "-ERR Authentication failed\r\n".to_owned(),
            ("imap", "CAPABILITY") => {
                format!("* CAPABILITY IMAP4rev1\r\n{tag} OK CAPABILITY completed\r\n")
            }
            ("imap", "NOOP") => format!("{tag} OK NOOP completed\r\n"),
            ("imap", "LOGOUT") => format!("* BYE Logging out\r\n{tag} OK LOGOUT completed\r\n"),
            ("imap", _) => format!("{tag} NO Authentication required\r\n"),
            ("memcached", "VERSION") => "VERSION 1.6.22\r\n".to_owned(),
            ("memcached", "STATS" | "GET" | "GETS") => "END\r\n".to_owned(),
            ("memcached", "QUIT") => String::new(),
            ("memcached", _) => "ERROR\r\n".to_owned(),
            ("irc", _) => "ERROR :Connection refused\r\n".to_owned(),
            _ => return Err(invalid("unsupported command")),
        };
        s.send(response).await?;
        if matches!(
            command.as_str(),
            "QUIT" | "LOGOUT" | "PASS" | "AUTH" | "AUTHENTICATE" | "LOGIN"
        ) || protocol == "irc"
        {
            break;
        }
    }
    Ok(())
}

async fn redis(s: &mut Session) -> io::Result<()> {
    for _ in 0..16 {
        let line = s.line().await?;
        let command = if let Some(count) = line.strip_prefix('*') {
            let count = count
                .parse::<usize>()
                .map_err(|_| invalid("invalid RESP count"))?;
            if !(1..=32).contains(&count) {
                return Err(invalid("invalid RESP count"));
            }
            let mut first = String::new();
            for i in 0..count {
                let len = s.line().await?;
                let len = len
                    .strip_prefix('$')
                    .ok_or_else(|| invalid("expected RESP bulk string"))?
                    .parse::<usize>()
                    .map_err(|_| invalid("invalid RESP length"))?;
                let bytes = s.read(len).await?;
                if s.read(2).await? != b"\r\n" {
                    return Err(invalid("invalid RESP terminator"));
                }
                if i == 0 {
                    first = String::from_utf8_lossy(&bytes).to_ascii_uppercase();
                }
            }
            first
        } else {
            line.split_whitespace()
                .next()
                .unwrap_or("")
                .to_ascii_uppercase()
        };
        s.detail("command", &command);
        match command.as_str() {
            "PING" => s.send("+PONG\r\n").await?,
            "QUIT" => {
                s.send("+OK\r\n").await?;
                break;
            }
            _ => {
                s.send("-NOAUTH Authentication required.\r\n").await?;
                break;
            }
        }
    }
    Ok(())
}
