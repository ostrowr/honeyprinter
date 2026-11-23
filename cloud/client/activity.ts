import type {Activity} from '../shared/api.ts';

const number = (value: number) => value.toLocaleString();
const time = (ms: number) => new Date(ms).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string) {
  const element = document.createElement(tag); element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function activityPanel(activity: Activity | undefined, failed: boolean): HTMLElement {
  const panel = node('section', '', 'activity-panel');
  const contact = node('p', '', 'activity-contact');
  const email = node('a', 'robbie@ostro.ws'); email.href = 'mailto:robbie@ostro.ws';
  contact.append('contact ', email, ' for a full data dump');
  if (!activity?.generated_at_ms) {
    panel.append(node('p', failed ? 'Traffic totals are unavailable. We’ll try again shortly.' : activity ? 'The first daily tally is being prepared. Check back after the next report.' : 'Loading the last 24 hours…', 'empty'));
    panel.append(contact);
    return panel;
  }
  const stamp = new Date(activity.to_ms).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  panel.append(node('p', `24 hours through ${stamp}. Updated each minute.`, 'drawer-note'));
  if (failed) panel.append(node('p', 'Showing the last tally while we reconnect.', 'activity-warning'));
  const metrics = node('div', '', 'activity-totals');
  const ports = new Set(activity.ports.map(port => port.port)).size;
  for (const [label, value] of [['Probes', number(activity.probes)], ['Ports reached', number(ports)]]) {
    const metric = node('div', '', 'activity-metric'); metric.append(node('strong', value), node('span', label)); metrics.append(metric);
  }
  panel.append(metrics);
  panel.append(node('h3', 'Across the day', 'activity-heading'));
  const chart = node('div', '', 'hour-chart'), peak = Math.max(1, ...activity.hours.map(hour => hour.probes));
  chart.setAttribute('role', 'img'); chart.setAttribute('aria-label', `Hourly probes, oldest to newest: ${activity.hours.map(hour => `${time(hour.start_ms)}: ${number(hour.probes)}`).join('; ')}`);
  for (const hour of activity.hours) {
    const column = node('div', '', 'hour-column'); column.title = `${time(hour.start_ms)}–${time(hour.start_ms + 3_600_000)} · ${number(hour.probes)} probes`;
    const bar = node('span', '', hour.probes ? 'hour-bar' : 'hour-bar empty-hour');
    bar.style.height = `${Math.max(hour.probes ? 3 : 1, hour.probes / peak * 100)}%`;
    column.append(bar); chart.append(column);
  }
  const axis = node('div', '', 'hour-axis'); axis.append(node('span', '24h ago'), node('span', '12h ago'), node('span', 'Latest'));
  panel.append(chart, axis);
  panel.append(node('h3', 'Ports visited', 'activity-heading'));
  if (!activity.probes) panel.append(node('p', 'No probes recorded in this window. Quiet on every port.', 'empty'));
  else {
    const table = node('table', '', 'port-table');
    const head = document.createElement('thead'), heading = document.createElement('tr');
    for (const label of ['Port', 'Service', 'Probes']) { const cell = node('th', label); cell.scope = 'col'; heading.append(cell); }
    head.append(heading); table.append(head);
    const body = document.createElement('tbody'), max = activity.ports[0]?.probes || 1;
    for (const port of activity.ports) {
      const row = document.createElement('tr'); row.append(node('td', String(port.port), 'port-number'));
      const service = node('td', '', 'port-service'); service.append(node('span', port.service.toUpperCase()));
      const track = node('span', '', 'port-track'), fill = node('span', '', 'port-fill'); fill.style.width = `${port.probes / max * 100}%`; track.append(fill); service.append(track);
      row.append(service, node('td', number(port.probes), 'port-count')); body.append(row);
    }
    table.append(body); panel.append(table);
  }
  if (activity.outcomes.length) {
    panel.append(node('h3', 'Exchange outcomes', 'activity-heading'));
    const outcomes = node('dl', '', 'activity-outcomes');
    for (const outcome of activity.outcomes) outcomes.append(node('dt', outcome.outcome.replaceAll('_', ' ')), node('dd', number(outcome.probes)));
    panel.append(outcomes);
  }
  panel.append(node('p', 'Recorded probes only. Excess traffic may be dropped.', 'drawer-note activity-footnote'));
  panel.append(contact);
  return panel;
}
