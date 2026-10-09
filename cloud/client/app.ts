import {ReceiptScene} from './scene.ts';
import {element} from './dom.ts';
import {activityPanel} from './activity.ts';
import type {Activity, Feed, FeedItems, PublicEvent, ReceiptRecord} from '../shared/api.ts';

const elements = {
  'scene': element('scene', 'canvas'),
  'machine-state': element('machine-state', 'span'),
  'open-activity': element('open-activity', 'button'),
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
let drawerView: 'receipt' | 'log' | 'about' | 'activity' | undefined;
let events: PublicEvent[] = [], receipts: ReceiptRecord[] = [], motionPaused = reducedMotion.matches;
let scene: ReceiptScene | undefined;
const feedState: Record<keyof FeedItems, 'connecting' | 'live' | 'offline'> = {events:'connecting', receipts:'connecting'};
let activity: Activity | undefined, activityLoading = false, activityFailed = false, activityAttempt = 0;

function updateConnection() {
  const live = feedState.events === 'live' && feedState.receipts === 'live';
  const offline = feedState.events === 'offline' || feedState.receipts === 'offline';
  $('connection').textContent = live ? 'Live feed' : offline ? 'Reconnecting' : 'Connecting';
  $('connection').title = live ? `Last checked ${time(Date.now())}` : 'Waiting for the live feed. Saved receipts remain available.';
  $('connection-dot').classList.toggle('offline', !live);
  scene?.setConnected(feedState.receipts === 'live');
}

async function loadActivity() {
  if (activityLoading || Date.now() - activityAttempt < (activityFailed ? 10_000 : 60_000)) return;
  activityLoading = true; activityAttempt = Date.now();
  try {
    const response = await fetch(`${api}/activity`, {cache:'no-store', signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('Activity unavailable');
    activity = await response.json() as Activity; activityFailed = false;
  } catch { activityFailed = true; }
  finally { activityLoading = false; if ($('drawer').open && drawerView === 'activity') renderDrawer(); }
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

try {
  scene = new ReceiptScene($('scene'), direction => {
    $('machine-state').textContent = direction < 0 ? 'Retracting' : direction > 0 ? 'Printing' : motionPaused ? 'Motion paused' : 'Standing by';
  });
} catch {
  $('scene-fallback').hidden = false;
  $('paper-hint').hidden = true;
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
  article.append(node('p', receipt.summarizer === 'quiet' ? 'Quiet minute · recorded observations' : receipt.summarizer === 'mock' ? 'Mock summary · recorded observations' : `Summary by ${receipt.summarizer}`, 'receipt-model'));
  return article;
}

function renderDrawer() {
  const body = $('drawer-body');
  if (drawerView === 'receipt') {
    $('drawer-title').textContent = 'On the paper';
    const receipt = currentReceipt();
    body.replaceChildren(receipt ? receiptText(receipt) : node('p', 'Paper loaded. The next minute report will arrive shortly.', 'empty'));
  } else if (drawerView === 'activity') {
    $('drawer-title').textContent = 'Last 24 hours';
    body.replaceChildren(activityPanel(activity, activityFailed));
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
    copy.append(node('p', 'Honeyprinter is a tiny honeypot with a lot of open ports. It greets incoming connections, records the exchange, and turns each minute into a receipt, including a short report when the wire is quiet.'));
    copy.append(node('span', 'The paper', 'label'), node('p', 'New receipts feed through the printer automatically. Drag the loose paper, retract to older receipts or advance with the arrows. The status light glows steadily between reports and flickers gently as the paper moves.'));
    copy.append(node('span', 'The real machine', 'label'), node('p', 'A Raspberry Pi will deliver the reports with traffic to a thermal printer. Quiet-minute reports appear here only.'));
    const link = node('a', 'Made by Robbie Ostrow ↗'); link.href = '/'; copy.append(link);
    body.replaceChildren(copy);
  }
}

for (const [id, view] of [['read-receipt', 'receipt'], ['open-log', 'log'], ['about', 'about'], ['open-activity', 'activity']] as const) {
  $(id).addEventListener('click', () => { drawerView = view; renderDrawer(); $('drawer').showModal(); if (view === 'activity') void loadActivity(); });
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
async function fetchFeed<K extends keyof FeedItems>(name: K, after?: number): Promise<Feed<FeedItems[K]>> {
  const response = await fetch(`${api}/${name}${after === undefined ? '' : `?after=${after}`}`, {cache: 'no-store', signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error('Feed unavailable');
  return response.json();
}

function receiveEvents(page: Feed<PublicEvent>) {
  const firstLoad = eventCursor === undefined;
  events = [...events, ...page.items].slice(-100); eventCursor = page.cursor;
  renderTelemetry(page.items.length > 0 && !firstLoad);
}

function receiveReceipts(page: Feed<ReceiptRecord>) {
  const atLatest = !receipts.length || selectedReceipt === receipts.at(-1)?.id;
  const firstLoad = receiptCursor === undefined;
  receipts = [...receipts, ...page.items].slice(-100); receiptCursor = page.cursor;
  $('mode').textContent = page.mode === 'mock' ? 'Mock summaries' : 'AI summaries';
  if ($('drawer').open && drawerView === 'activity') void loadActivity();
  if (page.items.length && (atLatest || !currentReceipt())) {
    if (firstLoad) {
      // Existing receipts are already printed. Only subsequent arrivals feed paper.
      const previous = receipts.at(-2);
      if (previous) scene?.showReceipt(previous, false);
    }
    const latest = receipts.at(-1);
    if (latest) selectReceipt(latest.id, !firstLoad);
  } else renderReceiptControls();
}

// Each feed renders as soon as it arrives and retries independently. A slow or
// unavailable connection log must never hold up the printer's first receipt.
async function poll<K extends keyof FeedItems>(name: K, cursor: () => number | undefined, receive: (page: Feed<FeedItems[K]>) => void) {
  let delay = 5000;
  try {
    const page = await fetchFeed(name, cursor());
    receive(page);
    feedState[name] = 'live';
    if (page.has_more) delay = 250;
  } catch {
    feedState[name] = 'offline';
    delay = 10000;
  }
  updateConnection();
  setTimeout(() => void poll(name, cursor, receive), delay);
}
void poll('events', () => eventCursor, receiveEvents);
void poll('receipts', () => receiptCursor, receiveReceipts);
