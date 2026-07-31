-- ════════════════════════════════════════════════════════════════════════════
-- 001 — THE CHAT SIDE (OLTP)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Small, precise, frequently updated, and read one conversation at a time.
-- A filing cabinet of customer folders: you pull out one folder and read it.
--
-- This is the opposite access pattern to 002_telemetry.sql, which is why the
-- two are modelled, indexed and retained differently despite living in the
-- same database.
-- ════════════════════════════════════════════════════════════════════════════

-- gen_random_bytes(), used by uuidv7() below. gen_random_uuid() is core since
-- PG13 but the byte generator still lives in pgcrypto.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE conversation_status AS ENUM ('active', 'archived', 'deleted');
CREATE TYPE message_role        AS ENUM ('user', 'assistant', 'system');

-- ── UUIDv7 ──────────────────────────────────────────────────────────────────
-- Postgres 18 ships uuidv7() natively; Neon is on 17 at time of writing, so we
-- implement it. It is worth the 20 lines.
--
-- v4 is random, so every insert lands at a random leaf of the primary key's
-- B-tree: the index cannot stay in cache, pages split constantly, and write
-- throughput degrades as the table grows. v7 puts a millisecond timestamp in
-- the high bits, so inserts append to the right-hand edge like a bigserial
-- while staying globally unique and client-generatable.
--
-- Client-generatable is the requirement that rules out bigserial entirely: the
-- SDK must be able to mint an event_id *before* the row exists, because that id
-- is the idempotency key that makes at-least-once delivery safe.
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$
DECLARE
  unix_ts_ms bytea;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);

  -- 10 random bytes fill the remainder; then stamp version (7) and RFC 4122 variant.
  uuid_bytes := unix_ts_ms || gen_random_bytes(10);
  uuid_bytes := set_byte(uuid_bytes, 6, (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);
  uuid_bytes := set_byte(uuid_bytes, 8, (b'10'   || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);

  RETURN encode(uuid_bytes, 'hex')::uuid;
END
$$ LANGUAGE plpgsql VOLATILE;

-- ── conversations ───────────────────────────────────────────────────────────
CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id         text,
  title           text,
  status          conversation_status NOT NULL DEFAULT 'active',

  -- Denormalised counters. Maintained by trigger below.
  --
  -- The alternative — COUNT(*) against messages on every sidebar render — is a
  -- sequential scan per conversation per page load. This trades a few bytes and
  -- a trigger for turning the list query into a single index-only scan.
  message_count   integer NOT NULL DEFAULT 0,
  last_message_at timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Serves the sidebar: "my conversations, newest activity first".
-- Partial, because deleted rows are never listed and there is no reason to
-- carry them in the index.
CREATE INDEX conversations_list_idx
  ON conversations (user_id, last_message_at DESC NULLS LAST)
  WHERE status <> 'deleted';

-- ── messages ────────────────────────────────────────────────────────────────
CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

  -- Explicit ordering. Sorting by created_at would be wrong: two messages can
  -- share a millisecond, and "resume this conversation" must replay turns in
  -- exactly the order they happened or the model receives a corrupted history.
  seq             integer NOT NULL,

  role            message_role NOT NULL,
  content         text NOT NULL,
  token_count     integer,

  -- A streaming assistant message exists in the DB before it is finished, so
  -- an interrupted stream leaves a partial row rather than nothing at all.
  -- That is deliberate: a cancelled answer is still something the user saw.
  is_complete     boolean NOT NULL DEFAULT true,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT messages_seq_unique UNIQUE (conversation_id, seq)
);

-- "Load this conversation in order" — the resume path. The UNIQUE constraint
-- above already provides this index, so no second one is created.

-- ON DELETE CASCADE above means deleting a conversation deletes its messages.
-- Telemetry deliberately does NOT cascade — see the note in 002_telemetry.sql.

-- ── Keep the denormalised counters honest ───────────────────────────────────
-- In a trigger rather than in application code because there is more than one
-- writer (the chat route, the migration backfill, any future importer) and a
-- counter maintained in only some of the paths is worse than no counter.
CREATE OR REPLACE FUNCTION touch_conversation() RETURNS trigger AS $$
BEGIN
  UPDATE conversations
     SET message_count   = message_count + 1,
         last_message_at = GREATEST(COALESCE(last_message_at, NEW.created_at), NEW.created_at),
         updated_at      = now()
   WHERE id = NEW.conversation_id;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_touch_conversation
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION touch_conversation();
