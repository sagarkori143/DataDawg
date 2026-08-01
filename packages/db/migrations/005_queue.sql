-- ════════════════════════════════════════════════════════════════════════════
-- 005 — EVENT QUEUE
-- ════════════════════════════════════════════════════════════════════════════
--
-- Decouples ingest latency from database latency. `POST /v1/events` stops
-- awaiting an INSERT and instead hands the batch to a queue, so a slow or
-- briefly unavailable database queues work rather than returning 503.
--
-- ── Why pgmq and not Kafka / Redis Streams / SKIP LOCKED ────────────────────
--
--   Kafka          The right answer once you have several *independent*
--                  real-time consumers, partitioned ordering, or teams who
--                  should not share a database. None of those are true here,
--                  and it costs brokers, a schema registry, partition tuning
--                  and a consumer-lag dashboard to find out.
--   Redis Streams  A second datastore to run, secure and explain — pointless
--                  when the database we already have ships a queue.
--   SKIP LOCKED    Hand-rolling visibility timeouts, retry counting and
--                  archival that pgmq already implements and tests.
--   pgmq           SQS semantics inside Postgres. Zero new infrastructure,
--                  which was the exact constraint that deferred this.
--
-- ── The important distinction ───────────────────────────────────────────────
-- This queue is a BUFFER, not the log. It carries events awaiting persistence
-- and its only consumer is the worker that writes them. `inference_events` is
-- the log — append-only, partitioned, immutable, UUIDv7-ordered — and that is
-- what any future consumer reads.
--
-- Kafka merges those two roles; keeping them separate is why deleting a
-- message after processing costs nothing. A second service does not lose data
-- when the worker consumes a message, because by then the data is durable.
-- ════════════════════════════════════════════════════════════════════════════

-- ── pgmq may not exist, and that must not be fatal ──────────────────────────
--
-- pgmq is not part of core Postgres. Supabase and the tembo images ship it;
-- stock `postgres:17-alpine` does not. A hard `CREATE EXTENSION` would make
-- this migration — and therefore the whole application — refuse to start on
-- any ordinary Postgres.
--
-- So the queue is optional infrastructure. When pgmq is absent the migration
-- succeeds without it, and the ingestion service detects that at boot and
-- falls back to `INGEST_SINK=direct` with a loud warning. Degrading to the
-- simpler path beats refusing to run.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgmq;

  -- pgmq.create() raises if the queue exists, so guard that too: migrations
  -- must be safe to re-run against a partly-provisioned database.
  BEGIN
    PERFORM pgmq.create('inference_events');
  EXCEPTION
    WHEN duplicate_table OR duplicate_object THEN NULL;
  END;

  RAISE NOTICE 'pgmq installed — INGEST_SINK=pgmq is available';
EXCEPTION
  WHEN undefined_file OR insufficient_privilege OR feature_not_supported THEN
    RAISE WARNING
      'pgmq is not available on this Postgres. The queue sink is disabled; '
      'INGEST_SINK=pgmq will fall back to direct writes. '
      'Use a pgmq-enabled image (Supabase, or quay.io/tembo/pg17-pgmq) to enable it.';
END
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- Queue depth, for the dashboard
-- ────────────────────────────────────────────────────────────────────────────
--
-- Depth alone is not the signal — a deep queue draining fast is healthy. The
-- number that matters is the AGE of the oldest unread message: that is
-- consumer lag, and it is what says the worker has stopped keeping up.
DO $$
BEGIN
  IF to_regnamespace('pgmq') IS NOT NULL THEN
    EXECUTE $view$
      CREATE OR REPLACE VIEW queue_health AS
      SELECT m.queue_name, m.queue_length, m.total_messages,
             m.oldest_msg_age_sec AS oldest_age_sec, m.newest_msg_age_sec
        FROM pgmq.metrics('inference_events') m
    $view$;
  END IF;
END
$$;
