import type {ProbeDetails} from './probe.ts';

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

// Detailed events are separate from the compact samples stored on receipts.
export interface ProbeEvent extends PublicEvent {
  source_port: number;
  duration_ms: number;
  bytes_out: number;
  details: ProbeDetails;
}

export interface Summary {
  title: string;
  body: string;
  highlights: string[];
}

// Optional detail fields keep older queued receipts readable.
export interface ReceiptSample extends PublicEvent {
  source_port?: number;
  duration_ms?: number;
  bytes_out?: number;
  details?: ProbeDetails;
}

export interface Counts {
  probes: number;
  sources: number;
  first_ms: number;
  last_ms: number;
  services: {service: string; count: number}[];
  ports?: {port: number; service: string; count: number}[];
  outcomes: {outcome: string; count: number}[];
  samples: ReceiptSample[];
}

export interface Receipt {
  schema_version: 1;
  type: 'receipt';
  receipt_id: string;
  created_at_ms: number;
  scheduled_at_ms?: number;
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
  server_time_ms: number;
  items: T[];
  cursor: number;
  has_more: boolean;
  mode: string;
}

export interface FeedItems {
  events: ProbeEvent;
  receipts: ReceiptRecord;
}

export interface Activity {
  generated_at_ms: number;
  from_ms: number;
  to_ms: number;
  probes: number;
  ports: {port: number; service: string; probes: number}[];
  hours: {start_ms: number; probes: number}[];
  outcomes: {outcome: string; probes: number}[];
}
