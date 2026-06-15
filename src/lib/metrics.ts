import type { CollectionRun, DashboardMetrics, FlightLog, FlightOccurrence, Streak } from '../types';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const MINUTE_MS = 60000;

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return 'No data';
  const date = typeof value === 'string' ? parseDate(value) : value;
  if (!date) return 'No data';

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Indian/Maldives',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '0 minutes';

  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (days === 0 && minutes > 0) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);

  return parts.slice(0, 2).join(' ');
}

export function getWholeDays(ms: number): number {
  return Math.max(0, Math.floor(ms / DAY_MS));
}

function getEarliestDate(runs: CollectionRun[], logs: FlightLog[], occurrences: FlightOccurrence[]): Date | null {
  const dates = [
    ...runs.map((run) => parseDate(run.captured_at)),
    ...logs.map((log) => parseDate(log.captured_at)),
    ...occurrences.map((item) => parseDate(item.first_seen_at))
  ].filter(Boolean) as Date[];

  if (dates.length === 0) return null;
  return new Date(Math.min(...dates.map((date) => date.getTime())));
}

function getLastUpdated(runs: CollectionRun[], logs: FlightLog[]): Date | null {
  const dates = [
    ...runs.map((run) => parseDate(run.captured_at)),
    ...logs.map((log) => parseDate(log.captured_at))
  ].filter(Boolean) as Date[];

  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function calculateLongestStreak(dataStart: Date | null, delayedOccurrences: FlightOccurrence[], now: Date): Streak | null {
  if (!dataStart) return null;

  const events = delayedOccurrences
    .map((item) => parseDate(item.first_delayed_at))
    .filter(Boolean) as Date[];

  events.sort((a, b) => a.getTime() - b.getTime());

  if (events.length === 0) {
    return {
      from: dataStart,
      to: now,
      durationMs: now.getTime() - dataStart.getTime(),
      isCurrent: true
    };
  }

  const streaks: Streak[] = [];
  streaks.push({
    from: dataStart,
    to: events[0],
    durationMs: events[0].getTime() - dataStart.getTime(),
    isCurrent: false
  });

  for (let i = 0; i < events.length - 1; i += 1) {
    streaks.push({
      from: events[i],
      to: events[i + 1],
      durationMs: events[i + 1].getTime() - events[i].getTime(),
      isCurrent: false
    });
  }

  const lastEvent = events[events.length - 1];
  streaks.push({
    from: lastEvent,
    to: now,
    durationMs: now.getTime() - lastEvent.getTime(),
    isCurrent: true
  });

  return streaks.sort((a, b) => b.durationMs - a.durationMs)[0] ?? null;
}

export function relativeTime(value: Date | null | undefined): string {
  if (!value) return 'no data yet';
  const diff = Date.now() - value.getTime();
  if (diff < MINUTE_MS) return 'just now';
  if (diff < HOUR_MS) {
    const m = Math.floor(diff / MINUTE_MS);
    return `${m} min${m === 1 ? '' : 's'} ago`;
  }
  if (diff < DAY_MS) {
    const h = Math.floor(diff / HOUR_MS);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(diff / DAY_MS);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function maldivesDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Indian/Maldives',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

export type DailySeriesPoint = { date: string; count: number; minutes: number };

// Continuous daily delay series from the earliest record to today (gaps filled with 0),
// so the chart has a real time axis to zoom across. count = number of delayed flights,
// minutes = summed delay duration that day.
export function getDailyDelaySeries(occurrences: FlightOccurrence[], now = new Date()): DailySeriesPoint[] {
  const counts = new Map<string, number>();
  const minutes = new Map<string, number>();
  let earliest: Date | null = null;

  for (const item of occurrences) {
    const seen = parseDate(item.first_seen_at) ?? parseDate(item.scheduled_at);
    if (seen && (!earliest || seen < earliest)) earliest = seen;

    if (item.was_delayed && item.first_delayed_at) {
      const date = parseDate(item.first_delayed_at);
      if (date) {
        const key = maldivesDay(date);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        minutes.set(key, (minutes.get(key) ?? 0) + (item.max_delay_minutes || 0));
      }
    }
  }

  if (!earliest) return [];

  const points: DailySeriesPoint[] = [];
  const todayKey = maldivesDay(now);
  let cursor = new Date(earliest.getTime());
  // ponytail: 1000-day cap is a runaway guard; real data spans weeks.
  for (let i = 0; i < 1000; i += 1) {
    const key = maldivesDay(cursor);
    points.push({ date: key, count: counts.get(key) ?? 0, minutes: minutes.get(key) ?? 0 });
    if (key === todayKey) break;
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  return points;
}

export function computeMetrics(runs: CollectionRun[], logs: FlightLog[], occurrences: FlightOccurrence[]): DashboardMetrics {
  const now = new Date();
  const delayedOccurrences = occurrences.filter((item) => item.was_delayed && item.first_delayed_at);
  const dataStart = getEarliestDate(runs, logs, occurrences);
  const lastUpdated = getLastUpdated(runs, logs);

  const sortedDelayed = [...delayedOccurrences].sort((a, b) => {
    const aDate = parseDate(a.first_delayed_at)?.getTime() ?? 0;
    const bDate = parseDate(b.first_delayed_at)?.getTime() ?? 0;
    return bDate - aDate;
  });

  const lastDelay = sortedDelayed[0] ?? null;
  const lastDelayDate = parseDate(lastDelay?.first_delayed_at);

  const currentStreak = dataStart
    ? {
        from: lastDelayDate ?? dataStart,
        to: now,
        durationMs: now.getTime() - (lastDelayDate ?? dataStart).getTime(),
        isCurrent: true
      }
    : null;

  const since24Hours = now.getTime() - DAY_MS;
  const since7Days = now.getTime() - 7 * DAY_MS;

  const delayedLast24Hours = delayedOccurrences.filter((item) => {
    const date = parseDate(item.first_delayed_at);
    return date ? date.getTime() >= since24Hours : false;
  }).length;

  const delayedLast7Days = delayedOccurrences.filter((item) => {
    const date = parseDate(item.first_delayed_at);
    return date ? date.getTime() >= since7Days : false;
  }).length;

  const currentlyDelayed = logs.filter((log) => log.is_delayed).length;
  const totalDelayMinutes = delayedOccurrences.reduce((sum, item) => sum + (item.max_delay_minutes || 0), 0);

  return {
    dataStart,
    lastUpdated,
    lastDelay,
    totalDelayedFlights: delayedOccurrences.length,
    totalDelayMinutes,
    currentStreak,
    longestStreak: calculateLongestStreak(dataStart, delayedOccurrences, now),
    delayedLast24Hours,
    delayedLast7Days,
    currentlyDelayed
  };
}
