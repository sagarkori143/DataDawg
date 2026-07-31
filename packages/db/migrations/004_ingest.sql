-- ════════════════════════════════════════════════════════════════════════════
-- 004 — THE INGEST PATH
-- ════════════════════════════════════════════════════════════════════════════
--
-- One statement that takes a whole batch and does three things atomically:
--
--   1. inserts the events, ignoring ones already seen
--   2. updates the per-minute rollup using ONLY the rows that were genuinely
--      new
--   3. reports how many of each
--
-- Point 2 is the load-bearing one. The rollup aggregates the RETURNING output
-- of the insert, not the input batch — so a duplicate delivery contributes
-- nothing to the aggregates. That is how at-least-once *delivery* becomes
-- exactly-once *aggregation*, and it is why the pipeline can retry freely
-- without corrupting a single chart.
--
-- Doing it in one round trip also means a batch of 50 events costs one network
-- hop, not 50, and one transaction rather than 50 chances to half-apply.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION ingest_events(batch jsonb)
RETURNS TABLE (inserted bigint, duplicates bigint) AS $$
DECLARE
  total bigint;
  ins_count bigint;
BEGIN
  SELECT jsonb_array_length(batch) INTO total;

  WITH input AS (
    SELECT * FROM jsonb_to_recordset(batch) AS x(
      event_id           uuid,
      created_at         timestamptz,
      conversation_id    uuid,
      message_id         uuid,
      session_id         text,
      user_id            text,
      provider           text,
      model              text,
      operation          text,
      streamed           boolean,
      captured_by        text,
      status             text,
      finish_reason      text,
      error_type         text,
      error_message      text,
      latency_ms         integer,
      ttft_ms            integer,
      input_tokens       integer,
      output_tokens      integer,
      cache_read_tokens  integer,
      cache_write_tokens integer,
      cost_usd           numeric,
      pricing_version    text,
      temperature        real,
      max_tokens         integer,
      message_count      integer,
      input_preview      text,
      output_preview     text,
      redaction_hits     smallint,
      client_ts          timestamptz,
      sdk_version        text,
      schema_version     smallint,
      attributes         jsonb
    )
  ),
  ins AS (
    INSERT INTO inference_events (
      event_id, created_at, conversation_id, message_id, session_id, user_id,
      provider, model, operation, streamed, captured_by,
      status, finish_reason, error_type, error_message,
      latency_ms, ttft_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_usd, pricing_version,
      temperature, max_tokens, message_count,
      input_preview, output_preview, redaction_hits,
      client_ts, sdk_version, schema_version, attributes
    )
    SELECT
      i.event_id, i.created_at, i.conversation_id, i.message_id, i.session_id, i.user_id,
      i.provider, i.model, coalesce(i.operation, 'chat'), coalesce(i.streamed, false),
      coalesce(i.captured_by, 'proxy')::capture_layer,
      i.status::inference_status, i.finish_reason, i.error_type::inference_error_type, i.error_message,
      i.latency_ms, i.ttft_ms,
      i.input_tokens, i.output_tokens, i.cache_read_tokens, i.cache_write_tokens,
      i.cost_usd, i.pricing_version,
      i.temperature, i.max_tokens, i.message_count,
      i.input_preview, i.output_preview, coalesce(i.redaction_hits, 0),
      i.client_ts, i.sdk_version, coalesce(i.schema_version, 1), coalesce(i.attributes, '{}'::jsonb)
    FROM input i
    -- The idempotency guard. A replayed batch lands here and is silently
    -- absorbed; nothing downstream can tell the difference, which is the point.
    ON CONFLICT (event_id, created_at) DO NOTHING
    RETURNING
      created_at, provider, model, status, streamed,
      latency_ms, ttft_ms, input_tokens, output_tokens, cost_usd
  ),
  agg AS (
    SELECT
      date_trunc('minute', created_at)          AS bucket,
      provider,
      model,
      count(*)                                  AS calls,
      count(*) FILTER (WHERE status = 'error')     AS errors,
      count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
      count(*) FILTER (WHERE streamed)             AS streamed_calls,
      sum(latency_ms)::bigint                   AS sum_latency_ms,
      coalesce(sum(ttft_ms), 0)::bigint         AS sum_ttft_ms,
      count(ttft_ms)                            AS ttft_count,
      coalesce(sum(input_tokens), 0)::bigint    AS input_tokens,
      coalesce(sum(output_tokens), 0)::bigint   AS output_tokens,
      coalesce(sum(cost_usd), 0)                AS cost_usd,
      histogram_sum(latency_histogram_of(latency_ms)) AS hist_latency,
      histogram_sum(latency_histogram_of(ttft_ms))    AS hist_ttft
    FROM ins
    GROUP BY 1, 2, 3
  ),
  roll AS (
    INSERT INTO inference_rollup_1m AS r (
      bucket, provider, model,
      calls, errors, cancelled, streamed_calls,
      sum_latency_ms, sum_ttft_ms, ttft_count,
      input_tokens, output_tokens, cost_usd,
      hist_latency, hist_ttft
    )
    SELECT
      bucket, provider, model,
      calls, errors, cancelled, streamed_calls,
      sum_latency_ms, sum_ttft_ms, ttft_count,
      input_tokens, output_tokens, cost_usd,
      hist_latency, hist_ttft
    FROM agg
    -- Incremental: batches for the same minute arrive continuously, so the
    -- rollup accumulates rather than being recomputed.
    ON CONFLICT (bucket, provider, model) DO UPDATE SET
      calls          = r.calls          + EXCLUDED.calls,
      errors         = r.errors         + EXCLUDED.errors,
      cancelled      = r.cancelled      + EXCLUDED.cancelled,
      streamed_calls = r.streamed_calls + EXCLUDED.streamed_calls,
      sum_latency_ms = r.sum_latency_ms + EXCLUDED.sum_latency_ms,
      sum_ttft_ms    = r.sum_ttft_ms    + EXCLUDED.sum_ttft_ms,
      ttft_count     = r.ttft_count     + EXCLUDED.ttft_count,
      input_tokens   = r.input_tokens   + EXCLUDED.input_tokens,
      output_tokens  = r.output_tokens  + EXCLUDED.output_tokens,
      cost_usd       = r.cost_usd       + EXCLUDED.cost_usd,
      hist_latency   = histogram_add(r.hist_latency, EXCLUDED.hist_latency),
      hist_ttft      = histogram_add(r.hist_ttft,    EXCLUDED.hist_ttft),
      updated_at     = now()
    RETURNING 1
  )
  SELECT count(*) INTO ins_count FROM ins;

  RETURN QUERY SELECT ins_count, total - ins_count;
END
$$ LANGUAGE plpgsql;

-- ────────────────────────────────────────────────────────────────────────────
-- GDPR erasure without amnesia
-- ────────────────────────────────────────────────────────────────────────────
--
-- 002 chose ON DELETE SET NULL so that deleting a conversation does not destroy
-- the operational record of the traffic it generated. That is right for
-- observability and insufficient for a data-subject erasure request, which is
-- about *content*, and a preview is content.
--
-- So the two are separated. This nulls every trace of what was said while
-- leaving latency, tokens and cost intact. Erasure and amnesia are different
-- requirements; conflating them means either failing the law or throwing away
-- your metrics, and neither is necessary.
CREATE OR REPLACE FUNCTION redact_conversation(target uuid)
RETURNS TABLE (messages_redacted bigint, events_redacted bigint) AS $$
DECLARE
  m bigint;
  e bigint;
BEGIN
  UPDATE messages SET content = '[redacted]' WHERE conversation_id = target;
  GET DIAGNOSTICS m = ROW_COUNT;

  UPDATE inference_events
     SET input_preview  = NULL,
         output_preview = NULL,
         user_id        = NULL,
         session_id     = NULL
   WHERE conversation_id = target;
  GET DIAGNOSTICS e = ROW_COUNT;

  UPDATE conversations
     SET title = '[redacted]', status = 'deleted', updated_at = now()
   WHERE id = target;

  RETURN QUERY SELECT m, e;
END
$$ LANGUAGE plpgsql;
