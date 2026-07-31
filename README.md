# Ollive — inference logging & ingestion

A chatbot, and the observability pipeline watching it.

The chatbot is not the product. It is the instrumented workload — it exists so
the logging system has something real to observe. The product is everything
downstream of it: an SDK that captures every model call without being asked, a
pipeline that ingests those events without ever blocking the app, and a schema
that answers questions about them cheaply.

```
  browser ──► chat server ──► Anthropic / OpenAI
                   │
                   │ (out of band, non-blocking)
                   ▼
            ingestion service ──► Postgres ──► dashboards
```

---

## The headline

**Zero-code auto-instrumentation.** `examples/zero-code/app.mjs` contains no
telemetry code — no import from this project, no wrapper, no init call. Run it
twice:

```bash
node examples/zero-code/app.mjs
#   → dashboard shows nothing

node --import @ollive/sdk/register examples/zero-code/app.mjs
#   → an event appears, with model, latency, TTFT and token counts
```

Same file. `git diff` between the runs is empty. Events from the second carry
`captured_by='loader'`, so which mechanism produced them is verifiable from the
data rather than taken on trust.

---

## Quick start

**Prerequisites:** Node ≥ 22, a Postgres 14+ database, and at least one model
API key.

```bash
git clone <repo> && cd ollive
npm install
cp .env.example .env        # fill in DATABASE_URL and ANTHROPIC_API_KEY
npm run build
npm run db:migrate
npm run db:verify           # asserts the schema landed as designed
npm run dev                 # chat on :3000, ingestion on :3001
```

Then open **http://localhost:3000** to chat and
**http://localhost:3000/dashboard** for the charts.

To give the dashboards shape without spending money on real calls:

```bash
node examples/load/generate.mjs --events 500 --errors 0.07 --hours 6
```

That generator also asserts two guarantees on every run — idempotent replay, and
that one malformed event cannot fail a batch of fifty. It is how the second of
those bugs was found.

### Supabase users — read this

Supabase's **direct** connection host (`db.<ref>.supabase.co`) publishes only an
IPv6 record, so it is unreachable from any network without IPv6 — which includes
most of Windows. Use the **Session pooler** connection string instead
(`aws-N-<region>.pooler.supabase.com:5432`, username `postgres.<project-ref>`).

Session mode specifically, not Transaction mode on 6543: the migration runner
takes a session-scoped `pg_advisory_lock` so two deploys cannot migrate at once,
and transaction mode supports neither session-scoped advisory locks nor prepared
statements.

---

## What's here

| Package | Role |
|---|---|
| `packages/contracts` | The Zod event schema. One definition serves as the SDK's payload type, the ingestion validator, and the published JSON Schema. |
| `packages/config` | Environment parsed and validated once at boot, in per-service slices. |
| `packages/sdk` | Instrumentation: the `Proxy` wrapper, the loader hook, the bounded transport, PII redaction. |
| `packages/providers` | Thin adapters over each vendor SDK, normalised onto one interface and one error taxonomy. |
| `packages/ingest-core` | Validate → enrich → persist. Framework-free, so one implementation serves two entry points. |
| `packages/db` | Schema, migrations, repositories, metrics queries. |
| `apps/web` | Chat UI, dashboards, and the deployed ingestion route. |
| `apps/ingest` | Standalone Fastify ingestion service. |
| `examples/zero-code` | The proof. |
| `examples/load` | Traffic generator and pipeline assertions. |

---

## Architecture

Full detail in **[docs/architecture.md](docs/architecture.md)**. The essentials:

### Two write paths with opposite contracts

| | Chat path | Telemetry path |
|---|---|---|
| Timing | Synchronous | Asynchronous |
| User waiting | Yes | No |
| Must be correct | Yes, transactional | Losing 0.1% is survivable |
| May block the other | — | **Never** |

Nearly every decision below follows from that split.

> **If the logging system fails, the chat must still work.** `enqueue()` cannot
> throw, cannot block, and cannot await — it writes to an array and returns.
> Everything else happens off the caller's path.

### Ingestion flow

1. The SDK's `Proxy` observes a model call: provider, model, params, prompt.
2. Tokens stream back. The wrapper **passes every chunk through untouched**
   while counting — a stream can only be consumed once, so instrumentation that
   reads it would starve the application.
3. On completion it records TTFT, total latency, token usage and finish reason,
   redacts PII, and drops one event into a bounded in-memory queue — **returning
   immediately**.
4. The queue flushes as a batch (50 events or 200 ms, whichever first).
5. Ingestion authenticates, validates **per event**, re-scans for PII, prices the
   call, and persists.
6. A single SQL statement inserts and updates the per-minute rollup together.
7. Dashboards read the rollup, never raw events.

### Three details worth pointing at

**Usage arrives at both ends of a stream.** Anthropic reports input tokens in
`message_start` — before a single output token exists — and output tokens in
`message_delta` near the end. Code that reads usage only when the stream closes
records **zero input tokens on every call**, and nobody notices until the cost
report. See `packages/sdk/src/instrument/shims.ts`.

**The rollup aggregates the `INSERT … RETURNING`, not the input batch.** So a
duplicate delivery contributes nothing to the aggregates. That is how
at-least-once *delivery* becomes exactly-once *aggregation*, and it is why the
pipeline can retry freely without drifting a single chart. See
`packages/db/migrations/004_ingest.sql`.

**The partition key is the event's own `startedAt`, never `now()`.** If it were
`now()`, a retried event would land under a different primary key, insert twice,
and silently double your traffic numbers.

---

## Schema design

Full DDL with the reasoning inline in `packages/db/migrations/`.

The core observation is that this system stores **two different kinds of data**:

| | Chat data | Telemetry |
|---|---|---|
| Shape | Small, relational, edited | Huge, append-only, never updated |
| Read as | One conversation at a time | Aggregates over millions of rows |
| Analogy | A filing cabinet of customer folders | A security camera tape |

A filing cabinet and a camera tape want different storage, so they get it — even
inside one database.

| Decision | Why |
|---|---|
| **RANGE partitioning by month** on `inference_events` | "Last 24 hours" touches one partition. Retention is `DROP TABLE`, instant — deleting 10M rows takes minutes and holds locks. |
| **BRIN, not B-tree, on the time column** | The table is append-only and physically time-ordered, which is exactly BRIN's assumption. Kilobytes where a B-tree over 10M rows is hundreds of megabytes. |
| **UUIDv7 primary keys** | Client-generatable (the SDK mints the idempotency key *before* the row exists, which rules out `bigserial`) while still appending to the index edge, unlike random v4. |
| **Previews, not full payloads** | Full text lives in `messages`. Duplicating it would widen the table every dashboard query scans, for no analytical benefit. |
| **Cost frozen with a `pricing_version`** | Computing cost at query time means a vendor price change silently rewrites last quarter's spend. Receipts don't change when the shop does. |
| **Money as `numeric`, never float** | `0.30000000000000004` in a billing column is not a rounding error you get to explain away. |
| **Mergeable histograms for percentiles** | You cannot average two p95s. Fixed buckets add element-wise, so a day's p95 comes from 1,440 rollup rows without touching raw data. `percentile_cont` is exact but needs every row in memory and cannot roll up. |
| **Both `client_ts` and `ingested_at`** | Their difference is pipeline lag — the metric that says the system is falling behind before users notice. It also exposes client clock skew. |
| **Telemetry `ON DELETE SET NULL`, not CASCADE** | Deleting a conversation shouldn't erase the record that the system served 400 requests that hour. GDPR erasure is a *different* requirement, handled by `redact_conversation()`, which nulls content and keeps metrics. Erasure and amnesia are not the same thing. |
| **`cancelled` is a status, not an error** | A user pressing Stop is not a failure. Counting it as one inflates the error-rate panel with deliberate behaviour, and a dashboard that cries wolf gets ignored. |

---

## Tradeoffs made

**Postgres for both halves, not Postgres + ClickHouse.** ClickHouse is what
Langfuse and Signoz actually run for the telemetry side, and it would be faster
at p99 over months of data. It is also a second datastore to run, seed, back up
and explain, for demo-scale volume. The repositories are already split
(`ChatRepository` / `EventRepository`), so **at roughly 10M events/day I would
move `inference_events` to ClickHouse — a swap of one adapter, not a rewrite.**

**Hand-rolled adapters, not the Vercel AI SDK.** The AI SDK would have saved
hours and has a built-in telemetry hook. But this project's headline is
auto-instrumenting *someone else's* SDK; wrapping a facade we control would
prove nothing about the hard case.

**Histogram buckets over exact percentiles.** Bucketed p95 differs from
`percentile_cont` by roughly 15% on the current data. The dashboard **shows both
side by side** rather than hiding the gap — that difference is the price of
mergeability, and a cache you can check against its source is worth more than
one you have to trust.

**Regex PII detection, not Presidio or an LLM classifier.** Structured
identifiers — cards, emails, keys — are what patterns are good at and what
actually hurts when leaked. Free-form PII (names, addresses) needs an NER model,
which means a heavy dependency or a network call on the hot path of a logging
library. This does not cover that case, and says so rather than implying it does.

**Batching accepts bounded loss.** If the process is killed with a full buffer,
up to one flush interval of events is gone. Right for telemetry, wrong for money
— that would need a disk-backed write-ahead log before acknowledging.

**Containers deferred, not designed out.** No container runtime was available on
the build machine, and spending five of roughly sixteen hours on a toolchain
install would have cost the dashboards and PII redaction. Every service already
reads config from the environment, holds no local state, exposes distinct
liveness and readiness probes, and drains on SIGTERM — the four things that
actually make a service container-ready. See
**[docs/containerization.md](docs/containerization.md)**, which is explicit that
those manifests are **designed, not executed**. Shipping a `compose.yaml` that
has never been run would be worse than not shipping one.

---

## What I'd improve with more time

1. **An event bus.** The `EventBus` seam exists but ingestion writes straight to
   Postgres. A Postgres `SKIP LOCKED` queue needs no extra infrastructure and
   would decouple ingest latency from database latency; Kafka is the answer only
   once volume justifies partition management.
2. **Actually run the containers.** Install Docker, verify `compose.yaml`, then
   k3d. The seams are in; only the verification is missing.
3. **Cost accuracy for OpenAI.** Anthropic prices are from the published list;
   the OpenAI figures are marked unverified in `pricing.ts` rather than quietly
   presented as fact.
4. **A rollup reconciliation job.** Nightly recompute of yesterday from raw, with
   an alert on >0.1% drift. About 40 lines, and it turns "the rollup is probably
   right" into "the rollup is verified".
5. **Sampling.** At high volume you do not want every event. Head-based sampling
   with a forced-keep on errors and slow calls is the standard answer.
6. **Summarising context window.** The current sliding window forgets the
   beginning of long conversations. Summarising evicted turns preserves the gist
   at the cost of one extra model call.
7. **Multi-tenancy.** A single `INGEST_API_KEY` today. The `ingest_api_keys`
   table shape is sketched in the migration comments.

---

## Verification

Not "it compiled" — these were run against live Postgres and live model APIs.

```bash
npm test                    # 45 tests across contracts, config, sdk
npm run db:verify           # schema assertions against the real database
```

| Check | Result |
|---|---|
| Migrations against Postgres 17.6 | 4 applied, partitions + BRIN + functions verified |
| Histogram percentiles | 90 fast + 10 slow → p50 183ms, p95 11.5s |
| Empty histogram | Returns `NULL`, not 0 — idle must not read as "instant" |
| Multi-turn context | Told it "teal" in turn 1, asked in turn 2, got "Teal" |
| End-to-end telemetry | `latency=4136ms ttft=3179ms in=42 out=129 cost=$0.0034` |
| PII | Card + email in a prompt → `[EMAIL:b6397b20]`, `[CARD:71f5989d]` in the DB |
| Idempotency | Replayed 50 events → `accepted=0 duplicates=50` |
| DLQ isolation | 1 malformed + 1 valid → `accepted=1 deadLettered=1` |
| Multi-provider | Live OpenAI 429 classified as `rate_limit`, retryable |
| **Zero-code loader** | **0 events without the flag, 1 with it** |
| Health probes | `/healthz` dependency-free, `/readyz` reports the database |

---

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Chat on :3000, ingestion on :3001 |
| `npm run build` | Build every package |
| `npm test` | Run all tests |
| `npm run db:migrate` | Apply migrations (idempotent) |
| `npm run db:verify` | Assert the deployed schema |
| `npm run db:reset` | Drop and recreate (refuses in production) |
