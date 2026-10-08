// Wire types shared by the Worker, browser, and integration tests.
export interface Probe {
  schema_version: number; type: string; event_id: string; observed_at_ms: number;
  source_ip: string; source_port: number; destination_port: number;
  service: string; tls: boolean; stage: string; outcome: string;
  duration_ms: number; bytes_in: number; bytes_out: number;
  details: Record<string, string | number | boolean>;
}

export interface PublicEvent {
  id: number;
  received_at_ms: number;
  observed_at_ms: number;
  source: string;
  service: string;
  destination_port: number;
  tls: boolean;
  stage: string;
  outcome: string;
  bytes_in: number;
}

export interface Summary {
  title: string;
  body: string;
  highlights: string[];
}

export interface Counts {
  probes: number;
  sources: number;
  first_ms: number;
  last_ms: number;
  services: {service: string; count: number}[];
  outcomes: {outcome: string; count: number}[];
  samples: PublicEvent[];
}

export interface Receipt {
  schema_version: 1;
  type: 'receipt';
  receipt_id: string;
  created_at_ms: number;
  first_event_id: number;
  last_event_id: number;
  counts: Counts;
  summary: Summary;
  summarizer: string;
}

export interface ReceiptRecord extends Receipt {
  id: number;
}

export interface Feed<T> {
  items: T[];
  cursor: number;
  has_more: boolean;
  mode: string;
}

export interface FeedItems {
  events: PublicEvent;
  receipts: ReceiptRecord;
}
