# DataDawg

A chatbot, and the observability system watching it.

[![CI](https://github.com/sagarkori143/DataDawg/actions/workflows/ci.yml/badge.svg)](https://github.com/sagarkori143/DataDawg/actions/workflows/ci.yml)
[![Docker](https://github.com/sagarkori143/DataDawg/actions/workflows/docker.yml/badge.svg)](https://github.com/sagarkori143/DataDawg/actions/workflows/docker.yml)

## Live

| | Link |
|---|---|
| **Chat** | https://data-dawg-web.vercel.app |
| **Dashboard** | https://data-dawg-dashboard.vercel.app |
| **Ingestion API** | https://datadawg-ingest-production.up.railway.app |

Send a message in the chat, then open the dashboard. The call shows up with its
latency, token counts and cost.

Health, if you want to check before clicking:

```bash
curl https://data-dawg-web.vercel.app/api/healthz
curl https://data-dawg-dashboard.vercel.app/api/healthz
curl https://datadawg-ingest-production.up.railway.app/healthz
```

The ingestion service sleeps when idle, so the first request can take a few
seconds to wake it.

---

## What we are building

Teams ship LLM features and then cannot see them. How slow the model is, how much
it costs, how often it fails. You usually find out when the bill arrives or when
a user complains.

So this repo has two halves.

The **chatbot** is the workload. It streams answers from Anthropic or OpenAI,
remembers earlier turns, and lets you stop a reply, list past conversations and
resume one.

The **observability system** is the actual product. It records every model call,
what it cost, how long it took, when the first token arrived, and what kind of
failure it was if it failed. Then it puts that on a dashboard.

The part worth reading the code for: the chat app writes no logging code at all.

```bash
node examples/zero-code/app.mjs
#   nothing appears on the dashboard

node --import @ollive/sdk/register examples/zero-code/app.mjs
#   an event appears, with model, latency, TTFT and token counts
```

Same file both times. The diff between those runs is empty.

---

## Running it

One command, if you have Docker:

```bash
git clone https://github.com/sagarkori143/DataDawg.git && cd DataDawg
cp .env.example .env        # ANTHROPIC_API_KEY is the only required value
docker compose up
```

That brings up Postgres with pgmq, runs migrations, then starts all three
services. Chat on 3000, ingestion on 3001, dashboard on 3002.

Without Docker, you need Node 22+, a Postgres 14+ database and one model API key:

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL and ANTHROPIC_API_KEY
npm run build
npm run db:migrate
npm run db:verify           # asserts the schema landed as designed
npm run dev
```

To give the dashboard some shape without spending money on real calls:

```bash
node examples/load/generate.mjs --events 500 --errors 0.07 --hours 6
```

> **Supabase users:** use the Session pooler connection string, not the direct
> host. The direct host publishes only an IPv6 record and is unreachable from
> most Windows networks. Details in [docs/deployment.md](docs/deployment.md).

---

## The components

```
   browser
      |
      v
   chat app :3000  ------------------->  Anthropic / OpenAI
      |  (SDK inside this process)
      |
      |  batched events, out of band
      v
   ingest :3001  --->  queue  --->  worker  --->  Postgres
                                                     ^
                                    dashboard :3002 --+
```

Three services, one database, and a library that lives inside the chat app.

| Piece | What it is |
|---|---|
| `apps/web` | Chat UI, chat API, and a copy of the ingestion route for serverless deploys |
| `packages/sdk` | The instrumentation library. Not a service |
| `apps/ingest` | Standalone ingestion service and queue worker |
| `packages/db` | Schema, migrations, repositories |
| `apps/dashboard` | The charts. Separate deployable, own database connection |
| `packages/contracts` | The event schema, defined once and used by everyone |
| `packages/providers` | Thin adapters over each vendor SDK |
| `packages/ingest-core` | Validate, enrich, deliver. No framework, so two entry points share it |

---

## Component 1: the chat app

**What it does.** Takes a message, loads the recent history, calls the model, and
streams tokens back over SSE.

**Inside.** Server Sent Events rather than WebSocket, because token streaming only
goes one way. SSE is plain HTTP, so it passes through every proxy unchanged, and
cancelling is just closing the connection.

The assistant row is written to the database as an empty placeholder *before* the
stream starts. That way a cancelled or crashed stream still leaves a record of
what the user saw. When the browser disconnects, that AbortSignal is passed all
the way down to the vendor SDK, so pressing Stop actually stops the upstream call
instead of leaving it running and billing with nobody listening.

**Talks to.** The model provider directly. The database for conversations and
messages. Nothing else. It never calls the ingestion service itself, the SDK does
that in the background.

**Scale concern.** Long conversations grow the context window forever. There is a
sliding window that keeps the recent turns and reports how many it dropped. The
better answer is summarising what gets evicted, which costs one extra model call
and is not built yet.

---

## Component 2: the SDK

**What it does.** Records every model call without the application asking it to.

**Inside.** It wraps the vendor client in a `Proxy`. Reading `client.messages.create`
returns a wrapped function instead of the real one. The call sites never change.

Streaming is where this gets difficult. A stream can only be read once, so an
implementation that reads chunks in order to count them leaves the application
with nothing. The wrapper works like a turnstile instead: every chunk passes
straight through to the caller and gets counted on the way past.

It also forwards the iterator's `return()`. When a consumer breaks out of a
`for await` loop early, that is the only signal that the caller walked away.
Without it the vendor's socket leaks and an abandoned stream never emits an event.

There is a second way in, which needs no code change at all:

```bash
node --import @ollive/sdk/register app.js
```

That installs a Node module hook before the app loads. When the app imports
`@anthropic-ai/sdk`, the hook hands back a small synthetic module that re exports
the real library with only its client class wrapped. The app believes it received
the real thing. This is what Datadog and OpenTelemetry do.

Every event records which mechanism captured it, so the claim is checkable from
the data rather than taken on trust.

**Talks to.** The ingestion endpoint over HTTP, in batches, on a background timer.

**Scale concern.** Sending one request per model call means 1000 extra round trips
per second at 1000 calls per second, purely for logging. So events are batched at
50 events or 200ms, whichever comes first. The buffer has a hard limit, and when
it fills it drops the **oldest** events and counts how many it dropped. During an
incident the newest events describe the incident.

The rule the whole design rests on: **logging is best effort, the chat is not.**
`enqueue()` cannot throw, cannot block, cannot await. If the SDK breaks, the chat
keeps working.

---

## Component 3: the ingestion service

**What it does.** Receives batches, checks them, prices them, hands them off.

**Inside.** Four steps. Authenticate with a constant time bearer compare, since
`===` leaks length and prefix through timing. Validate the envelope and then each
event separately, so one malformed event goes to the dead letter queue while the
other 49 land. Re scan for PII as a safety net in case an old SDK is deployed
somewhere. Freeze the cost against a pricing version, because computing cost at
query time means a vendor price change silently rewrites last quarter's spend.

Then it returns **202 Accepted**, not 200 OK. 200 would claim the write is
complete. 202 says received, and it is my responsibility now, which stays true
once a queue sits behind the endpoint.

**Talks to.** The database, through one of three sinks chosen by config:

| Sink | Behaviour |
|---|---|
| `direct` | Awaits the insert. Simplest, and correct at low volume |
| `pgmq` | Enqueues and returns. A database blip queues work instead of returning 503 |
| `kafka` | Throws on purpose. The interface exists so the migration path is visible in code |

**Scale concern.** The service holds no state, so you run more of it. The real
question is the sink. `direct` makes ingest latency equal to database latency.
`pgmq` decouples them and lives inside Postgres, so it needs no extra
infrastructure at all.

Kafka is not a throughput decision here, it is a fan out decision. Right now there
is exactly one consumer, the persist worker, so the queue is a buffer rather than
a bus. Kafka starts earning its cost at four or more independent real time
consumers, when replication slots become a liability, or when consumers in other
teams should not hold database credentials.

---

## Component 4: the database

**What it stores.** Two kinds of data that want opposite things.

| | Chat data | Telemetry |
|---|---|---|
| Shape | Small, relational, edited | Huge, append only, never updated |
| Read as | One conversation at a time | Aggregates over millions of rows |
| Like | A filing cabinet | A security camera tape |

So they get different treatment, even inside one database.

**Inside.** `inference_events` is partitioned by month, so "last 24 hours" touches
one partition and retention is a `DROP TABLE` rather than a delete that takes
minutes and holds locks. The time column uses a BRIN index, not a B tree, because
the table is append only and physically time ordered, which is exactly BRIN's
assumption. Kilobytes instead of hundreds of megabytes.

Primary keys are UUIDv7. The SDK mints the idempotency key before the row exists,
which rules out `bigserial`, and v7 still appends to the index edge unlike random
v4.

The insert and the rollup update happen in **one statement**. There is no second
job that can fall behind. And the rollup aggregates the `INSERT ... RETURNING`
rather than the input batch, so a duplicate delivery contributes nothing to the
totals. That is how at least once delivery becomes exactly once aggregation.

**Scale concern.** Around 50M events a day, partition maintenance stops being
worth it and `inference_events` should move to ClickHouse. `EventRepository` is
already separate from `ChatRepository`, so nothing above that layer knows where
events live. It is one adapter, not a rewrite.

---

## Component 5: the dashboard

**What it does.** Latency, throughput, cost and error breakdown, by model and by
provider.

**Inside.** It never reads raw events. It reads `inference_rollup_1m`, which holds
one row per minute per provider per model, so a full day of charts is about 1,400
rows instead of millions.

Percentiles come from fixed bucket histograms that can be merged. You cannot
average two p95 values, which is a bug that stays invisible for a long time.
Histograms add element wise, so any range's percentile comes from the minute rows.
The cost is accuracy bounded by bucket width, which the dashboard shows next to
the exact figure rather than hiding.

**Talks to.** Postgres only. It shares no runtime with the chat app, so killing
the dashboard leaves chat untouched.

**Scale concern.** It can be pointed at a read replica, or given a read only role
that cannot see chat content at all. The SQL for that role is in
[docs/deployment.md](docs/deployment.md).

---

## How they work together

One request, end to end:

1. The browser posts a message. The chat app saves it, loads recent history, and
   writes an empty assistant row.
2. The SDK's proxy sees the model call open. A span starts.
3. Tokens stream to the browser. Every chunk passes through the wrapper and is
   counted on the way.
4. The stream ends. The span records TTFT, total latency, tokens, finish reason,
   redacts PII, and drops one event into an in memory buffer. It returns
   immediately.
5. The buffer flushes as a batch at 50 events or 200ms.
6. Ingestion authenticates, validates each event, prices it, and puts the whole
   batch on the queue as one message. It returns 202.
7. The worker picks it up and writes it. One statement inserts the rows and
   updates the per minute rollup.
8. The dashboard reads the rollup.

Steps 1 to 3 are the user's path and they are synchronous. Steps 4 to 8 are the
telemetry path and nothing in them can block the user.

---

## How it is deployed today

| Piece | Where | Why there |
|---|---|---|
| Postgres and pgmq | Supabase | Managed, and pgmq is a Postgres extension so the queue rides along |
| [`apps/web`](https://data-dawg-web.vercel.app) | Vercel | Next.js with SSE streaming, which is what Vercel is built for |
| [`apps/dashboard`](https://data-dawg-dashboard.vercel.app) | Vercel | Same, and it deploys independently from a separate project |
| [`apps/ingest`](https://datadawg-ingest-production.up.railway.app) | Railway | Runs a long lived queue worker. Serverless freezes the process the moment a response returns, so the worker would never run |

The deployed system runs the queue path, not the simpler direct one. Readiness
reports it:

```bash
$ curl https://datadawg-ingest-production.up.railway.app/readyz
{"status":"ok","database":true,"queueLagSec":0,"worker":"in-process"}
```

`queueLagSec` is the age of the oldest unprocessed message. It is the number that
says the pipeline is falling behind before anyone notices on a chart.

**There is no container for the SDK, and there never will be.** It is a library
that runs inside the chat app's process. Wherever `apps/web` runs, the SDK is
already there. That is the whole point of it being a wrapper rather than a
sidecar or an agent.

Serverless needed one accommodation. When a response returns, the platform
freezes the process, so a 200ms batch timer never fires and every buffered event
is silently lost. The transport drops its batch size to 1 on serverless, and the
route flushes inside `after()`, which runs in the window between response sent
and execution suspended.

### Kubernetes

The manifests are in [k8s/](k8s/), split into a base and a laptop overlay. They
cover the full stack: a Postgres StatefulSet, a migration Job, the ingest API and
the queue worker as separate Deployments, web, dashboard, Services and probes.

**They have not been applied to a live cluster.** The development machine has
7.4 GB of RAM, and a kind control plane wants about 2 GB before a single
application pod is scheduled. Docker Desktop's cluster failed to initialise twice
on this hardware.

So, precisely:

| | Status |
|---|---|
| Manifests render through kustomize, both variants, no warnings | verified |
| All three images build and are tagged locally | verified |
| Health probes, readiness degradation, SIGTERM shutdown | verified, in CI, against the real containers |
| Pods scheduled and running on a cluster | **not verified** |

The parts a cluster depends on are tested. The apply is not, and saying otherwise
would be the kind of claim this README is trying to avoid.

---

## What happens when you push a commit

Two workflows fire on every push to `main`.

### Workflow 1: CI

[.github/workflows/ci.yml](.github/workflows/ci.yml)

```
checkout -> npm ci -> npm run build -> npm test -> build the web app
```

`npm run build` typechecks every package through project references. That is the
check that catches a contract change breaking a consumer, which is the whole
reason the event schema lives in one package.

The tests touch no database and no model API, so CI needs no secrets and cannot
fail because of somebody else's rate limit.

### Workflow 2: Docker

[.github/workflows/docker.yml](.github/workflows/docker.yml)

Three jobs, in order.

**build** runs three times in parallel, once for `web`, `dashboard` and `ingest`.
Each builds its Dockerfile with the repo root as context, since the apps import
`packages/*` and a context scoped to the app directory cannot see them. Images
are pushed to GHCR and tagged with the branch, the commit SHA, and `latest`. The
npm install layer is cached, so only a `package.json` change makes it slow.

**smoke** proves the image actually runs, which building it does not. It starts
the ingest container with a database URL that points nowhere and asserts three
things:

- `/healthz` returns 200 even with no database, because liveness must not depend
  on anything
- `/readyz` returns 503, because readiness must report degraded
- `docker stop` triggers a clean shutdown, which only works because the container
  runs Node as PID 1 rather than npm, so SIGTERM actually reaches the handler

If both endpoints returned 200 the liveness and readiness split would be
decorative, and so would the Kubernetes probes above them.

**compose** runs the command a reviewer would run, from a clean checkout:

```
docker compose up -d --build
  -> migrations run
  -> db:verify inside the container, asserting the schema and that pgmq is live
  -> all five health endpoints answer
  -> POST a real event at the ingestion service
  -> poll Postgres until that exact event_id appears
```

That last step is the assertion worth having. It walks the entire pipeline: HTTP,
validate, price, queue, worker, database. A green build here means the stack
works, not merely that a Dockerfile compiles.

### Then what

Vercel and Railway both watch the repo and redeploy on their own. Vercel builds
two projects from the same commit, one rooted at `apps/web` and one at
`apps/dashboard`. Railway builds `docker/Dockerfile.ingest` and health checks
`/healthz`, not `/readyz`, so a brief database blip cannot roll back a perfectly
good release.

Migrations are not run by any of them. They are run once, deliberately, against
the target database. The runner takes a session scoped advisory lock so two
deploys cannot migrate at the same time.

---

## Tradeoffs

**Postgres for both halves, not Postgres plus ClickHouse.** ClickHouse would be
faster at p99 over months of data, and it is what Langfuse and Signoz actually
run. It is also a second datastore to run, back up and explain, at a volume that
does not need it. The seam is already in place for when it does.

**Hand written adapters, not the Vercel AI SDK.** The AI SDK has a telemetry hook
and would have saved hours. But the headline here is instrumenting *someone
else's* SDK. Wrapping a facade we control would prove nothing about the hard case.

**Bucketed percentiles instead of exact ones.** Bucketed p95 differs from
`percentile_cont` by roughly 15% on the current data. The dashboard shows both,
because a cache you can check against its source beats one you have to trust.

**Regex PII detection, not an NER model.** Cards, emails and keys are what
patterns are good at and what actually hurts when leaked. Names and addresses need
a model, which means a heavy dependency on the hot path of a logging library. This
does not cover that case and says so.

**Batching accepts bounded loss.** Kill the process with a full buffer and up to
one flush interval of events is gone. Right for telemetry, wrong for money.

---

## What I would improve

1. **Apply the Kubernetes manifests on a real cluster.** They are written and they
   render, but they have never scheduled a pod. A small cloud cluster or a
   machine with more memory would close this in an afternoon, and the only thing
   I expect to find is image pull configuration, since the local tags assume a
   shared image store.
2. **Measure the pgmq ceiling instead of estimating it.** The current threshold is
   reasoned, not measured, and the real limit is dead tuples and autovacuum on the
   queue table rather than raw throughput.
3. **A rollup reconciliation job.** Nightly recompute of yesterday from raw, with
   an alert past 0.1% drift. About 40 lines, and it turns "the rollup is probably
   right" into "the rollup is verified".
4. **Sampling.** At high volume you do not want every event. Head based sampling
   with a forced keep on errors and slow calls is the standard answer.
5. **Summarising context window.** The current sliding window forgets the start of
   long conversations.
6. **Multi tenancy.** One ingest key today. The table shape is sketched in the
   migration comments.

---

## Verification

These were run against live Postgres and live model APIs, not just compiled.

```bash
npm test                    # 45 tests across contracts, config, sdk
npm run db:verify           # schema assertions against the real database
```

| Check | Result |
|---|---|
| Zero code loader | 0 events without the flag, 1 with it |
| End to end telemetry | `latency=4136ms ttft=3179ms in=42 out=129 cost=$0.0034` |
| Idempotency | Replayed 50 events, got `accepted=0 duplicates=50` |
| DLQ isolation | 1 malformed plus 1 valid gave `accepted=1 deadLettered=1` |
| PII | Card and email in a prompt became `[EMAIL:b6397b20]`, `[CARD:71f5989d]` |
| Empty histogram | Returns NULL, not 0, because idle must not read as instant |
| Multi provider | Live OpenAI 429 classified as `rate_limit`, retryable |
| Health probes | `/healthz` dependency free, `/readyz` reports the database |

---

## More detail

- [docs/architecture.md](docs/architecture.md) ingestion flow, failure handling, scaling
- [docs/auto-instrumentation.md](docs/auto-instrumentation.md) how the three capture layers work
- [docs/deployment.md](docs/deployment.md) hosting, connection limits, the read only role
- [docs/containerization.md](docs/containerization.md) images and orchestration
