import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, CalendarClock, Hourglass, RefreshCcw, ShieldCheck } from 'lucide-react';
import { Analytics } from '@vercel/analytics/react';
import * as echarts from 'echarts';
import logo from './assets/maldivian-logo.png';
import { hasSupabaseConfig, supabase } from './lib/supabase';
import { demoLogs, demoOccurrences, demoRuns } from './lib/demoData';
import {
  computeMetrics,
  formatDateTime,
  formatDuration,
  getDailyDelaySeries,
  getWholeDays,
  parseDate,
  relativeTime
} from './lib/metrics';
import type { CollectionRun, FlightLog, FlightOccurrence, SourceType } from './types';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

// Single FIS feed is always to/from Velana (MLE), so the pair is derived from direction.
function routeLabel(item: { source: SourceType; route: string | null }): string {
  const other = item.route || '—';
  return item.source === 'arrivals' ? `${other} → MLE` : `MLE → ${other}`;
}

// WebGL radar-sweep backdrop for the hero (ported from the Stitch design).
function ShaderBackground() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const syncSize = () => {
      const w = canvas.clientWidth || 1280;
      const h = canvas.clientHeight || 720;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncSize) : null;
    ro?.observe(canvas);
    syncSize();

    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return () => ro?.disconnect();

    const vs = `attribute vec2 a_position; varying vec2 v_texCoord;
      void main(){ v_texCoord = a_position*0.5+0.5; gl_Position = vec4(a_position,0.0,1.0); }`;
    const fs = `precision highp float; varying vec2 v_texCoord;
      uniform float u_time; uniform vec2 u_resolution;
      void main(){
        vec2 uv = (gl_FragCoord.xy / u_resolution.xy) - 0.5;
        uv.x *= u_resolution.x / u_resolution.y;
        float angle = atan(uv.y, uv.x);
        float dist = length(uv);
        float sweep = mod(angle - u_time * 1.5, 6.28318);
        float blip1 = smoothstep(0.02,0.0,length(uv - vec2(0.3*cos(u_time*0.2), 0.2*sin(u_time*0.3))));
        float blip2 = smoothstep(0.015,0.0,length(uv - vec2(-0.25*sin(u_time*0.4), -0.15*cos(u_time*0.25))));
        vec3 color = vec3(0.004,0.047,0.11);
        color += vec3(0.0,0.639,0.878) * exp(-sweep*1.0) * 0.15;
        color += vec3(0.886,0.094,0.2) * blip1 * (sin(u_time*5.0)*0.5+0.5);
        color += vec3(0.0,0.639,0.878) * blip2 * (cos(u_time*4.0)*0.5+0.5);
        float circles = abs(sin(dist*20.0));
        color += vec3(0.0,0.639,0.878) * smoothstep(0.98,1.0,circles) * 0.05;
        gl_FragColor = vec4(color, 0.4);
      }`;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(prog, 'a_position');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uRes = gl.getUniformLocation(prog, 'u_resolution');

    let raf = 0;
    const render = (t: number) => {
      if (!ro) syncSize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(uTime, t * 0.001);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="block w-full h-full" />;
}

function MetricCard({
  label,
  value,
  detail,
  icon,
  valueClassName = 'font-metric-value text-metric-value'
}: {
  label: string;
  value: string | number;
  detail?: string;
  icon: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="glass-panel p-lg rounded-xl scanning-line transition-all group hover:bg-white/10 hover:scale-105 flex flex-col">
      <div className="flex justify-between items-start mb-md">
        <div className="font-data-label text-data-label text-on-surface-variant uppercase">{label}</div>
        {icon}
      </div>
      <div className={`${valueClassName} text-on-surface group-hover:text-primary transition-colors flex-1 flex items-center`}>
        {value}
      </div>
      {detail ? <div className="text-data-label text-on-surface-variant mt-xs">{detail}</div> : null}
    </div>
  );
}

function DelayTrend({ occurrences }: { occurrences: FlightOccurrence[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const series = useMemo(() => getDailyDelaySeries(occurrences), [occurrences]);

  useEffect(() => {
    if (!ref.current || series.length === 0) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    // With many days, default the zoom window to the most recent ~30.
    const zoomStart = series.length > 30 ? ((series.length - 30) / series.length) * 100 : 0;

    chart.setOption({
      backgroundColor: 'transparent',
      grid: { top: 48, right: 48, bottom: 64, left: 40 },
      legend: {
        data: ['Flights operated', 'Delayed flights', 'Hours delayed'],
        right: 0,
        top: 0,
        icon: 'roundRect',
        textStyle: { color: '#c0c7d2', fontFamily: 'JetBrains Mono', fontSize: 11 },
        inactiveColor: '#5a6275'
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#171f33',
        borderColor: 'rgba(255,255,255,0.1)',
        textStyle: { color: '#dae2fd' },
        formatter: (params: { axisValueLabel: string; marker: string; seriesName: string; value: number }[]) => {
          const lines = params.map((p) => {
            const unit = p.seriesName === 'Hours delayed' ? ' h' : p.value === 1 ? ' flight' : ' flights';
            return `${p.marker}${p.seriesName}: ${p.value}${unit}`;
          });
          return [params[0].axisValueLabel, ...lines].join('<br/>');
        }
      },
      xAxis: {
        type: 'category',
        data: series.map((d) => d.date),
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.2)' } },
        axisLabel: { color: '#c0c7d2', fontFamily: 'JetBrains Mono', fontSize: 11 }
      },
      yAxis: [
        {
          type: 'value',
          minInterval: 1,
          name: 'Flights',
          nameTextStyle: { color: '#81cfff', fontFamily: 'JetBrains Mono', fontSize: 11 },
          axisLabel: { color: '#c0c7d2', fontFamily: 'JetBrains Mono', fontSize: 11 },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } }
        },
        {
          type: 'value',
          name: 'Hours',
          position: 'right',
          nameTextStyle: { color: '#ffb77f', fontFamily: 'JetBrains Mono', fontSize: 11 },
          axisLabel: { color: '#c0c7d2', fontFamily: 'JetBrains Mono', fontSize: 11 },
          splitLine: { show: false }
        }
      ],
      dataZoom: [
        { type: 'inside', start: zoomStart, end: 100 },
        {
          type: 'slider',
          start: zoomStart,
          end: 100,
          height: 22,
          bottom: 8,
          borderColor: 'rgba(255,255,255,0.1)',
          fillerColor: 'rgba(154,203,255,0.15)',
          handleStyle: { color: '#9acbff' },
          textStyle: { color: '#c0c7d2', fontFamily: 'JetBrains Mono', fontSize: 10 }
        }
      ],
      series: [
        {
          name: 'Flights operated',
          type: 'bar',
          yAxisIndex: 0,
          z: 1,
          data: series.map((d) => d.total),
          itemStyle: { color: 'rgba(154,203,255,0.18)', borderRadius: [3, 3, 0, 0] },
          emphasis: { itemStyle: { color: 'rgba(154,203,255,0.3)' } }
        },
        {
          name: 'Delayed flights',
          type: 'bar',
          yAxisIndex: 0,
          z: 2,
          barGap: '-100%',
          data: series.map((d) => d.count),
          itemStyle: { color: '#81cfff', borderRadius: [3, 3, 0, 0] },
          emphasis: { itemStyle: { color: '#9acbff' } }
        },
        {
          name: 'Hours delayed',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          data: series.map((d) => Math.round((d.minutes / 60) * 10) / 10),
          lineStyle: { color: '#ffb77f', width: 2 },
          itemStyle: { color: '#ffb77f' }
        }
      ]
    });

    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
  }, [series]);

  return (
    <div className="lg:col-span-12 glass-panel p-lg rounded-xl mb-gutter">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-lg gap-sm">
        <div>
          <h2 className="font-headline-lg text-headline-lg text-on-surface">Delay Trend</h2>
          <p className="font-data-label text-data-label text-on-surface-variant mt-xs uppercase">
            Delayed vs operated flights per day · toggle metrics top-right · drag the slider to pick a range
          </p>
        </div>
      </div>
      {series.length > 0 ? (
        <div ref={ref} style={{ height: 340 }} />
      ) : (
        <div className="py-xl text-center text-on-surface-variant">No delay events recorded yet.</div>
      )}
    </div>
  );
}

function StatusCell({ log }: { log: FlightLog }) {
  if (log.is_cancelled) {
    return (
      <span className="px-xs py-1 rounded bg-error-container border border-error/50 text-error text-[10px] font-bold uppercase tracking-wider critical-glow">
        Cancelled
      </span>
    );
  }
  if (log.is_delayed) {
    return (
      <span className="px-xs py-1 rounded bg-error text-on-error-container text-[10px] font-bold uppercase tracking-wider">
        Delayed
      </span>
    );
  }
  return (
    <span className="px-xs py-1 rounded bg-secondary-container text-on-primary-container text-[10px] font-bold uppercase tracking-wider">
      On Time
    </span>
  );
}

function durationLabel(log: FlightLog): string {
  if (log.is_cancelled) return 'N/A';
  if (log.delay_minutes && log.delay_minutes > 0) return `+${log.delay_minutes}m`;
  return '--';
}

function OperationsLog({ logs }: { logs: FlightLog[] }) {
  return (
    <div className="lg:col-span-12 glass-panel rounded-xl overflow-hidden">
      <div className="p-lg border-b border-white/10 flex justify-between items-center bg-white/5">
        <h3 className="font-headline-lg text-headline-lg text-on-surface">Live Operations Log</h3>
        <span className="font-data-label text-data-label text-primary uppercase">MLE Terminal FIS</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="font-data-label text-data-label text-on-surface-variant bg-surface-container-high/50 border-b border-white/5 uppercase">
              <th className="px-lg py-md">Flight #</th>
              <th className="px-lg py-md">Route</th>
              <th className="px-lg py-md">Scheduled</th>
              <th className="px-lg py-md">Estimated</th>
              <th className="px-lg py-md">Status</th>
              <th className="px-lg py-md">Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {logs.length === 0 ? (
              <tr>
                <td className="px-lg py-md text-on-surface-variant italic" colSpan={6}>
                  No Maldivian Airlines records stored yet.
                </td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr className="hover:bg-white/5 transition-colors group" key={`${log.id}-${log.captured_at}`}>
                  <td className="px-lg py-md font-data-label font-bold text-on-surface group-hover:text-primary">
                    {log.flight_number}
                  </td>
                  <td className="px-lg py-md font-body-md text-on-surface">{routeLabel(log)}</td>
                  <td className="px-lg py-md font-data-label">{log.scheduled_time_text || '--:--'}</td>
                  <td className="px-lg py-md font-data-label">{log.estimated_time_text || '--:--'}</td>
                  <td className="px-lg py-md">
                    <StatusCell log={log} />
                  </td>
                  <td
                    className={`px-lg py-md font-data-label ${log.is_delayed || log.is_cancelled ? 'text-error' : 'text-secondary-fixed'}`}
                  >
                    {durationLabel(log)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LastDelayed({ occurrences }: { occurrences: FlightOccurrence[] }) {
  const rows = useMemo(
    () =>
      occurrences
        .filter((o) => o.was_delayed && o.first_delayed_at)
        .sort(
          (a, b) => (parseDate(b.first_delayed_at)?.getTime() ?? 0) - (parseDate(a.first_delayed_at)?.getTime() ?? 0)
        )
        .slice(0, 5),
    [occurrences]
  );

  return (
    <div className="lg:col-span-12 glass-panel rounded-xl overflow-hidden">
      <div className="p-lg border-b border-white/10 flex justify-between items-center bg-white/5">
        <h3 className="font-headline-lg text-headline-lg text-on-surface">Last 5 Delayed Flights</h3>
        <span className="font-data-label text-data-label text-error uppercase">Most recent delays</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="font-data-label text-data-label text-on-surface-variant bg-surface-container-high/50 border-b border-white/5 uppercase">
              <th className="px-lg py-md">Flight #</th>
              <th className="px-lg py-md">Route</th>
              <th className="px-lg py-md">First detected delayed</th>
              <th className="px-lg py-md">Delayed by</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.length === 0 ? (
              <tr>
                <td className="px-lg py-md text-on-surface-variant italic" colSpan={4}>
                  No delayed flights recorded yet.
                </td>
              </tr>
            ) : (
              rows.map((o) => (
                <tr className="hover:bg-white/5 transition-colors group" key={o.occurrence_key}>
                  <td className="px-lg py-md font-data-label font-bold text-on-surface group-hover:text-primary">
                    {o.flight_number}
                  </td>
                  <td className="px-lg py-md font-body-md text-on-surface">{routeLabel(o)}</td>
                  <td className="px-lg py-md font-data-label">{formatDateTime(o.first_delayed_at)}</td>
                  <td className="px-lg py-md font-data-label text-error">
                    {o.max_delay_minutes > 0 ? formatDuration(o.max_delay_minutes * 60000) : 'flagged'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
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
      supabase.from('flight_logs').select('*').order('captured_at', { ascending: false }).limit(5),
      supabase.from('collection_runs').select('*').order('captured_at', { ascending: false }).limit(2000),
      supabase
        .from('flight_occurrences')
        .select('*')
        .order('first_delayed_at', { ascending: true, nullsFirst: false })
        .limit(5000)
    ]);

    if (logsResult.error || runsResult.error || occurrencesResult.error) {
      setState('error');
      setError(
        logsResult.error?.message ||
          runsResult.error?.message ||
          occurrencesResult.error?.message ||
          'Could not load dashboard data.'
      );
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
    <main className="relative">
      <section className="relative min-h-[70vh] flex flex-col items-center justify-center text-center px-margin-mobile md:px-margin-desktop overflow-hidden py-xl">
        <div className="absolute inset-0 w-full h-full -z-20">
          <ShaderBackground />
        </div>

        <div className="max-w-4xl z-10 w-full">
          <h1 className="font-display-lg text-display-lg airport-glow mb-sm">
            How long can{' '}
            <img src={logo} alt="Maldivian" className="inline-block h-[1em] align-baseline mx-1" /> go without a delay?
          </h1>
          <p className="text-on-surface-variant max-w-2xl mx-auto mb-lg">
            Live delay watch for Maldivian Airlines flights, built from public flight information snapshots.
          </p>

          {!hasSupabaseConfig ? (
            <div className="glass-panel rounded-lg px-md py-sm mb-md inline-flex items-center gap-xs text-tertiary text-data-label">
              <AlertTriangle size={16} />
              Demo mode — add Supabase environment variables to show live stored data.
            </div>
          ) : null}

          <div className="glass-panel scanning-line py-xl px-lg rounded-xl mb-md border-primary/20 bg-primary/5">
            <div className="font-display-lg text-[80px] md:text-[120px] font-extrabold text-primary airport-glow leading-none mb-sm">
              {counterDays} {counterDays === 1 ? 'Day' : 'Days'}
            </div>
            <p className="text-on-surface-variant mb-md">
              without a recorded Maldivian delay · {counterDetail} since the last delay event
            </p>
            <div className="flex flex-col items-center gap-xs">
              <button
                className="bg-primary text-on-primary font-bold px-md py-xs rounded hover:scale-95 active:scale-95 transition-all duration-150 flex items-center gap-xs disabled:opacity-60"
                onClick={() => void loadData()}
                disabled={state === 'loading'}
              >
                <RefreshCcw size={18} />
                Refresh Data
              </button>
              <span className="text-data-label text-on-surface-variant text-[11px] opacity-70 italic">
                Last updated: {relativeTime(metrics.lastUpdated)}
              </span>
            </div>
          </div>
        </div>
      </section>

      {state === 'error' ? (
        <section className="max-w-[1440px] mx-auto px-margin-mobile md:px-margin-desktop pb-gutter">
          <div className="glass-panel rounded-xl p-lg flex items-center gap-md border border-error/40">
            <AlertTriangle className="text-error" />
            <div>
              <strong className="text-on-surface">Dashboard failed to load</strong>
              <p className="text-on-surface-variant text-data-label">{error}</p>
            </div>
          </div>
        </section>
      ) : null}

      <section className="max-w-[1440px] mx-auto px-margin-mobile md:px-margin-desktop pb-xl grid grid-cols-1 md:grid-cols-4 gap-gutter">
        <MetricCard
          label="Total delayed flights"
          value={metrics.totalDelayedFlights.toLocaleString()}
          detail="Unique occurrences since launch"
          valueClassName="font-display-lg text-[56px] md:text-[72px] leading-none"
          icon={<AlertTriangle className="text-error" size={22} />}
        />
        <MetricCard
          label="Delays last 24h"
          value={metrics.delayedLast24Hours}
          valueClassName="font-display-lg text-[56px] md:text-[72px] leading-none"
          icon={<Activity className="text-secondary" size={22} />}
        />
        <MetricCard
          label="Delays last 7d"
          value={metrics.delayedLast7Days}
          valueClassName="font-display-lg text-[56px] md:text-[72px] leading-none"
          icon={<CalendarClock className="text-secondary" size={22} />}
        />
        <MetricCard
          label="Longest clean streak"
          value={metrics.longestStreak ? formatDuration(metrics.longestStreak.durationMs) : 'No data'}
          detail={
            metrics.longestStreak
              ? `${formatDateTime(metrics.longestStreak.from)} → ${metrics.longestStreak.isCurrent ? 'now' : formatDateTime(metrics.longestStreak.to)}`
              : undefined
          }
          icon={<ShieldCheck className="text-tertiary" size={22} />}
        />
      </section>

      <section className="max-w-[1440px] mx-auto px-margin-mobile md:px-margin-desktop pb-xl grid grid-cols-1 md:grid-cols-2 gap-gutter">
        <div className="glass-panel scanning-line rounded-xl p-lg bg-primary/10 border-primary/40">
          <div className="flex items-center gap-sm mb-sm">
            <Hourglass className="text-primary" size={24} />
            <div className="font-data-label text-data-label text-on-surface-variant uppercase">
              Total time Maldivian flights have spent delayed
            </div>
          </div>
          <div className="font-display-lg text-display-lg text-primary airport-glow leading-none">
            {metrics.totalDelayMinutes > 0 ? formatDuration(metrics.totalDelayMinutes * 60000) : 'No delays yet'}
          </div>
          <div className="text-data-label text-on-surface-variant mt-xs">
            across {metrics.totalDelayedFlights.toLocaleString()} delayed flights since {formatDateTime(metrics.dataStart)}
          </div>
        </div>

        <div className="glass-panel scanning-line rounded-xl p-lg bg-error/10 border-error/40">
          <div className="flex items-center gap-sm mb-sm">
            <AlertTriangle className="text-error" size={24} />
            <div className="font-data-label text-data-label text-on-surface-variant uppercase">
              Longest delayed flight so far
            </div>
          </div>
          <div className="font-display-lg text-display-lg text-error critical-glow leading-none">
            {metrics.longestDelay && metrics.longestDelay.max_delay_minutes > 0
              ? formatDuration(metrics.longestDelay.max_delay_minutes * 60000)
              : 'No delays yet'}
          </div>
          <div className="text-data-label text-on-surface-variant mt-xs">
            {metrics.longestDelay && metrics.longestDelay.max_delay_minutes > 0
              ? `${metrics.longestDelay.flight_number} · ${routeLabel(metrics.longestDelay)} · ${formatDateTime(metrics.longestDelay.first_delayed_at)}`
              : 'Waiting for the first delay'}
          </div>
        </div>
      </section>

      <section className="max-w-[1440px] mx-auto px-margin-mobile md:px-margin-desktop grid grid-cols-1 lg:grid-cols-12 gap-gutter pb-xl">
        <DelayTrend occurrences={occurrences} />
        <OperationsLog logs={logs} />
        <LastDelayed occurrences={occurrences} />
      </section>

      <footer className="flex justify-center items-center py-xl px-lg text-center w-full bg-transparent">
        <div className="max-w-2xl text-on-surface-variant">
          <p className="font-body-md text-body-md mb-xs">
            Data source: Velana International Airport FIS XML snapshots.
          </p>
          <p className="font-body-md text-body-md">
            Delay rule: status contains delay or estimated time is 15 minutes later than scheduled time.
          </p>
        </div>
      </footer>
      <Analytics />
    </main>
  );
}

export default App;
