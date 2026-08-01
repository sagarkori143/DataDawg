-- ════════════════════════════════════════════════════════════════════════════
-- 006 — UUIDv7 with sub-millisecond precision
-- ════════════════════════════════════════════════════════════════════════════
--
-- 001 implemented uuidv7() with a millisecond timestamp and 74 random bits.
-- That is a valid UUIDv7, but it is **not monotonic within a millisecond**:
-- two ids minted in the same millisecond share their timestamp bits, so their
-- relative order is decided by the random tail — a coin flip.
--
-- Found by a schema check that asserted ordering and had been passing by luck.
--
-- ── Why it matters ──────────────────────────────────────────────────────────
-- Time-ordering is the entire reason for choosing v7 over v4: ids that ascend
-- append to the right-hand edge of the B-tree instead of scattering across it.
-- At batch-insert rates, 50 events land inside the same millisecond — exactly
-- the window where the old implementation gave no ordering at all.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
-- RFC 9562 §6.2 Method 3: use the 12 `rand_a` bits for sub-millisecond
-- precision instead of randomness. 12 bits divides a millisecond into 4096
-- parts — roughly 244ns of resolution — which is finer than the time it takes
-- to generate an id, so consecutive calls now strictly increase.
--
-- 62 random bits remain in rand_b. Collision probability stays negligible, and
-- ids remain unguessable.
--
-- ── Why a NEW migration rather than editing 001 ─────────────────────────────
-- This changes behaviour on databases where 001 already ran, so re-recording a
-- checksum would be wrong — the schemas genuinely differ. `CREATE OR REPLACE`
-- makes it safe: existing rows keep their ids, only newly minted ones improve.
--
-- (Contrast with 005, which was edited in place and repaired: making
-- `CREATE EXTENSION pgmq` tolerant changes nothing on a database where it had
-- already succeeded.)
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$
DECLARE
  ts_us  bigint;   -- epoch microseconds
  ts_ms  bigint;   -- the 48-bit millisecond field
  sub_ms int;      -- 0..4095 — sub-millisecond fraction, stored in rand_a
  bytes  bytea;
BEGIN
  ts_us  := (extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  ts_ms  := ts_us / 1000;

  -- Scale the leftover microseconds (0..999) across the 12 available bits.
  sub_ms := ((ts_us % 1000) * 4096 / 1000)::int;

  -- 48-bit big-endian millisecond timestamp, then 10 random bytes.
  bytes := substring(int8send(ts_ms) FROM 3) || gen_random_bytes(10);

  -- byte 6 : version (0111) in the high nibble, top 4 bits of sub_ms below it
  bytes := set_byte(bytes, 6, 112 | ((sub_ms >> 8) & 15));
  -- byte 7 : low 8 bits of sub_ms
  bytes := set_byte(bytes, 7, sub_ms & 255);
  -- byte 8 : RFC 4122 variant (10) in the top 2 bits, randomness below
  bytes := set_byte(bytes, 8, 128 | (get_byte(bytes, 8) & 63));

  RETURN encode(bytes, 'hex')::uuid;
END
$$ LANGUAGE plpgsql VOLATILE;

COMMENT ON FUNCTION uuidv7() IS
  'RFC 9562 UUIDv7 with 12 bits of sub-millisecond precision (~244ns). Monotonic for ids minted more than ~244ns apart, which is what B-tree append locality depends on.';
