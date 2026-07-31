-- ════════════════════════════════════════════════════════════════════════════
-- 003 — ROLLUPS, HISTOGRAMS, DEAD LETTER QUEUE
-- ════════════════════════════════════════════════════════════════════════════
--
-- Drawing "p95 latency over the last 24 hours" from raw rows means scanning
-- millions of them every time someone opens the dashboard. Pre-aggregating to
-- one row per minute turns that into 1,440 rows.
--
-- A shop does not recount every receipt to know yesterday's takings; the total
-- was written in a book at closing time.
--
-- The rollup is a CACHE, not a second source of truth. Raw events remain
-- authoritative and 005 adds a reconciliation job that rebuilds from them and
-- alerts on drift. "My aggregates are verifiable against raw" is a sentence
-- worth being able to say.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- Latency histogram
-- ────────────────────────────────────────────────────────────────────────────
--
-- Why fixed buckets rather than percentile_cont over raw, or a t-digest?
--
--   percentile_cont  — exact, but needs every raw row in memory. Fine for one
--                      hour, hopeless for 30 days, and it cannot be rolled up:
--                      you cannot average two p95s to get a combined p95.
--   t-digest         — mergeable and accurate, but needs an extension Neon does
--                      not offer.
--   fixed buckets    — mergeable by simple array addition, tiny, extension-free.
--                      Accuracy is bounded by bucket width, which is the price.
--
-- Mergeability is the property that matters: adding two histograms element-wise
-- gives the histogram of the union, so a day's p95 is derivable from 1,440
-- minute rows without touching raw data.
--
-- Bucket upper bounds, in milliseconds. Log-ish spacing because latency
-- distributions are long-tailed and resolution is worth more near the median.
CREATE OR REPLACE FUNCTION latency_bucket_bounds() RETURNS integer[] AS $$
  SELECT ARRAY[100, 250, 500, 1000, 2000, 4000, 8000, 15000, 30000, 60000, 2147483647];
$$ LANGUAGE sql IMMUTABLE;

-- Which bucket does a duration fall into? 1-based, to match Postgres arrays.
CREATE OR REPLACE FUNCTION latency_bucket_index(ms integer) RETURNS integer AS $$
DECLARE
  bounds integer[] := latency_bucket_bounds();
  i integer;
BEGIN
  IF ms IS NULL THEN RETURN NULL; END IF;
  FOR i IN 1 .. array_length(bounds, 1) LOOP
    IF ms < bounds[i] THEN RETURN i; END IF;
  END LOOP;
  RETURN array_length(bounds, 1);
END
$$ LANGUAGE plpgsql IMMUTABLE;

-- A histogram with a single observation, ready to be summed into a rollup row.
CREATE OR REPLACE FUNCTION latency_histogram_of(ms integer) RETURNS integer[] AS $$
DECLARE
  n   integer := array_length(latency_bucket_bounds(), 1);
  idx integer := latency_bucket_index(ms);
  h   integer[];
BEGIN
  h := array_fill(0, ARRAY[n]);
  IF idx IS NOT NULL THEN h[idx] := 1; END IF;
  RETURN h;
END
$$ LANGUAGE plpgsql IMMUTABLE;

-- Element-wise addition. This is what makes rollups composable across any time
-- range without going back to raw rows.
CREATE OR REPLACE FUNCTION histogram_add(a integer[], b integer[]) RETURNS integer[] AS $$
DECLARE
  n integer := greatest(coalesce(array_length(a, 1), 0), coalesce(array_length(b, 1), 0));
  r integer[];
  i integer;
BEGIN
  r := array_fill(0, ARRAY[n]);
  FOR i IN 1 .. n LOOP
    r[i] := coalesce(a[i], 0) + coalesce(b[i], 0);
  END LOOP;
  RETURN r;
END
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE AGGREGATE histogram_sum(integer[]) (
  SFUNC = histogram_add,
  STYPE = integer[],
  INITCOND = '{}'
);

-- Read a percentile back out, interpolating linearly inside the bucket that
-- contains it.
--
-- p is a fraction: 0.95 for p95. Returns NULL for an empty histogram rather
-- than 0 — an absence of data is not a latency of zero, and a chart that
-- conflates them tells you the system is fast when it is actually idle.
--
-- The final bucket is unbounded, so a percentile landing there returns its
-- lower bound. In practice that means "p99 is at least 60s", which is the
-- honest reading.
CREATE OR REPLACE FUNCTION histogram_percentile(h integer[], p double precision)
RETURNS double precision AS $$
DECLARE
  bounds integer[] := latency_bucket_bounds();
  total  bigint := 0;
  target double precision;
  cum    bigint := 0;
  prev   bigint := 0;
  lower  double precision;
  upper  double precision;
  i      integer;
BEGIN
  IF h IS NULL THEN RETURN NULL; END IF;

  FOR i IN 1 .. coalesce(array_length(h, 1), 0) LOOP
    total := total + coalesce(h[i], 0);
  END LOOP;

  IF total = 0 THEN RETURN NULL; END IF;

  target := total * p;

  FOR i IN 1 .. array_length(h, 1) LOOP
    prev := cum;
    cum  := cum + coalesce(h[i], 0);

    IF cum >= target THEN
      lower := CASE WHEN i = 1 THEN 0 ELSE bounds[i - 1] END;
      upper := bounds[i];

      -- Unbounded tail: nothing to interpolate against.
      IF i = array_length(bounds, 1) THEN RETURN lower; END IF;
      IF h[i] = 0 THEN RETURN lower; END IF;

      RETURN lower + (upper - lower) * ((target - prev) / h[i]);
    END IF;
  END LOOP;

  RETURN bounds[array_length(bounds, 1) - 1];
END
$$ LANGUAGE plpgsql IMMUTABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- inference_rollup_1m
-- ────────────────────────────────────────────────────────────────────────────
--
-- Grain: one row per (minute, provider, model).
--
-- Status is a set of counter columns rather than part of the key. Keying on it
-- would triple the row count and, worse, force the error-rate panel to do a
-- self-join to compute errors/total. As columns, error rate is one division.
CREATE TABLE inference_rollup_1m (
  bucket            timestamptz NOT NULL,
  provider          text NOT NULL,
  model             text NOT NULL,

  calls             bigint NOT NULL DEFAULT 0,
  errors            bigint NOT NULL DEFAULT 0,
  -- Counted separately from errors, and this matters: a cancellation is a user
  -- decision, not a failure. Folding it into the error count would inflate the
  -- error-rate panel with deliberate behaviour, and a dashboard that cries wolf
  -- gets ignored.
  cancelled         bigint NOT NULL DEFAULT 0,
  streamed_calls    bigint NOT NULL DEFAULT 0,

  sum_latency_ms    bigint NOT NULL DEFAULT 0,
  sum_ttft_ms       bigint NOT NULL DEFAULT 0,
  -- Denominator for mean TTFT. Not every call has a TTFT, so `calls` is the
  -- wrong divisor and would understate it.
  ttft_count        bigint NOT NULL DEFAULT 0,

  input_tokens      bigint NOT NULL DEFAULT 0,
  output_tokens     bigint NOT NULL DEFAULT 0,
  cost_usd          numeric(16, 8) NOT NULL DEFAULT 0,

  hist_latency      integer[] NOT NULL,
  hist_ttft         integer[] NOT NULL,

  updated_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (bucket, provider, model)
);

-- Every dashboard query is a time range, usually then grouped by model.
CREATE INDEX inference_rollup_1m_time_idx ON inference_rollup_1m (bucket DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- Dead letter queue
-- ────────────────────────────────────────────────────────────────────────────
--
-- An event that cannot be processed must not be retried forever: one bad parcel
-- would block the whole round. After a bounded number of attempts it is parked
-- here, with the payload intact so it can be replayed once the bug is fixed.
--
-- Parked, not lost. The distinction is the whole point.
CREATE TABLE dlq (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  -- The raw payload exactly as received. Deliberately jsonb with no schema
  -- applied: the reason it is here is usually that it failed the schema.
  payload       jsonb NOT NULL,
  event_id      uuid,
  stage         text NOT NULL,
  error         text NOT NULL,
  attempts      integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  replayed_at   timestamptz
);

CREATE INDEX dlq_pending_idx ON dlq (first_seen_at DESC) WHERE replayed_at IS NULL;
