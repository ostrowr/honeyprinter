export interface Countdown {
  phase: 'connecting' | 'offline' | 'countdown' | 'preparing';
  label: string;
  value: string;
  seconds: number;
  progress: number;
}

// Driven by server time and the newest receipt, independent of history selection.
export function reportCountdown(now: number, latestMinute: number | undefined, connected: boolean): Countdown {
  if (!connected) return {phase: latestMinute === undefined ? 'connecting' : 'offline', label: latestMinute === undefined ? 'CONNECTING' : 'RECONNECTING', value: '—', seconds: 0, progress: 0};
  const minute = Math.floor(now / 60_000) * 60_000;
  if (latestMinute === undefined || latestMinute < minute) return {phase: 'preparing', label: 'NEXT REPORT', value: 'PREPARING', seconds: 0, progress: 1};
  const seconds = Math.max(1, Math.ceil((minute + 60_000 - now) / 1000));
  return {phase: 'countdown', label: 'NEXT REPORT', value: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`, seconds, progress: 1 - seconds / 60};
}
