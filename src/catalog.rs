use std::io;

#[derive(Clone, Copy, Debug)]
pub struct Service {
    pub name: &'static str,
    pub port: u16,
    pub handler: &'static str,
    pub tls: bool,
}

macro_rules! services {
    ($(($name:literal, $port:literal, $handler:literal, $tls:literal)),* $(,)?) => {
        pub const SERVICES: &[Service] = &[$(Service { name: $name, port: $port, handler: $handler, tls: $tls }),*];
    };
}

services! {
    ("ftp", 21, "ftp", false),
    ("ssh", 22, "ssh", false),
    ("telnet", 23, "telnet", false),
    ("smtp", 25, "smtp", false),
    ("http", 80, "http", false),
    ("pop3", 110, "pop3", false),
    ("imap", 143, "imap", false),
    ("ldap", 389, "ldap", false),
    ("https", 443, "http", true),
    ("smb", 445, "smb", false),
    ("smtps", 465, "smtp", true),
    ("rtsp", 554, "rtsp", false),
    ("submission", 587, "smtp", false),
    ("ldaps", 636, "ldap", true),
    ("imaps", 993, "imap", true),
    ("pop3s", 995, "pop3", true),
    ("mssql", 1433, "mssql", false),
    ("mqtt", 1883, "mqtt", false),
    ("docker", 2375, "http", false),
    ("http-proxy", 3128, "proxy", false),
    ("mysql", 3306, "mysql", false),
    ("rdp", 3389, "rdp", false),
    ("sip", 5060, "sip", false),
    ("postgres", 5432, "postgres", false),
    ("amqp", 5672, "amqp", false),
    ("vnc", 5900, "vnc", false),
    ("redis", 6379, "redis", false),
    ("irc", 6667, "irc", false),
    ("http-alt", 8080, "http", false),
    ("https-alt", 8443, "http", true),
    ("mqtts", 8883, "mqtt", true),
    ("elasticsearch", 9200, "http", false),
    ("memcached", 11211, "memcached", false),
    ("mongodb", 27017, "mongodb", false),
    ("socks5", 1080, "socks5", false),
}

pub fn select(spec: &str, offset: u16) -> io::Result<Vec<Service>> {
    let mut selected = Vec::new();
    for name in spec.split(',').map(str::trim) {
        if name == "all" {
            selected.extend_from_slice(SERVICES);
            continue;
        }
        let (name, port) = match name.split_once(':') {
            Some((name, port)) => (
                name,
                Some(
                    port.parse::<u16>()
                        .map_err(|_| io::Error::other("invalid port"))?,
                ),
            ),
            None => (name, None),
        };
        let mut service = *SERVICES
            .iter()
            .find(|s| s.name == name)
            .ok_or_else(|| io::Error::other(format!("unknown service: {name}; use --list")))?;
        if let Some(port) = port {
            service.port = port;
        }
        selected.push(service);
    }
    let mut ports = std::collections::HashSet::new();
    for service in &mut selected {
        service.port = service
            .port
            .checked_add(offset)
            .filter(|p| *p != 0)
            .ok_or_else(|| io::Error::other("port must be in 1..65535 after offset"))?;
        if !ports.insert(service.port) {
            return Err(io::Error::other(format!(
                "duplicate port: {}",
                service.port
            )));
        }
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ports_are_unique_and_checked() {
        assert_eq!(select("all", 10000).unwrap().len(), SERVICES.len());
        assert!(select("http:65535", 1).is_err());
        assert!(select("http:0", 0).is_err());
        assert!(select("http:8000,ssh:8000", 0).is_err());
        assert!(select("typo", 0).is_err());
    }
}
