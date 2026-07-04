export type SourceType = 'arrivals' | 'departures';

export type CollectionRun = {
  id: string;
  captured_at: string;
  source: SourceType;
  fis_update_time: string | null;
  flights_found: number;
  maldivian_found: number;
  inserted_logs: number;
  error: string | null;
};

export type FlightLog = {
  id: number;
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
};

export type FlightOccurrence = {
  occurrence_key: string;
  first_seen_at: string;
  last_seen_at: string;
  source: SourceType;
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
  was_delayed: boolean;
  first_delayed_at: string | null;
  max_delay_minutes: number;
  was_cancelled: boolean;
  first_cancelled_at: string | null;
};

// Minimal occurrence shape the dashboard actually consumes (seed + live share this).
export type OccurrenceStat = Pick<
  FlightOccurrence,
  | 'occurrence_key'
  | 'source'
  | 'route'
  | 'flight_number'
  | 'scheduled_at'
  | 'first_seen_at'
  | 'was_delayed'
  | 'first_delayed_at'
  | 'max_delay_minutes'
>;

export type Streak = {
  from: Date;
  to: Date;
  durationMs: number;
  isCurrent: boolean;
};

export type DashboardMetrics = {
  dataStart: Date | null;
  lastUpdated: Date | null;
  lastDelay: OccurrenceStat | null;
  totalDelayedFlights: number;
  totalDelayMinutes: number;
  longestDelay: OccurrenceStat | null;
  currentStreak: Streak | null;
  longestStreak: Streak | null;
  delayedLast24Hours: number;
  delayedLast7Days: number;
  currentlyDelayed: number;
};
