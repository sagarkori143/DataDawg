# Deployment

Four things exist; one is already deployed.

| # | What | Where | Why there |
|---|---|---|---|
| 1 | **Postgres + pgmq** | **Supabase** ✅ already live | Managed, and pgmq is a Postgres extension so the queue rides along |
| 2 | **`apps/web`** (chat) | Vercel | Next.js SSR + SSE streaming. Vercel is built for exactly this |
| 3 | **`apps/dashboard`** | Vercel | Same, and it deploys independently from a separate project |
| 4 | **`apps/ingest`** | Railway / Fly / a VM — **not Vercel** | Runs a long-lived queue worker. Serverless freezes the process the moment a response returns, so the worker would never execute |

That last row is the only interesting constraint, and it drives the choice below.

---

## Two paths

### Path A — Vercel only (free, ~20 min)

Skip `apps/ingest`. The chat app already carries an in-app ingestion route at
`/api/v1/events`, backed by the same `@ollive/ingest-core` — **this is exactly
why that dual entry point exists.**

```
  browser ──► Vercel: web ──► Anthropic
                  │
                  └──► /api/v1/events (same deployment) ──► Supabase
                                                              ▲
              Vercel: dashboard ──────────────────────────────┘
```

Set `INGEST_SINK=direct`. No queue, no worker — the endpoint awaits the insert.

**Honest tradeoff:** the pgmq event-bus path is not exercised in production. It
still works locally and is verified there, and the README says so rather than
implying the deployed system uses it.

### Path B — Vercel + Railway (~40 min, ~$5/mo)

Deploy all three. `apps/ingest` runs on a real VM with the worker draining.

```
  browser ──► Vercel: web ──► Anthropic
                  │
                  │ SDK → INGEST_ENDPOINT
                  ▼
           Railway: ingest ──► pgmq ──► worker ──► Supabase
                                                      ▲
              Vercel: dashboard ─────────────────────┘
```

Set `INGEST_SINK=pgmq`, `INGEST_WORKER=true`.

**This is the architecture the docs describe**, running for real. Worth the $5
if the demo is being reviewed.

---

## Vercel setup (both paths)

Two **separate projects**, same repo, different Root Directory. Push once, both
redeploy.

### Project 1 — chat

| Setting | Value |
|---|---|
| Repository | `sagarkori143/DataDawg` |
| **Root Directory** | `apps/web` |
| Framework | Next.js (auto-detected) |
| Build Command | leave default — Vercel runs `vercel-build`, which builds the workspace packages first |
| Install Command | leave default |
| **Include files outside root directory** | **ON** — required; the app imports `packages/*` |

Environment variables:

```
DATABASE_URL          <supabase SESSION pooler, port 5432>
ANTHROPIC_API_KEY     sk-ant-...
OPENAI_API_KEY        sk-proj-...        (optional)
INGEST_API_KEY        <a long random string>
INGEST_ENDPOINT       Path A: https://<this-app>.vercel.app/api
                      Path B: https://<ingest>.up.railway.app
INGEST_SINK           Path A: direct     Path B: pgmq
NEXT_PUBLIC_DASHBOARD_URL   https://<dashboard>.vercel.app
```

### Project 2 — dashboard

| Setting | Value |
|---|---|
| **Root Directory** | `apps/dashboard` |
| **Include files outside root directory** | **ON** |

Environment variables:

```
DATABASE_URL          <same, or a read-only role — see below>
DASHBOARD_TOKEN       <a long random string>
NEXT_PUBLIC_CHAT_URL  https://<chat>.vercel.app
```

> **Chicken-and-egg:** the two `NEXT_PUBLIC_*` URLs reference each other's
> deployment. Deploy both, then add the URLs and redeploy. They are optional —
> unset simply hides the cross-link.

---

## Railway setup (Path B only)

Deploy from the GitHub repo. `railway.json` at the root already selects the
Dockerfile builder, so there is no build or start command to configure — Railway
builds `docker/Dockerfile.ingest` with the repo root as context.

Environment variables — exactly these five:

```
DATABASE_URL      <supabase session pooler>
INGEST_API_KEY    <same value as the web project — they must match>
INGEST_HOST       ::
INGEST_SINK       pgmq
INGEST_WORKER     true
```

**Do not set `INGEST_PORT`.** Railway injects `PORT`, the config falls back to
it, and pinning `INGEST_PORT` to anything else silently breaks routing.

### The two things that actually cost an hour here

Both produce the same symptom — Railway reports **"service unavailable"** while
the deploy log says the server started perfectly. That combination is the tell:
the process is fine, the platform is knocking on the wrong door.

**1. `0.0.0.0` is not enough — Railway's network is IPv6.**

```
0.0.0.0  = every IPv4 address     ← Railway's proxy can't reach it
::       = every address, v4 + v6 ← what it needs
```

Hence `INGEST_HOST=::`. The log tells you which one you got: `[::]:8080` is
right, `127.0.0.1:8080` plus a private IPv4 is not.

**2. The port the app binds must equal the port the domain targets.**

Settings → Networking → the domain's target port. If the app listens on 10000
and the domain targets 8080, every health check fails against a completely
healthy process. Verify from inside the container rather than guessing:

```sh
echo "PORT=$PORT"
wget -qO- http://localhost:$PORT/healthz
```

A `{"status":"ok"}` on one port and `Connection refused` on the other localises
it in one command.

**Health check path: `/healthz`, not `/readyz`.** Readiness checks the database,
so a brief Supabase blip would fail the deploy and roll back a perfectly good
release. Liveness is dependency-free precisely so it can answer this question.

---

## Before the first deploy

**Run the migrations once.** Vercel does not run them, and the app will fail on
first request without the schema:

```bash
npm run db:migrate
npm run db:verify
```

Against the same `DATABASE_URL` the deployment uses.

---

## After deploying — verify, don't assume

```bash
# 1. health
curl https://<chat>.vercel.app/api/healthz
curl https://<dashboard>.vercel.app/api/healthz

# 2. chat streams
curl -N -X POST https://<chat>.vercel.app/api/chat \
  -H 'Content-Type: application/json' -d '{"message":"say OK"}'

# 3. THE ONE THAT MATTERS — did the event actually land?
#    Serverless freezes the process when the response returns. If after()
#    is not working, chat looks perfect and the dashboard stays empty.
#    This is the single most likely production-only failure.
```

Then open the dashboard and confirm the call count moved.

---

## The read-only role for the dashboard

Optional but recommended once the dashboard is public. The dashboard cannot
write and cannot read chat content — enforced by Postgres, not by application
code:

```sql
CREATE ROLE ollive_readonly LOGIN PASSWORD '<strong-password>';
GRANT CONNECT ON DATABASE postgres TO ollive_readonly;
GRANT USAGE ON SCHEMA public TO ollive_readonly;
GRANT SELECT ON inference_events, inference_rollup_1m, dlq TO ollive_readonly;
-- deliberately NOT granted: conversations, messages
```

Then give the dashboard project a `DATABASE_URL` using that role.

---

## Known limits of this deployment

Stated rather than discovered later:

- **Path A does not exercise pgmq.** The queue works and is verified locally;
  the deployed path uses `direct`.
- **Vercel's function timeout** is 10s on Hobby, 60s on Pro. A long streamed
  response can exceed the Hobby limit — the stream is cut, and the SDK records
  it as `cancelled` with partial tokens. Correct behaviour, but visible.
- **Connection budget.** Each Vercel function instance opens its own pool. A
  traffic spike spawns many instances and can exhaust Supabase's 60
  connections. `DATABASE_POOL_MAX=2` helps; PgBouncer (transaction mode, port
  6543) is the real fix — and note migrations must stay on session mode
  because the runner takes a session-scoped advisory lock.
