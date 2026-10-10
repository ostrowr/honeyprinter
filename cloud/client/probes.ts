import type {ProbeEvent} from '../shared/api.ts';
import {probeDetailLabels} from '../shared/probe.ts';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string) {
  const element = document.createElement(tag); element.textContent = text;
  if (className) element.className = className;
  return element;
}
const outcomeLabels: Record<string,string> = {
  completed:'Exchange completed', peer_closed:'Peer disconnected', timeout:'Timed out',
  invalid_input:'Unrecognized input', tls_error:'TLS handshake failed', io_error:'Connection error',
};
const stageLabels: Record<string,string> = {connected:'TCP connection',tls:'TLS handshake',application:'Application data'};
const label = (value: string) => value.replaceAll('_',' ');
const bytes = (value: number) => `${value.toLocaleString()} B`;
const duration = (value: number) => value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`;
const endpoint = (event: ProbeEvent) => `${event.source.includes(':') ? `[${event.source}]` : event.source}:${event.source_port}`;

export function probePreview(event: ProbeEvent): string {
  const d = event.details;
  if (d.method || d.path) return [d.method,d.path].filter(Boolean).join(' ');
  if (d.client_banner) return d.client_banner;
  if (d.commands || d.command) return d.commands || d.command!;
  if (d.action) return d.action;
  if (d.application_name) return d.application_name;
  if (d.encryption_request) return `${d.encryption_request} negotiation`;
  if (d.client_version) return d.client_version;
  if (d.error) return d.error;
  if (d.tls_version || d.sni) return [d.tls_version,d.sni].filter(Boolean).join(' · ');
  return event.stage === 'application' ? 'Application data received' : 'No application data received';
}

function probeRow(event: ProbeEvent): HTMLDetailsElement {
  const row = node('details','','event'); row.dataset.eventId = String(event.id);
  const summary = node('summary','','event-summary');
  const stamp = node('time',new Date(event.observed_at_ms).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}));
  stamp.dateTime = new Date(event.observed_at_ms).toISOString();
  stamp.title = new Date(event.observed_at_ms).toLocaleString();
  summary.append(node('span',`${event.service.toUpperCase()} :${event.destination_port}`,'event-service'),stamp,
    node('span',event.source,'event-source'),node('span',outcomeLabels[event.outcome] ?? label(event.outcome),'event-outcome'),
    node('span',probePreview(event),'event-preview'));
  const hint = node('span','Details','event-expand'); hint.setAttribute('aria-hidden','true'); summary.append(hint);
  const body = node('div','','event-body');
  const facts = node('dl','','event-facts');
  for (const [name,value] of [
    ['Source',endpoint(event)], ['Observed',new Date(event.observed_at_ms).toLocaleString()],
    ['Stage',stageLabels[event.stage] ?? label(event.stage)],
    ['Transport',event.tls ? event.stage === 'connected' ? 'TLS handshake not completed' : 'TLS over TCP' : 'TCP'],
    ['Duration',duration(event.duration_ms)], ['Received',bytes(event.bytes_in)], ['Sent',bytes(event.bytes_out)],
  ]) facts.append(node('dt',name),node('dd',value));
  body.append(facts);
  if (Object.keys(event.details).length) {
    body.append(node('h3','Protocol details','event-heading'));
    const metadata = node('dl','','event-metadata');
    for (const [key,name] of Object.entries(probeDetailLabels)) {
      const value = event.details[key as keyof typeof probeDetailLabels];
      if (value !== undefined) metadata.append(node('dt',name),node('dd',value));
    }
    body.append(metadata);
  } else body.append(node('p','No protocol details captured.','event-note'));
  body.append(node('p','Received and sent are measured at the honeypot.','event-note'));
  row.append(summary,body);
  return row;
}

export class ProbeLog {
  readonly element = node('section','','probe-log');
  private readonly list = node('div','','event-list');
  private readonly empty = node('p','Quiet on the wire. New connections appear here as they arrive.','empty');
  private readonly rows = new Map<number,HTMLDetailsElement>();

  constructor() {
    this.element.append(node('p','The latest 100 recorded connections. Open a probe for its exchange details. Excess traffic may be dropped.','drawer-note'),this.list,this.empty);
  }

  update(events: ProbeEvent[]) {
    // Reuse rows so polling does not close an expanded probe or steal focus.
    const panel = this.element.closest('dialog');
    const reading = panel && (panel.scrollTop > 0 || this.list.querySelector('details[open]'));
    const anchor = reading ? [...this.list.children].find(row => row.getBoundingClientRect().bottom > panel.getBoundingClientRect().top) : undefined;
    const anchorTop = anchor?.getBoundingClientRect().top;
    const ids = new Set(events.map(event => event.id));
    for (const [id,row] of this.rows) if (!ids.has(id)) { row.remove(); this.rows.delete(id); }
    [...events].reverse().forEach((event,index) => {
      let row = this.rows.get(event.id);
      if (!row) { row = probeRow(event); this.rows.set(event.id,row); }
      if (this.list.children[index] !== row) this.list.insertBefore(row,this.list.children[index] ?? null);
    });
    this.empty.hidden = events.length > 0;
    if (panel && anchor?.isConnected && anchorTop !== undefined) panel.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  }
}
