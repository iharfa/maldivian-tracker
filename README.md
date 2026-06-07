# Maldivian Delay Counter

A Vercel hosted React dashboard that tracks Maldivian Airlines delays from Velana International Airport FIS XML snapshots.

The collector runs every 5 minutes through GitHub Actions. It stores Maldivian Airlines arrival and departure records in Supabase. The Vercel site reads from Supabase and displays:

- Main days without a recorded delay counter
- Last updated time
- Last 5 stored Maldivian flight logs
- Total delayed flights since launch
- Delays in the last 24 hours and 7 days
- Longest streak without delays, with from and to dates
- Daily delay event bars

## Data source

The collector reads:

- `https://www.fis.com.mv/xml/arrive.xml`
- `https://www.fis.com.mv/xml/depart.xml`

It stores only flights where:

- `AirLineID` is `Q2`
- or airline name contains `MALDIVIAN`
- or flight number starts with `Q2`

## Delay rule

A flight is marked delayed when either:

- the status text contains `DELAY`
- or estimated time is 15 minutes or more later than scheduled time

You can change the threshold in `.github/workflows/fetch-fis.yml` by editing:

```yaml
FIS_DELAY_THRESHOLD_MINUTES: 15
```

## Setup

### 1. Create Supabase project

Create a new Supabase project.

Open Supabase SQL Editor and run:

```sql
-- Paste the full contents of supabase/schema.sql here
```

This creates:

- `collection_runs`
- `flight_logs`
- `flight_occurrences`

RLS is enabled. Public users can only read. The GitHub Action uses the service role key to insert.

### 2. Add GitHub repository secrets

In GitHub:

Settings → Secrets and variables → Actions → New repository secret

Add:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Use the Supabase project URL and service role key from Supabase project settings.

Do not expose the service role key in Vercel.

### 3. Add Vercel environment variables

In Vercel project settings:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

Use the Supabase project URL and anon public key.

### 4. Install and run locally

```bash
npm install
npm run dev
```

### 5. Test the collector manually

After adding `.env` locally with Supabase credentials:

```bash
npm run fetch:fis
```

Or run it from GitHub:

Actions → Fetch FIS data → Run workflow

### 6. Deploy on Vercel

Connect the GitHub repository to Vercel.

Use these settings:

```text
Framework Preset: Vite
Build Command: npm run build
Output Directory: dist
Install Command: npm install
```

## Files

```text
.github/workflows/fetch-fis.yml       Scheduled 5 minute data collector
scripts/fetch-fis.ts                  FIS XML fetcher and Supabase writer
supabase/schema.sql                   Database schema and RLS policies
src/App.tsx                           Dashboard UI
src/lib/metrics.ts                    Streak and delay calculations
src/assets/maldivian-logo.png         Uploaded Maldivian logo
```

## Important limitation

The counter is based on snapshots. If a delay appears and disappears between two 5 minute checks, it will not be recorded. For this use case, 5 minutes is a strong interval.
