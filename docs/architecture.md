# Architecture notes

Ingestion flow, logging strategy, scaling, and failure-handling assumptions.

---

## 1. Ingestion flow

```
  ┌──────────────────────────────────────────────────────────────┐
  │ CHAT SERVER (apps/web)                                       │
  │                                                              │
  │  POST /api/chat                                              │
  │    ├─ load last N turns from Postgres      ← context window  │
  │    ├─ persist the user's message                             │
  │    ├─ create an EMPTY assistant row        ← see §1.1        │
  │    └─ withContext({ conversationId, messageId }, …)          │
  │         └─ adapter.stream(…)                                 │
  │              └─ instrumented Anthropic client                │
  │                   ├─ span opens, stopwatch starts            │
  │                   ├─ chunks pass THROUGH, counted            │
  │                   └─ span closes → transport.enqueue()       │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  bounded queue
                                  │  flush at 50 events or 200 ms
                                  ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ INGESTION (apps/ingest :3001, or /api/v1/events when deployed)│
  │   1. authenticate      constant-time bearer compare           │
  │   2. validate          envelope, then EACH EVENT separately   │
  │   3. enrich            re-scan PII · price · stamp server ts  │
  │   4. deliver           EventSink: direct | pgmq | kafka       │
  │   → 202 Accepted                                              │
  └───────────────────────────────┬──────────────────────────────┘
                                  │
              ┌───────────────────┴───────────────────┐
              │ direct                          pgmq  │
              ▼                                       ▼
      insert + rollup (one CTE)            pgmq queue ──► worker
              │                                              │
              └──────────────────┬───────────────────────────┘
                                 ▼
                   inference_events  ← THE LOG
                                 │
                                 ▼
                   dashboards (read rollups) · future consumers

  The queue is a BUFFER; the table is the LOG. A future service reads the
  table (or takes a logical replication slot), never the queue — so the
  worker deleting a message costs nothing.
```

### 1.1 Why the assistant row is created before the stream starts

So a cancelled or crashed stream still leaves a record of what the user saw. An
answer someone read half of is not the same as no answer, and the telemetry row
needs something to point at.

### 1.2 Why `202`, not `200`

`200` claims the write is complete. `202` says "received, and it is my
responsibility now" — which stays true when an event bus is inserted behind the
endpoint later.

### 1.3 Two entry points, one implementation

All the logic lives in `packages/ingest-core` and takes a parsed body, returning
a result — no `Request`, no `Response`, no router.

- **`apps/ingest`** (Fastify, port 3001) — a real separate process. This is what
  proves the SDK genuinely serialises events and crosses a network boundary,
  rather than calling a function in the same process and calling it a pipeline.
- **`apps/web/api/v1/events`** — ten lines calling the same core. This is what
  deploys, because serverless platforms have no long-lived processes.

Same code, two entry points, no duplication.

---

## 2. Logging strategy

### 2.1 Three capture layers

| Layer | Integration | Status |
|---|---|---|
| L1 manual | `withContext()` + explicit span | available |
| **L2 Proxy** | `instrument(new Anthropic())` — one word, one place | **primary** |
| **L3 loader** | `node --import @ollive/sdk/register` — nothing at all | **shipped** |

L2 is a `Proxy` over the vendor client: reading `.messages.create` returns a
wrapped function. The application's call sites do not change.

L3 installs a `module.registerHooks` hook *before* the app loads, substituting a
synthetic module that re-exports the vendor's client class wrapped in a
`construct` trap. The application believes it received the real library. This is
what Datadog and OpenTelemetry do; Node 22.15+ makes it one synchronous hook
instead of the `require-in-the-middle` + `import-in-the-middle` pair.

Every event records which layer produced it, so the claim is checkable from the
data.

**Known limitation, stated rather than hidden:** the loader matches module
*specifiers*. A bundler that inlines the vendor SDK leaves no specifier, so under
Next.js the provider packages must sit in `serverExternalPackages` (they do). The
unambiguous proof is `examples/zero-code` under plain `node`.

### 2.2 Correlation without threading parameters

`AsyncLocalStorage`. The conversation ID is attached when the request arrives;
code at any depth, in any async continuation, reads it without being handed
anything. Two concurrent requests each see their own context — a module-level
variable would interleave them and attribute one user's tokens to another.

### 2.3 What the stream wrapper must not do

Consume the stream. A stream can only be read once, so an implementation that
reads chunks to count them starves the application. The wrapper is a turnstile:
every chunk passes straight through, counted on the way past. `packages/sdk/src/instrument/proxy.ts`.

The iterator's `return()` is forwarded deliberately — when a consumer breaks out
of a `for await` early, that is the only signal that the caller walked away.
Without it the vendor's socket leaks; without observing it, an abandoned stream
never emits an event.

### 2.4 Transport

- **Batch** at 50 events or 200 ms. At 1,000 calls/sec, a request-per-event is
  1,000 extra round trips purely for logging; batching makes it ~20.
- **Bounded queue.** When full, drop the **oldest** and count them. During an
  incident the newest events describe the incident — dropping those to preserve
  history from before anything went wrong discards the evidence and keeps the
  boredom.
- **Backoff with jitter**: 1s, 2s, 4s, 8s. Without jitter every instance retries
  on the same schedule and re-kills the endpoint the moment it recovers.
- **401/403 trips a 60s circuit breaker.** A bad key will still be bad in eight
  seconds; retrying turns a clear config error into a slow mysterious one.
- **Serverless mode.** On a platform that freezes the process when the response
  returns, a 200 ms timer never fires. The transport drops its batch threshold to
  1 and the route flushes inside `after()`.

---

## 3. Scaling

### 3.1 Where it breaks first, in order

| Volume | Symptom | Response |
|---|---|---|
| ~1k events/day | none | — |
| ~1M/day | dashboards slow if they read raw | already fixed: they read rollups |
| ~10M/day | `inference_events` writes dominate | `INGEST_SINK=pgmq` (built); scale the worker out with `INGEST_WORKER=false` |
| ~50M/day | Postgres partition maintenance becomes a chore | **move `inference_events` to ClickHouse** |
| any | one process cannot flush fast enough | horizontal — the SDK is per-process, the endpoint is stateless |

The ClickHouse threshold is the one to name in review. `EventRepository` is
already separate from `ChatRepository`; nothing above that layer knows where
events live, so the migration is one adapter.

### 3.2 What makes the read path cheap

Dashboards never touch raw events. `inference_rollup_1m` holds one row per
(minute, provider, model), so 24 hours of charts is ~1,440 rows rather than
millions.

Percentiles come from **mergeable fixed-bucket histograms**. You cannot average
two p95s — a common and invisible bug. Adding two histograms element-wise yields
the histogram of the union, so any range's percentile derives from minute rows.
The cost is accuracy bounded by bucket width, which the dashboard displays beside
the exact `percentile_cont` figure rather than concealing.

### 3.3 What makes the write path cheap

- One statement per batch: 50 events cost one round trip and one transaction.
- BRIN on the time column — near-free to maintain on insert.
- Partial index on errors only; failures are a small fraction of rows.
- Rollup updated in the same statement, so there is no second job to fall behind.

### 3.4 Retention

Numbers, because "we'd add retention" is not a policy:

- raw events **90 days**, dropped a partition at a time
- rollups **400 days** (tiny)
- DLQ **30 days**

---

## 4. Failure handling

Assumption throughout: **telemetry is best-effort; the chat is not.**

| Failure | Detection | Behaviour | Data loss |
|---|---|---|---|
| Ingestion down | connection error / 5xx | backoff retry; queue caps; drop oldest and **count** | only on long outage, and counted |
| Database down | insert throws | ingestion returns 503; SDK retries | none — retry is safe |
| Batch delivered twice | `event_id` conflict | `ON CONFLICT DO NOTHING`; rollup reads `RETURNING`, so aggregates are untouched | none |
| One malformed event | per-event validation | that event → DLQ; the other 49 land | that event, replayable |
| Whole envelope malformed | envelope validation | entire payload → DLQ with body intact | none, replayable |
| Poison event | 5 attempts | DLQ + `POST /v1/dlq/replay` | none |
| Oversized body | 413 at the edge | rejected, non-retryable | that batch |
| Bad ingest key | 401 | non-retryable; 60s breaker | the misconfiguration window |
| Provider 429 / timeout | vendor error class | classified, surfaced, counted | none |
| Client disconnects mid-stream | `AbortSignal` + iterator `return()` | `cancelled` event **with partial tokens and real TTFT** | none |
| Process killed, buffer full | — | up to one flush interval | ≤ 200 ms of events |
| Deploy / SIGTERM | signal handler | drain, bounded at 5s, then exit | none in the normal case |
| Clock skew | `client_ts > ingested_at` | server timestamp orders; both stored | none |
| Rollup drift | (not built) | nightly reconcile vs raw — see README | none; rollups are rebuildable |
| **SDK itself throws** | try/catch at every boundary | **swallowed; chat continues** | those events only |

That last row is the design's load-bearing claim. `enqueue()` cannot throw,
cannot block, cannot await. `instrument()` returns the client unchanged if it
cannot understand it. `Span.emit()` swallows its own errors. An unconfigured
`INGEST_ENDPOINT` produces a no-op transport and one startup warning — which is
the first thing a reviewer hits when they clone without reading.

---

## 5. Security

- Bearer token on ingestion, compared in constant time — `===` leaks length and
  prefix through timing.
- Body size capped at 4 MB, rejected at the edge with 413.
- PII redacted **in the SDK before transmission** and **again at ingestion**. The
  first means PII never crosses the network; the second means a stale SDK is
  still covered by a policy you can update centrally.
- Redaction replaces rather than deletes: `[EMAIL:a1b2c3d4]` is a salted digest
  prefix, so "how many distinct users hit this error" stays answerable without
  storing anything readable.
- `redact_conversation()` handles erasure requests without destroying metrics.
- `.env` is gitignored; nothing reads `process.env` outside `packages/config`.
