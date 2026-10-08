const $ = id => document.getElementById(id);
const api = `${location.pathname.replace(/\/$/, '')}/api`;
let eventCursor, receiptCursor, paused = false, connected = false;
let events = [], receipts = [], selectedReceipt;
const time = ms => new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
function node(tag, text, cls) { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; return el; }
function renderEvents() {
  if (!events.length) return;
  $('events').replaceChildren(...[...events].reverse().map(event => {
    const row = node('div', '', 'event');
    const stamp = node('div', ''); stamp.append(node('time', time(event.observed_at_ms)), node('small', event.source));
    const service = node('div', event.service.toUpperCase(), 'service'); service.append(node('small', `:${event.destination_port}${event.tls ? ' · TLS' : ''}`));
    row.append(stamp, service, node('div', event.outcome.replaceAll('_', ' '), 'outcome')); return row;
  }));
}
function renderReceipt() {
  if (!receipts.length) return;
  const index = Math.max(0, receipts.findIndex(r => r.id === selectedReceipt));
  const r = receipts[index]; selectedReceipt = r.id;
  const content = $('receipt-content');
  const total = node('div', '', 'totals'); total.append(node('span', 'CONNECTIONS'), node('strong', String(r.counts.probes)));
  const highlights = node('ul', ''); highlights.append(...r.summary.highlights.map(h => node('li', h)));
  content.replaceChildren(node('p', new Date(r.created_at_ms).toLocaleString(), 'receipt-time'), node('h3', r.summary.title), node('p', r.summary.body), highlights, total, node('p', `${r.summarizer === 'mock' ? 'MOCK SUMMARY' : r.summarizer.toUpperCase()} / #${r.last_event_id}`, 'receipt-time'));
  $('receipt-position').textContent = `${index + 1} / ${receipts.length}`;
  $('older').disabled = index === 0; $('newer').disabled = index === receipts.length - 1;
}
async function fetchFeed(name, after) {
  const response = await fetch(`${api}/${name}${after === undefined ? '' : `?after=${after}`}`, {cache: 'no-store', signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error('Feed unavailable');
  return response.json();
}
async function poll() {
  let delay = 5000;
  if (!paused) {
    try {
      const [eventPage, receiptPage] = await Promise.all([fetchFeed('events', eventCursor), fetchFeed('receipts', receiptCursor)]);
      const atLatest = !receipts.length || selectedReceipt === receipts.at(-1).id;
      events = [...events, ...eventPage.items].slice(-100); eventCursor = eventPage.cursor;
      receipts = [...receipts, ...receiptPage.items].slice(-100); receiptCursor = receiptPage.cursor;
      if (atLatest && receipts.length) selectedReceipt = receipts.at(-1).id;
      $('mode').textContent = eventPage.mode === 'mock' ? 'MOCK SUMMARIES' : 'AI SUMMARIES';
      connected = true; $('connection').textContent = `Live · checked ${time(Date.now())}`;
      $('connection-dot').classList.remove('offline'); renderEvents(); renderReceipt();
      // Drain busy feeds without waiting five seconds for every page of 100.
      if (eventPage.has_more || receiptPage.has_more) delay = 250;
    } catch {
      connected = false; $('connection').textContent = 'Connection interrupted · retrying shortly';
      $('connection-dot').classList.add('offline'); delay = 10000;
    }
  }
  setTimeout(poll, delay);
}
$('pause').addEventListener('click', () => {
  paused = !paused; $('pause').textContent = paused ? 'Resume feed' : 'Pause feed'; $('pause').setAttribute('aria-pressed', String(paused));
  $('connection').textContent = paused ? 'Feed paused' : connected ? 'Resuming live feed…' : 'Reconnecting…';
});
for (const [id, delta] of [['older', -1], ['newer', 1]]) $(id).addEventListener('click', () => {
  const i = receipts.findIndex(r => r.id === selectedReceipt); selectedReceipt = receipts[i + delta]?.id ?? selectedReceipt; renderReceipt();
});
poll();
