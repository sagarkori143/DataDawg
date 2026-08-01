#!/usr/bin/env node
import { closePool, query } from '../pool.js'

/**
 * `npm run db:verify`
 *
 * Asserts the schema landed the way it was designed, not merely that the
 * migrations exited zero. Partitioning, index *types*, and the histogram maths
 * are the parts most likely to be silently wrong — a BRIN index that quietly
 * came out a B-tree still works, it just throws away the reason it was chosen.
 */

let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

try {
  console.log('\nTables')
  const { rows: tables } = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  )
  const names = new Set(tables.map((t) => t.table_name))
  for (const t of ['conversations', 'messages', 'inference_events', 'inference_rollup_1m', 'dlq']) {
    check(t, names.has(t))
  }

  console.log('\nPartitioning')
  const { rows: parts } = await query<{ child: string }>(
    `SELECT c.relname AS child
       FROM pg_inherits i
       JOIN pg_class c   ON c.oid = i.inhrelid
       JOIN pg_class p   ON p.oid = i.inhparent
      WHERE p.relname = 'inference_events'
      ORDER BY 1`,
  )
  check(
    'inference_events is partitioned',
    parts.length >= 2,
    parts.map((p) => p.child).join(', '),
  )
  check(
    'default overflow partition exists',
    parts.some((p) => p.child.endsWith('_overflow')),
    'catches rows from a badly skewed client clock',
  )

  console.log('\nIndex types')
  const { rows: idx } = await query<{ indexname: string; am: string }>(
    `SELECT i.relname AS indexname, a.amname AS am
       FROM pg_class i
       JOIN pg_index x  ON x.indexrelid = i.oid
       JOIN pg_class t  ON t.oid = x.indrelid
       JOIN pg_am a     ON a.oid = i.relam
      WHERE t.relname = 'inference_events'`,
  )
  const brin = idx.find((i) => i.indexname.includes('time_brin'))
  check('time index is BRIN, not btree', brin?.am === 'brin', `got ${brin?.am ?? 'missing'}`)

  console.log('\nHistogram percentiles')
  // 100 observations: 90 fast, 10 slow. p50 must land in the fast band and p95
  // in the slow one — if the bucket maths were inverted or off by one, these
  // two assertions are what catches it.
  const { rows: pct } = await query<{ p50: number; p95: number; p99: number }>(
    `WITH h AS (
       SELECT histogram_sum(latency_histogram_of(v)) AS hist
         FROM (
           SELECT 120 AS v FROM generate_series(1, 90)
           UNION ALL
           SELECT 9000 FROM generate_series(1, 10)
         ) s
     )
     SELECT histogram_percentile(hist, 0.50) AS p50,
            histogram_percentile(hist, 0.95) AS p95,
            histogram_percentile(hist, 0.99) AS p99
       FROM h`,
  )
  const { p50, p95, p99 } = pct[0]!
  check('p50 in the fast band', p50 >= 100 && p50 <= 250, `p50=${p50?.toFixed(0)}ms`)
  check('p95 in the slow band', p95 >= 4000 && p95 <= 15000, `p95=${p95?.toFixed(0)}ms`)
  check('p99 >= p95 (monotonic)', p99 >= p95, `p99=${p99?.toFixed(0)}ms`)

  const { rows: empty } = await query<{ v: number | null }>(
    `SELECT histogram_percentile(array_fill(0, ARRAY[11]), 0.95) AS v`,
  )
  check(
    'empty histogram returns NULL, not 0',
    empty[0]!.v === null,
    'no traffic must not read as "instant"',
  )

  console.log('\nFunctions')
  for (const fn of ['ingest_events', 'redact_conversation', 'ensure_events_partition', 'uuidv7']) {
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname = $1`,
      [fn],
    )
    check(fn, rows[0]!.n > 0)
  }

  console.log('\nUUIDv7 is time-ordered')
  // Time-ordering is the whole reason v7 was chosen over v4: ascending ids
  // append to the right-hand edge of the B-tree instead of scattering across
  // it. If this ever regresses, the index degrades silently.
  //
  // The original implementation used a millisecond timestamp only, so ids
  // minted inside one millisecond were ordered by their random tail — a coin
  // flip. Migration 006 moved 12 bits to sub-millisecond precision (~244ns).
  // Both checks below would have failed against the old version.
  const first = await query<{ id: string }>(`SELECT uuidv7()::text AS id`)
  await new Promise((r) => setTimeout(r, 5))
  const second = await query<{ id: string }>(`SELECT uuidv7()::text AS id`)

  check(
    'ids minted 5ms apart sort ascending',
    first.rows[0]!.id < second.rows[0]!.id,
    'index locality depends on this',
  )

  // The real test: 500 ids minted back to back, no sleep at all.
  //
  // This is the batch-insert case — 50 events land inside the same
  // millisecond — and it is precisely where the original millisecond-only
  // implementation gave no ordering whatsoever. With sub-millisecond
  // precision (migration 006) they strictly increase.
  const { rows: batch } = await query<{ ordered: boolean; n: number }>(
    `WITH ids AS (SELECT n, uuidv7()::text AS id FROM generate_series(1, 500) n)
     SELECT bool_and(id > prev) AS ordered, count(*)::int AS n
       FROM (SELECT id, lag(id) OVER (ORDER BY n) AS prev FROM ids) t
      WHERE prev IS NOT NULL`,
  )
  check(
    '500 ids minted back-to-back are strictly increasing',
    batch[0]?.ordered === true,
    'the batch-insert case — same millisecond, still ordered',
  )

  console.log(failures === 0 ? '\nSchema verified.\n' : `\n${failures} check(s) FAILED.\n`)
  if (failures > 0) process.exitCode = 1
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}\n`)
  process.exitCode = 1
} finally {
  await closePool()
}
