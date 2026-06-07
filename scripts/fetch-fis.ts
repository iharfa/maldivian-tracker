import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { XMLParser } from 'fast-xml-parser';

type SourceType = 'arrivals' | 'departures';

type RawFlight = Record<string, unknown>;

type NormalizedFlight = {
  captured_at: string;
  source: SourceType;
  fis_update_time: string | null;
  airline_id: string | null;
  airline_name: string | null;
  flight_number: string;
  route: string | null;
  carrier_type: string | null;
  scheduled_time_text: string | null;
  estimated_time_text: string | null;
  scheduled_at: string | null;
  estimated_at: string | null;
  terminal: string | null;
  gate: string | null;
  status: string | null;
  is_delayed: boolean;
  is_cancelled: boolean;
  delay_minutes: number | null;
  occurrence_key: string;
  raw: RawFlight;
};

const FIS_ENDPOINTS: Record<SourceType, string> = {
  arrivals: 'https://www.fis.com.mv/xml/arrive.xml',
  departures: 'https://www.fis.com.mv/xml/depart.xml'
};

const DELAY_THRESHOLD_MINUTES = Number(process.env.FIS_DELAY_THRESHOLD_MINUTES ?? '15');

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Add them as GitHub Actions secrets.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false
  }
});

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const output = String(value).trim();
  return output.length > 0 ? output : null;
}

function firstText(record: RawFlight, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(record[key]);
    if (value) return value;
  }
  return null;
}

function routeText(record: RawFlight): string | null {
  const routes = ['Route1', 'Route2', 'Route3', 'Route4', 'Route5']
    .map((key) => text(record[key]))
    .filter(Boolean) as string[];

  if (routes.length > 0) return routes.join(' / ');

  return firstText(record, ['Route', 'Destination', 'Origin', 'City']);
}

function parseMaldivesDateTime(value: string | null): Date | null {
  if (!value) return null;

  const compact = value.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (compact) {
    const [, year, month, day, hour, minute] = compact;
    return new Date(`${year}-${month}-${day}T${hour.padStart(2, '0')}:${minute}:00+05:00`);
  }

  const isoLike = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (isoLike) {
    const [, year, month, day, hour, minute] = isoLike;
    return new Date(`${year}-${month}-${day}T${hour.padStart(2, '0')}:${minute}:00+05:00`);
  }

  return null;
}

function combineWithUpdateDate(timeText: string | null, updateTime: Date | null): Date | null {
  if (!timeText || !updateTime) return null;

  const fullDate = parseMaldivesDateTime(timeText);
  if (fullDate) return fullDate;

  const time = timeText.match(/(\d{1,2}):(\d{2})/);
  if (!time) return null;

  const [, hour, minute] = time;
  const datePart = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Indian/Maldives',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(updateTime);

  return new Date(`${datePart}T${hour.padStart(2, '0')}:${minute}:00+05:00`);
}

function adjustEstimateAroundSchedule(estimated: Date | null, scheduled: Date | null): Date | null {
  if (!estimated || !scheduled) return estimated;

  const diffHours = (estimated.getTime() - scheduled.getTime()) / 36e5;
  if (diffHours < -12) return new Date(estimated.getTime() + 24 * 36e5);
  if (diffHours > 12) return new Date(estimated.getTime() - 24 * 36e5);
  return estimated;
}

function isMaldivianFlight(record: RawFlight): boolean {
  const airlineId = firstText(record, ['AirLineID', 'AirlineID', 'airline_id']);
  const airlineName = firstText(record, ['AirLineName', 'AirlineName', 'airline_name']);
  const flightNumber = firstText(record, ['FlightID', 'FlightNo', 'FlightNumber', 'flight_number']);

  return (
    airlineId?.toUpperCase() === 'Q2' ||
    airlineName?.toUpperCase().includes('MALDIVIAN') === true ||
    flightNumber?.toUpperCase().startsWith('Q2') === true
  );
}

function buildOccurrenceKey(source: SourceType, flightNumber: string, route: string | null, scheduledAt: string | null, scheduledText: string | null): string {
  const keyParts = [source, flightNumber.toUpperCase(), route ?? '', scheduledAt ?? scheduledText ?? ''];
  return createHash('sha1').update(keyParts.join('|')).digest('hex');
}

function normalizeFlight(record: RawFlight, source: SourceType, capturedAt: Date, fisUpdateTimeText: string | null): NormalizedFlight | null {
  const airlineId = firstText(record, ['AirLineID', 'AirlineID', 'airline_id']);
  const airlineName = firstText(record, ['AirLineName', 'AirlineName', 'airline_name']);
  const flightNumber = firstText(record, ['FlightID', 'FlightNo', 'FlightNumber', 'flight_number']);

  if (!flightNumber) return null;

  const scheduledText = firstText(record, ['Time', 'TIME', 'STD', 'STA', 'Scheduled', 'ScheduledTime', 'ScheduleTime']);
  const estimatedText = firstText(record, ['Estm', 'ESTM', 'Estimated', 'EstimatedTime', 'Estimate', 'Expected', 'ETD', 'ETA']);
  const status = firstText(record, ['Status', 'STATUS', 'FlightStatus', 'Remark', 'Remarks']);
  const terminal = firstText(record, ['Terminal', 'TERMINAL', 'TerminalID']);
  const gate = firstText(record, ['Gate', 'GATE', 'GateNo', 'GateNumber']);
  const carrierType = firstText(record, ['CarrierType', 'carrier_type']);
  const route = routeText(record);

  const updateTime = parseMaldivesDateTime(fisUpdateTimeText);
  const scheduledAtDate = combineWithUpdateDate(scheduledText, updateTime);
  const estimatedAtDate = adjustEstimateAroundSchedule(combineWithUpdateDate(estimatedText, updateTime), scheduledAtDate);

  const scheduledAt = scheduledAtDate ? scheduledAtDate.toISOString() : null;
  const estimatedAt = estimatedAtDate ? estimatedAtDate.toISOString() : null;

  const delayMinutes = scheduledAtDate && estimatedAtDate
    ? Math.max(0, Math.round((estimatedAtDate.getTime() - scheduledAtDate.getTime()) / 60000))
    : null;

  const statusUpper = status?.toUpperCase() ?? '';
  const isCancelled = statusUpper.includes('CANCEL');
  const delayedByStatus = statusUpper.includes('DELAY');
  const delayedByTime = delayMinutes !== null && delayMinutes >= DELAY_THRESHOLD_MINUTES;
  const isDelayed = delayedByStatus || delayedByTime;

  const occurrenceKey = buildOccurrenceKey(source, flightNumber, route, scheduledAt, scheduledText);

  return {
    captured_at: capturedAt.toISOString(),
    source,
    fis_update_time: fisUpdateTimeText,
    airline_id: airlineId,
    airline_name: airlineName,
    flight_number: flightNumber,
    route,
    carrier_type: carrierType,
    scheduled_time_text: scheduledText,
    estimated_time_text: estimatedText,
    scheduled_at: scheduledAt,
    estimated_at: estimatedAt,
    terminal,
    gate,
    status,
    is_delayed: isDelayed,
    is_cancelled: isCancelled,
    delay_minutes: delayMinutes,
    occurrence_key: occurrenceKey,
    raw: record
  };
}

async function fetchXml(source: SourceType): Promise<{ updateTime: string | null; flights: RawFlight[] }> {
  const response = await fetch(FIS_ENDPOINTS[source], {
    headers: {
      accept: 'text/xml, application/xml, text/plain, */*',
      'user-agent': 'MaldivianDelayCounter/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`FIS ${source} fetch failed with ${response.status}`);
  }

  const xml = await response.text();
  const parsed = parser.parse(xml);
  const root = parsed.Departures ?? parsed.Arrivals ?? parsed.departures ?? parsed.arrivals;

  if (!root) {
    throw new Error(`FIS ${source} XML root was not recognised`);
  }

  const updateTime = text(root.UpdateTime ?? root.updateTime ?? root.updated);
  const flights = asArray<RawFlight>(root.Flight ?? root.flight);

  if (flights[0]) {
    console.log(`${source} sample keys: ${Object.keys(flights[0]).join(', ')}`);
  }

  return { updateTime, flights };
}

async function saveRun(source: SourceType, capturedAt: Date, updateTime: string | null, flightsFound: number, maldivianFound: number, insertedLogs: number, error: string | null = null) {
  const { error: runError } = await supabase.from('collection_runs').insert({
    captured_at: capturedAt.toISOString(),
    source,
    fis_update_time: updateTime,
    flights_found: flightsFound,
    maldivian_found: maldivianFound,
    inserted_logs: insertedLogs,
    error
  });

  if (runError) throw runError;
}

async function upsertOccurrence(flight: NormalizedFlight) {
  const { data: existing, error: readError } = await supabase
    .from('flight_occurrences')
    .select('occurrence_key, was_delayed, first_delayed_at, max_delay_minutes, was_cancelled, first_cancelled_at')
    .eq('occurrence_key', flight.occurrence_key)
    .maybeSingle();

  if (readError) throw readError;

  if (!existing) {
    const { error } = await supabase.from('flight_occurrences').insert({
      occurrence_key: flight.occurrence_key,
      first_seen_at: flight.captured_at,
      last_seen_at: flight.captured_at,
      source: flight.source,
      airline_id: flight.airline_id,
      airline_name: flight.airline_name,
      flight_number: flight.flight_number,
      route: flight.route,
      carrier_type: flight.carrier_type,
      scheduled_time_text: flight.scheduled_time_text,
      estimated_time_text: flight.estimated_time_text,
      scheduled_at: flight.scheduled_at,
      estimated_at: flight.estimated_at,
      terminal: flight.terminal,
      gate: flight.gate,
      status: flight.status,
      was_delayed: flight.is_delayed,
      first_delayed_at: flight.is_delayed ? flight.captured_at : null,
      max_delay_minutes: flight.delay_minutes ?? 0,
      was_cancelled: flight.is_cancelled,
      first_cancelled_at: flight.is_cancelled ? flight.captured_at : null,
      last_raw: flight.raw,
      updated_at: flight.captured_at
    });

    if (error) throw error;
    return;
  }

  const wasDelayed = Boolean(existing.was_delayed) || flight.is_delayed;
  const wasCancelled = Boolean(existing.was_cancelled) || flight.is_cancelled;
  const firstDelayedAt = existing.first_delayed_at ?? (flight.is_delayed ? flight.captured_at : null);
  const firstCancelledAt = existing.first_cancelled_at ?? (flight.is_cancelled ? flight.captured_at : null);
  const maxDelayMinutes = Math.max(Number(existing.max_delay_minutes ?? 0), flight.delay_minutes ?? 0);

  const { error } = await supabase
    .from('flight_occurrences')
    .update({
      last_seen_at: flight.captured_at,
      estimated_time_text: flight.estimated_time_text,
      estimated_at: flight.estimated_at,
      terminal: flight.terminal,
      gate: flight.gate,
      status: flight.status,
      was_delayed: wasDelayed,
      first_delayed_at: firstDelayedAt,
      max_delay_minutes: maxDelayMinutes,
      was_cancelled: wasCancelled,
      first_cancelled_at: firstCancelledAt,
      last_raw: flight.raw,
      updated_at: flight.captured_at
    })
    .eq('occurrence_key', flight.occurrence_key);

  if (error) throw error;
}

async function collectSource(source: SourceType) {
  const capturedAt = new Date();
  let updateTime: string | null = null;
  let flightsFound = 0;
  let maldivianFound = 0;
  let insertedLogs = 0;

  try {
    const result = await fetchXml(source);
    updateTime = result.updateTime;
    flightsFound = result.flights.length;

    const maldivianFlights = result.flights.filter(isMaldivianFlight);
    const normalized = maldivianFlights
      .map((flight) => normalizeFlight(flight, source, capturedAt, updateTime))
      .filter(Boolean) as NormalizedFlight[];

    maldivianFound = normalized.length;

    if (normalized.length > 0) {
      const { error } = await supabase.from('flight_logs').insert(normalized);
      if (error) throw error;
      insertedLogs = normalized.length;

      for (const flight of normalized) {
        await upsertOccurrence(flight);
      }
    }

    await saveRun(source, capturedAt, updateTime, flightsFound, maldivianFound, insertedLogs);
    console.log(`${source}: saved ${insertedLogs} Maldivian logs from ${flightsFound} FIS flights`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveRun(source, capturedAt, updateTime, flightsFound, maldivianFound, insertedLogs, message);
    throw error;
  }
}

async function main() {
  await collectSource('arrivals');
  await collectSource('departures');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
