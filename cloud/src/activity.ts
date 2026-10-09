import type {Activity} from '../shared/api.ts';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
export function emptyActivity(now: number): Activity {
  // Exactly 24 completed hours, to minute precision. The current partial minute
  // joins the next snapshot; the UI labels the snapshot's end explicitly.
  const to = Math.floor(now / MINUTE) * MINUTE, from = to - DAY;
  return {generated_at_ms: 0, from_ms: from, to_ms: to, probes: 0, ports: [], outcomes: [],
    hours: Array.from({length: 24}, (_, i) => ({start_ms: from + i * HOUR, probes: 0}))};
}

export async function refreshActivity(db: D1Database, now: number, token: string): Promise<void> {
  const activity = emptyActivity(now);
  const rows = (await db.prepare('SELECT minute_ms, port, service, outcome, probes FROM activity_minutes WHERE minute_ms >= ? AND minute_ms < ?')
    .bind(activity.from_ms, activity.to_ms).all<{minute_ms: number; port: number; service: string; outcome: string; probes: number}>()).results;
  const ports = new Map<string, Activity['ports'][number]>(), outcomes = new Map<string, number>();
  for (const row of rows) {
    activity.probes += row.probes;
    activity.hours[Math.floor((row.minute_ms - activity.from_ms) / HOUR)].probes += row.probes;
    const key = `${row.port}/${row.service}`, port = ports.get(key) ?? {port: row.port, service: row.service, probes: 0};
    port.probes += row.probes; ports.set(key, port);
    outcomes.set(row.outcome, (outcomes.get(row.outcome) ?? 0) + row.probes);
  }
  activity.ports = [...ports.values()].sort((a, b) => b.probes - a.probes || a.port - b.port || a.service.localeCompare(b.service));
  activity.outcomes = [...outcomes].map(([outcome, probes]) => ({outcome, probes})).sort((a, b) => b.probes - a.probes || a.outcome.localeCompare(b.outcome));
  activity.generated_at_ms = now;
  await db.batch([
    db.prepare('UPDATE summary_state SET activity_json = ? WHERE id = 1 AND lease_token = ?').bind(JSON.stringify(activity), token),
    db.prepare('DELETE FROM activity_minutes WHERE minute_ms < ? AND EXISTS (SELECT 1 FROM summary_state WHERE id = 1 AND lease_token = ?)').bind(activity.from_ms, token),
  ]);
}

export async function readActivity(db: D1Database): Promise<Activity> {
  const row = await db.prepare('SELECT activity_json FROM summary_state WHERE id = 1').first<{activity_json: string | null}>();
  return row?.activity_json ? JSON.parse(row.activity_json) as Activity : emptyActivity(Date.now());
}
