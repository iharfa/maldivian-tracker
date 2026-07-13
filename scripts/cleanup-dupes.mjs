// One-off repair for the pre-14-Jul-2026 midnight date bug (see fetch-fis.ts history).
//
// Before the fix, flights still in the FIS feed after midnight were re-recorded with
// the next day's date. That produced two kinds of bad occurrence rows:
//
//   Class A "stale phantoms": the claimed next-day flight never operated on the same
//     route, so the row was never touched again. Signature: last_seen_at more than
//     12h BEFORE its own scheduled_at (a real flight stays in the feed until it flies).
//     Repair: merge its delay/seen history into the real previous-day twin, repoint
//     its flight_logs to the twin, delete the row.
//
//   Class B "absorbed": the next day's real flight reused the phantom's key and
//     inherited its history. Only harmful when a delay flag was inherited. Signature:
//     first_delayed_at more than 20h BEFORE scheduled_at (FIS never estimates that far
//     ahead). Repair: transfer the inherited delay to the twin, repoint the pre-window
//     logs, then recompute the row's delay fields from its own operating-day logs.
//
// Dry run by default; set APPLY=1 to write. Requires SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY. Idempotent: a repaired dataset yields zero findings.

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
const APPLY = process.env.APPLY === '1';
const BASE = `${url.replace(/\/$/, '')}/rest/v1`;
const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

const DAY = 86400000;
const STALE_GAP = 12 * 3600e3;
const EARLY_DELAY_GAP = 20 * 3600e3;
const DELAY_THRESHOLD = Number(process.env.FIS_DELAY_THRESHOLD_MINUTES ?? '15');

async function rest(path, init = {}) {
  const res = await fetch(`${BASE}/${path}`, { ...init, headers: { ...H, ...init.headers } });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${await res.text()}`);
  return res.headers.get('content-type')?.includes('json') && res.status !== 204 ? res.json() : null;
}

const occ = [];
for (let off = 0; ; off += 1000) {
  const page = await rest(`flight_occurrences?select=occurrence_key,source,flight_number,route,scheduled_at,first_seen_at,last_seen_at,was_delayed,first_delayed_at,max_delay_minutes,was_cancelled,first_cancelled_at&order=first_seen_at.asc&limit=1000&offset=${off}`);
  occ.push(...page);
  if (page.length < 1000) break;
}
console.log(`loaded ${occ.length} occurrences (APPLY=${APPLY ? 'yes' : 'DRY RUN'})`);

const byFlight = new Map();
for (const o of occ) {
  const k = `${o.source}|${o.flight_number}`;
  if (!byFlight.has(k)) byFlight.set(k, []);
  byFlight.get(k).push(o);
}
const ts = (v) => (v ? new Date(v).getTime() : null);
function twinOf(o) {
  const candidates = byFlight
    .get(`${o.source}|${o.flight_number}`)
    .filter((a) => a !== o && a.scheduled_at && Math.abs(ts(a.scheduled_at) + DAY - ts(o.scheduled_at)) < 60e3);
  return candidates.find((a) => a.route === o.route) ?? candidates[0] ?? null;
}

async function mergeIntoTwin(twin, source) {
  const patch = {};
  if (ts(source.first_seen_at) < ts(twin.first_seen_at)) patch.first_seen_at = source.first_seen_at;
  if (ts(source.last_seen_at) > ts(twin.last_seen_at)) patch.last_seen_at = source.last_seen_at;
  if (source.was_delayed) {
    patch.was_delayed = true;
    if (!twin.first_delayed_at || ts(source.first_delayed_at) < ts(twin.first_delayed_at)) {
      patch.first_delayed_at = source.first_delayed_at;
    }
    if ((source.max_delay_minutes ?? 0) > (twin.max_delay_minutes ?? 0)) {
      patch.max_delay_minutes = source.max_delay_minutes;
    }
  }
  if (source.was_cancelled && !twin.was_cancelled) {
    patch.was_cancelled = true;
    patch.first_cancelled_at = source.first_cancelled_at;
  }
  if (Object.keys(patch).length === 0) return 'no-op';
  if (APPLY) {
    await rest(`flight_occurrences?occurrence_key=eq.${twin.occurrence_key}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      headers: { Prefer: 'return=minimal' }
    });
  }
  return Object.keys(patch).join(',');
}

// ---- Class A: stale phantoms ----
const classA = occ.filter(
  (o) => o.scheduled_at && ts(o.scheduled_at) - ts(o.last_seen_at) > STALE_GAP && twinOf(o)
);
const aKeys = new Set(classA.map((o) => o.occurrence_key));
console.log(`\nClass A stale phantoms: ${classA.length} (${classA.filter((o) => o.was_delayed).length} flagged delayed)`);

for (const o of classA) {
  const twin = twinOf(o);
  const merged = await mergeIntoTwin(twin, o);
  if (APPLY) {
    // Their logs are post-midnight observations of the twin's flight — repoint, then delete.
    await rest(`flight_logs?occurrence_key=eq.${o.occurrence_key}`, {
      method: 'PATCH',
      body: JSON.stringify({ occurrence_key: twin.occurrence_key }),
      headers: { Prefer: 'return=minimal' }
    });
    await rest(`flight_occurrences?occurrence_key=eq.${o.occurrence_key}`, { method: 'DELETE' });
  }
  console.log(` A ${o.flight_number} sched=${o.scheduled_at} delayed=${o.was_delayed}(${o.max_delay_minutes}m) -> twin ${twin.occurrence_key.slice(0, 8)} [merged: ${merged}]`);
}

// ---- Class B: absorbed rows with an inherited delay flag ----
const classB = occ.filter(
  (o) =>
    !aKeys.has(o.occurrence_key) &&
    o.scheduled_at &&
    o.was_delayed &&
    o.first_delayed_at &&
    ts(o.scheduled_at) - ts(o.first_delayed_at) > EARLY_DELAY_GAP &&
    twinOf(o)
);
console.log(`\nClass B absorbed rows with inherited delay: ${classB.length}`);

for (const o of classB) {
  const twin = twinOf(o);
  const cutoff = new Date(ts(o.scheduled_at) - EARLY_DELAY_GAP).toISOString();
  const logs = await rest(
    `flight_logs?select=id,captured_at,is_delayed,delay_minutes,is_cancelled&occurrence_key=eq.${o.occurrence_key}&order=captured_at.asc&limit=1000`
  );
  const inherited = logs.filter((l) => ts(l.captured_at) < ts(cutoff));
  const own = logs.filter((l) => ts(l.captured_at) >= ts(cutoff));

  // Transfer the inherited (previous-night) delay observation to the twin.
  const inheritedMax = Math.max(0, ...inherited.map((l) => l.delay_minutes ?? 0));
  const inheritedDelayedAt = inherited.find((l) => l.is_delayed)?.captured_at ?? null;
  const merged = await mergeIntoTwin(twin, {
    first_seen_at: o.first_seen_at,
    last_seen_at: inherited.length ? inherited[inherited.length - 1].captured_at : twin.last_seen_at,
    was_delayed: Boolean(inheritedDelayedAt),
    first_delayed_at: inheritedDelayedAt,
    max_delay_minutes: inheritedMax,
    was_cancelled: false,
    first_cancelled_at: null
  });

  // Recompute this row's delay fields from its own operating-day logs.
  const ownDelayed = own.filter((l) => l.is_delayed || (l.delay_minutes ?? 0) >= DELAY_THRESHOLD);
  const patch = {
    was_delayed: ownDelayed.length > 0,
    first_delayed_at: ownDelayed[0]?.captured_at ?? null,
    max_delay_minutes: Math.max(0, ...own.map((l) => l.delay_minutes ?? 0)),
    first_seen_at: own[0]?.captured_at ?? o.first_seen_at
  };
  if (APPLY) {
    await rest(`flight_logs?occurrence_key=eq.${o.occurrence_key}&captured_at=lt.${cutoff}`, {
      method: 'PATCH',
      body: JSON.stringify({ occurrence_key: twin.occurrence_key }),
      headers: { Prefer: 'return=minimal' }
    });
    await rest(`flight_occurrences?occurrence_key=eq.${o.occurrence_key}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      headers: { Prefer: 'return=minimal' }
    });
  }
  console.log(
    ` B ${o.flight_number} sched=${o.scheduled_at}: ${inherited.length} inherited logs (max ${inheritedMax}m) -> twin [${merged}]; own-day delayed=${patch.was_delayed} max=${patch.max_delay_minutes}m`
  );
}

// ---- Class C: delay flag whose evidence log carries a different raw operating date ----
// FIS pre-publishes future flights (sometimes days ahead) with retimed estimates; the
// old date stamping booked those as delays on the wrong day. Audit every delayed row:
// the log that first flagged the delay must have raw.Date matching the row's own
// scheduled date. On mismatch, recompute the row from its own-date logs only.
const mvtDate = (iso) => new Date(ts(iso) + 5 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
const delayedRows = occ.filter((o) => !aKeys.has(o.occurrence_key) && o.was_delayed && o.first_delayed_at && o.scheduled_at);

const classC = [];
{
  const queue = [...delayedRows];
  const workers = Array.from({ length: 8 }, async () => {
    for (let o = queue.pop(); o; o = queue.pop()) {
      const [log] = await rest(
        `flight_logs?select=captured_at,raw->>Date&occurrence_key=eq.${o.occurrence_key}&captured_at=gte.${encodeURIComponent(o.first_delayed_at)}&order=captured_at.asc&limit=1`
      );
      const rawDate = log?.Date?.trim();
      if (rawDate && rawDate !== mvtDate(o.scheduled_at)) classC.push({ o, rawDate });
    }
  });
  await Promise.all(workers);
}
console.log(`\nClass C delays flagged by another day's raw data: ${classC.length}`);

for (const { o, rawDate } of classC) {
  const own = await rest(
    `flight_logs?select=captured_at,is_delayed,delay_minutes&occurrence_key=eq.${o.occurrence_key}&raw->>Date=eq.${mvtDate(o.scheduled_at)}&order=captured_at.asc&limit=1000`
  );
  const ownDelayed = own.filter((l) => l.is_delayed || (l.delay_minutes ?? 0) >= DELAY_THRESHOLD);
  const patch = {
    was_delayed: ownDelayed.length > 0,
    first_delayed_at: ownDelayed[0]?.captured_at ?? null,
    max_delay_minutes: Math.max(0, ...own.map((l) => l.delay_minutes ?? 0))
  };
  if (APPLY) {
    await rest(`flight_occurrences?occurrence_key=eq.${o.occurrence_key}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      headers: { Prefer: 'return=minimal' }
    });
  }
  console.log(
    ` C ${o.flight_number} sched=${o.scheduled_at} max=${o.max_delay_minutes}m flagged by raw.Date=${rawDate} -> own-day delayed=${patch.was_delayed} max=${patch.max_delay_minutes}m (${own.length} own-day logs)`
  );
}

// ---- Class D: delay flagged more than 12h before the row's own scheduled time ----
// At midnight FIS re-dates a still-active overnight flight to its arrival day, so the
// previous evening's delay lands on the next day's row. A real estimate never precedes
// its schedule by 12h. Recompute from logs captured near the actual operating window.
const classD = delayedRows.filter(
  (o) => !classC.some((c) => c.o === o) && ts(o.scheduled_at) - ts(o.first_delayed_at) > STALE_GAP
);
console.log(`\nClass D delays flagged >12h before own schedule: ${classD.length}`);

for (const o of classD) {
  const from = new Date(ts(o.scheduled_at) - STALE_GAP).toISOString();
  const own = await rest(
    `flight_logs?select=captured_at,is_delayed,delay_minutes&occurrence_key=eq.${o.occurrence_key}&captured_at=gte.${encodeURIComponent(from)}&order=captured_at.asc&limit=1000`
  );
  const ownDelayed = own.filter((l) => l.is_delayed || (l.delay_minutes ?? 0) >= DELAY_THRESHOLD);
  const patch = {
    was_delayed: ownDelayed.length > 0,
    first_delayed_at: ownDelayed[0]?.captured_at ?? null,
    max_delay_minutes: Math.max(0, ...own.map((l) => l.delay_minutes ?? 0))
  };
  if (APPLY) {
    await rest(`flight_occurrences?occurrence_key=eq.${o.occurrence_key}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      headers: { Prefer: 'return=minimal' }
    });
  }
  console.log(
    ` D ${o.flight_number} sched=${o.scheduled_at} max=${o.max_delay_minutes}m flagged=${o.first_delayed_at} -> own-window delayed=${patch.was_delayed} max=${patch.max_delay_minutes}m`
  );
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN — no writes made. Re-run with APPLY=1 to apply.'}`);
console.log(
  `Summary: ${classA.length} phantom rows ${APPLY ? 'deleted' : 'would be deleted'}, ${classB.length} absorbed rows and ${classC.length + classD.length} misattributed delay flags ${APPLY ? 'repaired' : 'would be repaired'}.`
);
