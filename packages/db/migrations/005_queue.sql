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

CREATE EXTENSION IF NOT EXISTS pgmq;

-- pgmq.create() raises if the queue exists, so guard it: migrations must be
-- safe to re-run against a database that is already partly set up.
DO $$
BEGIN
  PERFORM pgmq.create('inference_events');
EXCEPTION
  WHEN duplicate_table OR duplicate_object THEN NULL;
END
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- Queue depth, for the dashboard
-- ────────────────────────────────────────────────────────────────────────────
--
-- Depth alone is not the signal — a deep queue draining fast is healthy. The
-- number that matters is the AGE of the oldest unread message: that is
-- consumer lag, and it is what says the worker has stopped keeping up.
CREATE OR REPLACE VIEW queue_health AS
SELECT
  m.queue_name,
  m.queue_length,
  m.total_messages,
  -- Seconds the oldest unprocessed message has been waiting.
  COALESCE(EXTRACT(EPOCH FROM (now() - m.oldest_msg_age_sec::text::interval)), 0)::int
    AS oldest_age_sec,
  m.newest_msg_age_sec
FROM pgmq.metrics('inference_events') m;

COMMENT ON VIEW queue_health IS
  'Consumer lag for the ingestion queue. Depth alone is not a problem; the age of the oldest unread message is.';
