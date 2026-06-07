create extension if not exists pgcrypto;

create table if not exists public.collection_runs (
  id uuid primary key default gen_random_uuid(),
  captured_at timestamptz not null default now(),
  source text not null check (source in ('arrivals', 'departures')),
  fis_update_time text,
  flights_found integer not null default 0,
  maldivian_found integer not null default 0,
  inserted_logs integer not null default 0,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists public.flight_logs (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null,
  source text not null check (source in ('arrivals', 'departures')),
  fis_update_time text,
  airline_id text,
  airline_name text,
  flight_number text not null,
  route text,
  carrier_type text,
  scheduled_time_text text,
  estimated_time_text text,
  scheduled_at timestamptz,
  estimated_at timestamptz,
  terminal text,
  gate text,
  status text,
  is_delayed boolean not null default false,
  is_cancelled boolean not null default false,
  delay_minutes integer,
  occurrence_key text not null,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.flight_occurrences (
  occurrence_key text primary key,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  source text not null check (source in ('arrivals', 'departures')),
  airline_id text,
  airline_name text,
  flight_number text not null,
  route text,
  carrier_type text,
  scheduled_time_text text,
  estimated_time_text text,
  scheduled_at timestamptz,
  estimated_at timestamptz,
  terminal text,
  gate text,
  status text,
  was_delayed boolean not null default false,
  first_delayed_at timestamptz,
  max_delay_minutes integer not null default 0,
  was_cancelled boolean not null default false,
  first_cancelled_at timestamptz,
  last_raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists idx_collection_runs_captured_at on public.collection_runs (captured_at desc);
create index if not exists idx_flight_logs_captured_at on public.flight_logs (captured_at desc);
create index if not exists idx_flight_logs_flight_number on public.flight_logs (flight_number);
create index if not exists idx_flight_logs_occurrence on public.flight_logs (occurrence_key);
create index if not exists idx_flight_occurrences_first_delayed on public.flight_occurrences (first_delayed_at desc);
create index if not exists idx_flight_occurrences_was_delayed on public.flight_occurrences (was_delayed);

alter table public.collection_runs enable row level security;
alter table public.flight_logs enable row level security;
alter table public.flight_occurrences enable row level security;

drop policy if exists "Public read collection runs" on public.collection_runs;
create policy "Public read collection runs"
on public.collection_runs
for select
using (true);

drop policy if exists "Public read flight logs" on public.flight_logs;
create policy "Public read flight logs"
on public.flight_logs
for select
using (true);

drop policy if exists "Public read flight occurrences" on public.flight_occurrences;
create policy "Public read flight occurrences"
on public.flight_occurrences
for select
using (true);
