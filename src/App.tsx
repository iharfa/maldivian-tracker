import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CalendarClock, Clock3, Plane, Radar, RefreshCcw, ShieldCheck, TimerReset } from 'lucide-react';
import logo from './assets/maldivian-logo.png';
import { hasSupabaseConfig, supabase } from './lib/supabase';
import { demoLogs, demoOccurrences, demoRuns } from './lib/demoData';
import { computeMetrics, formatDateTime, formatDuration, getDailyDelayCounts, getWholeDays } from './lib/metrics';
import type { CollectionRun, FlightLog, FlightOccurrence, Streak } from './types';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

type StatCardProps = {
  label: string;
  value: string | number;
  detail?: string;
  icon: React.ReactNode;
};

function StatCard({ label, value, detail, icon }: StatCardProps) {
  return (
    <section className="stat-card">
      <div className="stat-icon">{icon}</div>
      <div>
        <p className="eyebrow">{label}</p>
        <strong>{value}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
    </section>
  );
}

function StreakDates({ streak }: { streak: Streak | null }) {
  if (!streak) return <span>No streak data yet</span>;

  return (
    <span>
      {formatDateTime(streak.from)} to {streak.isCurrent ? 'now' : formatDateTime(streak.to)}
    </span>
  );
}

function StatusPill({ log }: { log: FlightLog }) {
  const className = log.is_delayed ? 'pill pill-delay' : log.is_cancelled ? 'pill pill-cancelled' : 'pill pill-clear';
  const label = log.is_delayed ? 'Delay' : log.is_cancelled ? 'Cancelled' : log.status || 'No status';

  return <span className={className}>{label}</span>;
}

function LastLogs({ logs }: { logs: FlightLog[] }) {
  if (logs.length === 0) {
    return <div className="empty-state">No Maldivian Airlines logs have been stored yet.</div>;
  }

  return (
    <div className="logs-list">
      {logs.map((log) => (
        <article className="log-row" key={`${log.id}-${log.captured_at}`}>
          <div>
            <strong>{log.flight_number}</strong>
            <span>{log.source === 'arrivals' ? 'Arrival' : 'Departure'} · {log.route || 'Route not listed'}</span>
          </div>
          <div>
            <small>Scheduled</small>
            <span>{log.scheduled_time_text || 'N/A'}</span>
          </div>
          <div>
            <small>Estimated</small>
            <span>{log.estimated_time_text || 'N/A'}</span>
          </div>
          <div>
            <small>Captured</small>
            <span>{formatDateTime(log.captured_at)}</span>
          </div>
          <div className="log-status">
            <StatusPill log={log} />
            <small>{log.delay_minutes ? `${log.delay_minutes} min` : '0 min'}</small>
          </div>
        </article>
      ))}
    </div>
  );
}

function DelayBars({ occurrences }: { occurrences: FlightOccurrence[] }) {
  const counts = getDailyDelayCounts(occurrences);
  const max = Math.max(1, ...counts.map((item) => item.count));

  if (counts.length === 0) {
    return <div className="empty-state">No delay events have been recorded yet.</div>;
  }

  return (
    <div className="bars" aria-label="Daily delay counts">
      {counts.map((item) => (
        <div className="bar-item" key={item.date}>
          <div className="bar-track">
            <div className="bar-fill" style={{ height: `${Math.max(8, (item.count / max) * 100)}%` }} />
          </div>
          <strong>{item.count}</strong>
          <span>{item.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [logs, setLogs] = useState<FlightLog[]>([]);
  const [runs, setRuns] = useState<CollectionRun[]>([]);
  const [occurrences, setOccurrences] = useState<FlightOccurrence[]>([]);
  const [state, setState] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setState('loading');
    setError(null);

    if (!hasSupabaseConfig || !supabase) {
      setLogs(demoLogs);
      setRuns(demoRuns);
      setOccurrences(demoOccurrences);
      setState('ready');
      return;
    }

    const [logsResult, runsResult, occurrencesResult] = await Promise.all([
      supabase
        .from('flight_logs')
        .select('*')
        .order('captured_at', { ascending: false })
        .limit(5),
      supabase
        .from('collection_runs')
        .select('*')
        .order('captured_at', { ascending: false })
        .limit(2000),
      supabase
        .from('flight_occurrences')
        .select('*')
        .order('first_delayed_at', { ascending: true, nullsFirst: false })
        .limit(5000)
    ]);

    if (logsResult.error || runsResult.error || occurrencesResult.error) {
      setState('error');
      setError(logsResult.error?.message || runsResult.error?.message || occurrencesResult.error?.message || 'Could not load dashboard data.');
      return;
    }

    setLogs((logsResult.data ?? []) as FlightLog[]);
    setRuns((runsResult.data ?? []) as CollectionRun[]);
    setOccurrences((occurrencesResult.data ?? []) as FlightOccurrence[]);
    setState('ready');
  }, []);

  useEffect(() => {
    void loadData();
    const interval = window.setInterval(() => void loadData(), 60000);
    return () => window.clearInterval(interval);
  }, [loadData]);

  const metrics = useMemo(() => computeMetrics(runs, logs, occurrences), [runs, logs, occurrences]);
  const counterDays = metrics.currentStreak ? getWholeDays(metrics.currentStreak.durationMs) : 0;
  const counterDetail = metrics.currentStreak ? formatDuration(metrics.currentStreak.durationMs) : 'Waiting for first snapshot';

  return (
    <main className="page-shell">
      <section className="hero-panel">
        <div className="sky-grid" />
        <header className="topbar">
          <div className="brand-lockup">
            <img src={logo} alt="Maldivian" />
            <div>
              <p className="eyebrow">Flight delay watch</p>
              <h1>Maldivian Delay Counter</h1>
            </div>
          </div>
          <button className="refresh-button" onClick={() => void loadData()} disabled={state === 'loading'}>
            <RefreshCcw size={16} />
            Refresh
          </button>
        </header>

        {!hasSupabaseConfig ? (
          <div className="config-warning">
            <AlertTriangle size={18} />
            Demo mode is active. Add Supabase environment variables to show live stored data.
          </div>
        ) : null}

        <div className="counter-wrap">
          <div className="runway-card">
            <div className="runway-line" />
            <Plane className="plane-icon" size={42} />
          </div>
          <div className="counter-card">
            <p className="eyebrow">Current streak</p>
            <div className="counter-number">{counterDays}</div>
            <h2>{counterDays === 1 ? 'day' : 'days'} without a recorded Maldivian delay</h2>
            <p>{counterDetail} since the last recorded delay event.</p>
            <div className="last-updated">
              <Clock3 size={16} />
              Last updated: {formatDateTime(metrics.lastUpdated)}
            </div>
          </div>
        </div>
      </section>

      {state === 'error' ? (
        <section className="error-panel">
          <AlertTriangle />
          <div>
            <strong>Dashboard failed to load</strong>
            <p>{error}</p>
          </div>
        </section>
      ) : null}

      <section className="stats-grid">
        <StatCard
          label="Delayed flights recorded"
          value={metrics.totalDelayedFlights}
          detail="Unique Maldivian flight occurrences since launch"
          icon={<Activity size={22} />}
        />
        <StatCard
          label="Longest clean streak"
          value={metrics.longestStreak ? formatDuration(metrics.longestStreak.durationMs) : 'No data'}
          detail={metrics.longestStreak ? `${formatDateTime(metrics.longestStreak.from)} to ${metrics.longestStreak.isCurrent ? 'now' : formatDateTime(metrics.longestStreak.to)}` : undefined}
          icon={<ShieldCheck size={22} />}
        />
        <StatCard
          label="Delays in last 24 hours"
          value={metrics.delayedLast24Hours}
          detail="Based on first detected delay time"
          icon={<Radar size={22} />}
        />
        <StatCard
          label="Delays in last 7 days"
          value={metrics.delayedLast7Days}
          detail={`${metrics.currentlyDelayed} delayed rows in latest logs`}
          icon={<CalendarClock size={22} />}
        />
      </section>

      <section className="content-grid">
        <article className="panel streak-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Streak record</p>
              <h3>Longest period without detected delays</h3>
            </div>
            <TimerReset size={24} />
          </div>
          <div className="streak-detail">
            <strong>{metrics.longestStreak ? formatDuration(metrics.longestStreak.durationMs) : 'No data yet'}</strong>
            <StreakDates streak={metrics.longestStreak} />
          </div>
          <div className="streak-detail muted">
            <strong>Current streak start</strong>
            <span>{metrics.currentStreak ? formatDateTime(metrics.currentStreak.from) : 'Waiting for data'}</span>
          </div>
          <div className="data-range">
            Data start: {formatDateTime(metrics.dataStart)}
          </div>
        </article>

        <article className="panel chart-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Delay pattern</p>
              <h3>Daily delay events</h3>
            </div>
            <span className="scope-chip">Last 14 active days</span>
          </div>
          <DelayBars occurrences={occurrences} />
        </article>
      </section>

      <section className="panel logs-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Latest data logs</p>
            <h3>Last 5 Maldivian Airlines records stored</h3>
          </div>
          <span className="scope-chip">5 minute collector</span>
        </div>
        <LastLogs logs={logs} />
      </section>

      <footer className="footer">
        <span>Data source: Velana International Airport FIS XML snapshots.</span>
        <span>Delay rule: status contains delay or estimated time is 15 minutes later than scheduled time.</span>
      </footer>
    </main>
  );
}

export default App;
