// Only recognized protocol metadata is exposed in the connection log.
export const probeDetailLabels = {
  method: 'Method', path: 'Path', host: 'Host', 'user-agent': 'User agent',
  client_banner: 'Client banner', commands: 'Commands', command: 'Command',
  action: 'Action', sni: 'TLS server name', tls_version: 'TLS version',
  client_version: 'Client version', client_capabilities: 'Client capabilities',
  encryption_request: 'Encryption request', database: 'Database',
  application_name: 'Application', version: 'Protocol version', operation: 'Operation',
  error: 'Protocol error',
} as const;
export type ProbeDetails = Partial<Record<keyof typeof probeDetailLabels, string>>;
