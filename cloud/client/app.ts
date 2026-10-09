import {ReceiptScene} from './scene.ts';
import {element} from './dom.ts';
import type {Feed, FeedItems, PublicEvent, ReceiptRecord} from '../shared/api.ts';

const elements = {
  'scene': element('scene', 'canvas'),
  'machine-state': element('machine-state', 'span'),
  'feed': element('feed', 'button'),
  'scene-fallback': element('scene-fallback', 'div'),
  'paper-hint': element('paper-hint', 'div'),
  'motion': element('motion', 'button'),
  'print-status': element('print-status', 'div'),
  'drawer': element('drawer', 'dialog'),
  'receipt-position': element('receipt-position', 'span'),
  'receipt-date': element('receipt-date', 'span'),
  'older': element('older', 'button'),
  'newer': element('newer', 'button'),
  'last-service': element('last-service', 'div'),
  'last-source': element('last-source', 'span'),
  'last-time': element('last-time', 'time'),
  'event-count': element('event-count', 'span'),
  'drawer-body': element('drawer-body', 'div'),
  'drawer-title': element('drawer-title', 'h2'),
  'close-drawer': element('close-drawer', 'button'),
  'mode': element('mode', 'span'),
  'connection': element('connection', 'span'),
  'connection-dot': element('connection-dot', 'span'),
  'read-receipt': element('read-receipt', 'button'),
  'open-log': element('open-log', 'button'),
  'about': element('about', 'button'),
};
const $ = <K extends keyof typeof elements>(id: K): (typeof elements)[K] => elements[id];
const api = `${location.pathname.replace(/\/$/, '')}/api`;
const time = (ms: number) => new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
const date = (ms: number) => new Date(ms).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let eventCursor: number | undefined, receiptCursor: number | undefined, selectedReceipt: number | undefined;
let drawerView: 'receipt' | 'log' | 'about' | undefined;
let events: PublicEvent[] = [], receipts: ReceiptRecord[] = [], motionPaused = reducedMotion.matches;
let scene: ReceiptScene | undefined;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

try {
  scene = new ReceiptScene($('scene'), direction => {
    $('machine-state').textContent = direction < 0 ? 'Retracting' : direction > 0 ? 'Printing' : motionPaused ? 'Motion paused' : 'Standing by';
    $('feed').setAttribute('aria-label', direction > 0 ? 'Feed paper again' : 'Feed paper');
  });
} catch {
  $('scene-fallback').hidden = false;
  $('paper-hint').hidden = true;
  $('feed').disabled = true;
  $('motion').disabled = true;
}

function setMotion(paused: boolean) {
  motionPaused = paused;
  scene?.setPaused(paused);
  $('motion').replaceChildren(document.createTextNode(paused ? 'Resume motion ' : 'Pause motion '), node('span', paused ? '▷' : 'Ⅱ'));
  $('motion').setAttribute('aria-pressed', String(paused));
  $('machine-state').textContent = paused ? 'Motion paused' : 'Standing by';
  $('paper-hint').hidden = paused || !scene;
}
setMotion(motionPaused);
reducedMotion.addEventListener('change', event => setMotion(event.matches));
$('motion').addEventListener('click', () => setMotion(!motionPaused));

function currentReceipt() { return receipts.find(receipt => receipt.id === selectedReceipt); }

function selectReceipt(id: number, animate = true) {
  const receipt = receipts.find(item => item.id === id);
  if (!receipt) return;
  const direction = selectedReceipt !== undefined && id < selectedReceipt ? -1 : 1;
  selectedReceipt = id;
  scene?.showReceipt(receipt, animate, direction);
  renderReceiptControls();
  $('print-status').textContent = `Receipt ${receipt.id}. ${receipt.summary.body}`;
  if ($('drawer').open && drawerView === 'receipt') renderDrawer();
}

function renderReceiptControls() {
  const receipt = currentReceipt();
  if (!receipt) return;
  const index = receipts.indexOf(receipt);
  $('receipt-position').textContent = `RECEIPT ${String(receipt.id).padStart(4, '0')}`;
  $('receipt-date').textContent = date(receipt.created_at_ms);
  $('older').disabled = index === 0;
  $('newer').disabled = index === receipts.length - 1;
}

function renderTelemetry(fresh: boolean) {
  const event = events.at(-1);
  if (!event) return;
  $('last-service').replaceChildren(document.createTextNode(event.service.toUpperCase()), node('span', `:${event.destination_port}`, 'port'));
  $('last-source').textContent = event.source;
  $('last-time').textContent = time(event.observed_at_ms);
  $('last-time').dateTime = new Date(event.observed_at_ms).toISOString();
  $('event-count').textContent = events.length === 100 ? '100+' : String(events.length).padStart(2, '0');
  if (fresh) {
    const telemetry = document.querySelector('.telemetry');
    telemetry?.classList.remove('pulse');
    requestAnimationFrame(() => telemetry?.classList.add('pulse'));
  }
  if ($('drawer').open && drawerView === 'log') renderDrawer();
}

function receiptText(receipt: ReceiptRecord) {
  const article = node('article', '', 'drawer-receipt');
  article.append(node('h3', 'HONEYPRINTER'), node('div', `RECEIPT ${String(receipt.id).padStart(4, '0')} / ${date(receipt.created_at_ms)}`, 'receipt-meta'));
  const row = (label: string, value: number, total = false) => {
    const item = node('div', '', total ? 'receipt-line receipt-total' : 'receipt-line');
    item.append(node('span', label), node('span', String(value)));
    return item;
  };
  for (const service of receipt.counts.services) article.append(row(service.service.toUpperCase(), service.count));
  article.append(row('CONNECTIONS', receipt.counts.probes, true), row('SOURCES', receipt.counts.sources));
  article.append(node('p', receipt.summary.body, 'receipt-summary'));
  for (const highlight of receipt.summary.highlights) article.append(node('p', highlight));
  article.append(node('p', receipt.summarizer === 'mock' ? 'Mock summary · recorded observations' : `Summary by ${receipt.summarizer}`, 'receipt-model'));
  return article;
}

function renderDrawer() {
  const body = $('drawer-body');
  if (drawerView === 'receipt') {
    $('drawer-title').textContent = 'On the paper';
    const receipt = currentReceipt();
    body.replaceChildren(receipt ? receiptText(receipt) : node('p', 'Paper loaded. The first receipt will arrive after a connection is recorded.', 'empty'));
  } else if (drawerView === 'log') {
    $('drawer-title').textContent = 'Connection log';
    const note = node('p', 'The latest 100 recorded connections. Excess traffic may be dropped.', 'drawer-note');
    const rows = [...events].reverse().map(event => {
      const row = node('div', '', 'event');
      row.append(node('span', `${event.service.toUpperCase()} :${event.destination_port}${event.tls ? ' / TLS' : ''}`), node('time', time(event.observed_at_ms)), node('small', event.source), node('span', event.outcome.replaceAll('_', ' '), 'outcome'));
      return row;
    });
    body.replaceChildren(note, ...(rows.length ? rows : [node('p', 'Quiet on the wire. New connections appear here as they arrive.', 'empty')]));
  } else {
    $('drawer-title').textContent = 'A small internet appliance';
    const copy = node('div', '', 'drawer-copy');
    copy.append(node('p', 'Honeyprinter is a tiny honeypot with a lot of open ports. It greets incoming connections, records the exchange, and turns each active minute into a receipt.'));
    copy.append(node('span', 'The paper', 'label'), node('p', 'New receipts feed through the printer automatically. Drag the loose paper, retract to older receipts or advance with the arrows, or press Feed paper to replay the current one. Replaying here does not send a physical print.'));
    copy.append(node('span', 'The real machine', 'label'), node('p', 'A Raspberry Pi will deliver the same receipts to a thermal printer. Until then, this is its digital counterpart.'));
    const link = node('a', 'Made by Robbie Ostrow ↗'); link.href = '/'; copy.append(link);
    body.replaceChildren(copy);
  }
}

for (const [id, view] of [['read-receipt', 'receipt'], ['open-log', 'log'], ['about', 'about']] as const) {
  $(id).addEventListener('click', () => { drawerView = view; renderDrawer(); $('drawer').showModal(); });
}
$('close-drawer').addEventListener('click', () => $('drawer').close());
$('drawer').addEventListener('click', event => {
  const rect = $('drawer').getBoundingClientRect();
  if (event.target === $('drawer') && (event.clientX < rect.left || event.clientX > rect.right)) $('drawer').close();
});
for (const [id, delta] of [['older', -1], ['newer', 1]] as const) $(id).addEventListener('click', () => {
  const index = receipts.findIndex(receipt => receipt.id === selectedReceipt);
  const next = receipts[index + delta];
  if (next) selectReceipt(next.id);
});
$('feed').addEventListener('click', () => {
  scene?.feed();
  $('print-status').textContent = currentReceipt() ? `${motionPaused ? 'Showing' : 'Replaying'} receipt ${selectedReceipt}. No physical print is sent.` : 'Paper loaded. Waiting for the first receipt.';
});

async function fetchFeed<K extends keyof FeedItems>(name: K, after?: number): Promise<Feed<FeedItems[K]>> {
  const response = await fetch(`${api}/${name}${after === undefined ? '' : `?after=${after}`}`, {cache: 'no-store', signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error('Feed unavailable');
  return response.json();
}

async function poll() {
  let delay = 5000;
  try {
    const [eventPage, receiptPage] = await Promise.all([fetchFeed('events', eventCursor), fetchFeed('receipts', receiptCursor)]);
    const atLatest = !receipts.length || selectedReceipt === receipts.at(-1)?.id;
    const firstLoad = receiptCursor === undefined;
    events = [...events, ...eventPage.items].slice(-100); eventCursor = eventPage.cursor;
    receipts = [...receipts, ...receiptPage.items].slice(-100); receiptCursor = receiptPage.cursor;
    $('mode').textContent = receiptPage.mode === 'mock' ? 'Mock summaries' : 'AI summaries';
    $('connection').textContent = 'Live feed';
    $('connection').title = `Last checked ${time(Date.now())}`;
    $('connection-dot').classList.remove('offline');
    renderTelemetry(eventPage.items.length > 0 && !firstLoad);
    if (receiptPage.items.length && (atLatest || !currentReceipt())) {
      if (firstLoad) {
        // Put the preceding receipt on the back of the strip, then print the latest.
        const previous = receipts.at(-2);
        if (previous) scene?.showReceipt(previous, false);
      }
      const latest = receipts.at(-1);
      if (latest) selectReceipt(latest.id);
    } else renderReceiptControls();
    if (eventPage.has_more || receiptPage.has_more) delay = 250;
  } catch {
    $('connection').textContent = 'Reconnecting';
    $('connection').title = 'The feed is unavailable. Retrying shortly.';
    $('connection-dot').classList.add('offline');
    delay = 10000;
  }
  setTimeout(poll, delay);
}
poll();
