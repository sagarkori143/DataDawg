# Inference Logging & Ingestion System — Design + Build Plan

> **What this document is.** The complete design for the Ollive take-home, written in plain
> language with diagrams, plus the technical detail underneath each decision. Read it top to
> bottom once to understand the system; keep it afterwards as interview notes. Every major
> choice lists the alternative that was rejected and why — that is what gets marked.

---

## Context

**The assignment:** build a lightweight inference logging and ingestion system for an LLM
application. Four required parts (chatbot, SDK/wrapper, ingestion pipeline, database) plus a
bonus list which the brief says **guarantees an interview** if completed.

**The state:** `c:\Users\DELL\OneDrive\Desktop\Ollive` is completely empty. Greenfield.
Node v24.18.0, npm 11.16.0, Python 3.12.10, Go 1.26.5, git 2.55 are installed.
**Docker, docker compose, kubectl, helm, minikube and kind are NOT installed.** WSL is present
but has no distribution. That constraint drives the deployment section.

**The intended outcome:** a GitHub repo that a reviewer can clone and run, whose README makes
every design tradeoff visible, and a 3–4 minute demo video.

### Locked decisions

| Decision | Choice |
|---|---|
| **Timeline** | **2 days (~20 working hours)** |
| **Hosting** | **Managed for now** — Vercel + Postgres. Containers were deferred, then built: images and `docker compose up` are verified on every push. Only k8s is outstanding. |
| **Providers** | **Anthropic + OpenAI.** Real multi-provider, and the OpenAI adapter covers the whole compatible family. |
| **Auto-instrumentation** | **The `--import` loader hook is CORE, not a stretch goal.** |

These cascade into everything below.

### The loader hook is core

It is the single highest-signal item in the whole assignment — the brief's own parenthetical
("*if you can create an architecture which can AUTO-INSTRUMENT*") points straight at it, and
almost nobody delivers it. It does **not** get cut.

It is also cheaper than it first looks, because it reimplements nothing:

- Phase 2 already builds `instrument()`. The loader is **only** the module-interception part.
- Node 24 ships **`module.registerHooks()`** — synchronous, built-in, and dramatically less
  code than the `require-in-the-middle` + `import-in-the-middle` pair this used to require.
- Scoped to exactly two specifiers (`@anthropic-ai/sdk`, `openai`), that is **~1.5 h**.

**The demo must be plain Node, not Next.js.** Next bundles server code, so the module specifier
the hook watches for may not survive bundling (mitigated by `serverExternalPackages`, but not
worth betting the demo on). `examples/zero-code/app.mjs` run with bare `node` is the honest
proof — and the better demo:

```bash
node examples/zero-code/app.mjs                        # → 0 events logged
node --import @ollive/sdk/register examples/zero-code/app.mjs   # → events appear
```

Same file. Zero lines of logging code in it. That diff **is** the deliverable.

### Containers: strings left open

> **Update — Docker shipped.** This section was written as a plan. Docker and Compose are now
> built and verified on every push; only k8s is still on paper. What follows is the reasoning
> that was recorded in advance, kept because the prediction it makes is the interesting part:
> *containerising this would be packaging, not rework.* That turned out to be true — the
> application code needed **zero** changes. The whole cost was three Dockerfiles, a
> `compose.yaml`, and one CI job. See the end of this section for what it actually took.

Docker and k8s are **deferred to a possible Day 3**, not designed out. The code is written
container-ready from commit one, so adding them later is packaging rather than rework:

| Seam | Why it matters for containers | Costs now |
|---|---|---|
| **All config via env**, validated once at boot with Zod | No baked paths or URLs; a container is the same binary with a different env | 20 min (`packages/config`) |
| **No local disk state** | Any replica can serve any request | free — it's already the design |
| **`/healthz` (liveness) + `/readyz` (readiness, checks DB)** | k8s probes need these *distinct*; also useful now | 15 min |
| **Graceful shutdown on SIGTERM** — stop accepting → flush telemetry buffer (5 s cap) → close pool | This is `terminationGracePeriodSeconds`. Needed for correctness regardless | 30 min |
| **Structured JSON logs to stdout**, never to files | What every container runtime collects | free |
| **`build` + `start` scripts per app** | Makes each Dockerfile ~6 lines | free |
| **Migrations as a standalone `npm run db:migrate`** | Becomes the compose `migrate` one-shot / k8s `Job` verbatim | free — already planned |

Total added cost: **~1 h**, all of which is independently justified. Plus
`docs/containerization.md` with the actual Dockerfile, `compose.yaml` and manifest sketches,
labelled **designed, not executed on this machine.**

**What NOT to do:** do not ship `compose.yaml` and k8s manifests as if they work. An
unverifiable claim is worse than a stated gap — a reviewer who runs `docker compose up` and
hits an error has learned something bad about everything else in the repo. Written-and-labelled
in `docs/` is honest; committed-and-implied-working is not.

**README wording:**

> *Containerisation is deferred, not omitted. Every service reads config from the environment,
> holds no local state, exposes liveness and readiness probes, and shuts down gracefully on
> SIGTERM — the four things that actually make a service container-ready. `docs/containerization.md`
> contains the Dockerfiles and compose topology; they are unverified because this machine had no
> container runtime, and I would rather label that than imply otherwise.*

That paragraph turns a gap into evidence of judgement — which is what the brief is grading.

### What it actually took

The prediction held. **No application code changed** — the seams above were the whole job.

| Predicted | Actual |
|---|---|
| "packaging rather than rework" | ✅ Zero application-code changes |
| `/healthz` + `/readyz` distinct | ✅ CI asserts **200 vs 503** with no database — if both answered 200 the split would be decorative |
| SIGTERM drains | ✅ `docker stop` exits cleanly, which is what proves `CMD ["node", …]` rather than `npm start` (npm is PID 1 and does not forward signals) |
| `db:migrate` becomes the compose one-shot | ✅ Verbatim, gated by `service_completed_successfully` |
| "~1 h" | Closer to 4, almost all of it in CI rather than in the Dockerfiles |

**The two things the plan did not anticipate:**

1. **`pgmq` is not in `postgres:17-alpine`.** The migration would have failed hard, so 005 was
   made tolerant — it warns and degrades to direct writes rather than aborting. That is correct
   behaviour for a managed database that cannot install extensions, but it introduced a new
   failure mode: the stack can come up *looking* green while never exercising the event bus. So
   CI now asserts `pgmq=true` explicitly, and compose uses an image that has it.
2. **The env var had to be set at the job level, not the step level.** Every `docker compose`
   invocation re-parses `compose.yaml`, and `${ANTHROPIC_API_KEY:?...}` is a *required*
   variable — so setting it only on the `up` step made `up` succeed and every later command
   fail during interpolation. It read like a broken stack rather than a missing variable, which
   is the expensive kind of error.

**Verification is on the runner, not this machine.** The build machine still has no container
runtime. That is arguably better than having installed one: the Dockerfiles are exercised from
a clean checkout on every commit, rather than working on one laptop.

---

# PART 1 — What you are actually building

Think of a **food delivery app**.

| Food delivery app | This project |
|---|---|
| You order food | User asks the chatbot a question |
| Restaurant cooks it | AI model writes the answer |
| App quietly records: which restaurant, how many minutes, price, did it fail | **Your SDK** records: which model, how many ms, how many tokens, did it fail |
| That data goes to the company's servers | **Ingestion service** |
| Servers save it | **Database** |
| Manager sees charts: "avg 32 min, 4% failed" | **Dashboard** |

So: **you are building a chatbot, plus a hidden system that watches the chatbot and makes
charts about it.**

You are building a miniature **Langfuse / Helicone / LangSmith**. Knowing that reframes
everything: **the chatbot is not the product.** It is the instrumented workload — it exists so
the observability system has something real to observe. Almost all the marks are on the other
three parts.

### The big picture

```
   ┌──────────┐
   │  BROWSER │   ← the user types here
   │  (chat)  │
   └────┬─────┘
        │  "What is Python?"
        v
   ┌─────────────────────────────────────┐
   │         CHAT SERVER                 │
   │                                     │
   │   ┌───────────────────────────┐     │
   │   │  YOUR SDK (the spy)       │     │
   │   │  wraps every AI call      │     │
   │   └────────────┬──────────────┘     │
   └────────────────┼────────────────────┘
        │           │
        │           │  (copy of the notes)
        v           v
   ┌─────────┐  ┌──────────────────┐
   │ AI API  │  │    INGESTION     │
   │ (Claude)│  │     SERVICE      │
   └─────────┘  └────────┬─────────┘
                         v
                   ┌───────────┐
                   │ DATABASE  │
                   └─────┬─────┘
                         v
                   ┌───────────┐
                   │ DASHBOARD │  ← charts
                   └───────────┘
```

### The one idea the whole design hangs on

There are **two write paths with opposite reliability contracts**:

| | Chat path | Telemetry path |
|---|---|---|
| Timing | Synchronous | Asynchronous |
| User waiting? | **Yes** | No |
| Must be correct? | **Yes, transactional** | Losing 0.1% is survivable |
| May block the other? | — | **Never** |

> **The rule that must never break: if the logging system fails, the chat must still work.**
> A logging system that takes down the app it is watching is worse than no logging system.

### One user message, end to end

1. Browser → `POST /api/chat` with a `conversationId`
2. Server loads the last N turns from Postgres — that is the "short conversational context"
3. Server calls the model **through an instrumented client**
4. SDK starts a timer; snapshots provider, model, params, prompt preview
5. Tokens stream back → SDK records **time-to-first-token**, keeps accumulating
6. Stream ends → total latency, input/output tokens, finish reason, computed cost
7. SDK redacts PII, builds one event, **drops it in an in-memory queue and returns immediately**
8. Queue flushes as a *batch* (50 events or 200 ms) → `POST /v1/events`
9. Ingestion validates, returns **202 Accepted**, publishes to the event bus
10. A worker reads, enriches, **idempotently** upserts to Postgres, ACKs
11. A rollup folds events into per-minute buckets
12. Dashboard reads the **rollups** → p95 latency, throughput, error rate

### Step by step

```
                        ┌─────────┐
                        │  START  │
                        └────┬────┘
                             v
                  ┌──────────────────────┐
                  │  User opens the app  │
                  └──────────┬───────────┘
                             v
                        ╱──────────╲
                       ╱  New chat  ╲
                  Yes ╱   or old?    ╲ No
          ┌──────────<                >──────────┐
          │           ╲              ╱           │
          v            ╲────────────╱            v
 ┌──────────────────┐                 ┌────────────────────────┐
 │ Make new         │                 │ Load old messages      │
 │ conversation ID  │                 │ from database (RESUME) │
 └────────┬─────────┘                 └───────────┬────────────┘
          │                                       │
          └───────────────────┬───────────────────┘
                              v
                  ┌───────────────────────┐
                  │  User types a message │
                  └───────────┬───────────┘
                              v
                  ┌───────────────────────┐
                  │  Save message to DB   │
                  └───────────┬───────────┘
                              v
              ╔═══════════════════════════════════╗
              ║  SDK STARTS THE STOPWATCH         ║
              ╚═══════════════════╤═══════════════╝
                                  v
                  ┌───────────────────────────┐
                  │  Send question to AI      │
                  └───────────┬───────────────┘
                              v
                         ╱──────────╲
                        ╱ Did it     ╲
                    No ╱   work?      ╲ Yes
          ┌───────────<                >──────────┐
          │            ╲              ╱           │
          v             ╲────────────╱            v
 ┌──────────────────┐                  ┌─────────────────────────┐
 │ Show error       │                  │ Answer appears word by  │
 │ status = FAILED  │                  │ word (STREAMING)        │
 └────────┬─────────┘                  │ status = OK             │
          │                            └────────────┬────────────┘
          └───────────────────┬─────────────────────┘
                              v
              ╔═══════════════════════════════════╗
              ║  SDK STOPS STOPWATCH.             ║
              ║  Writes one "note":               ║
              ║    • model = claude-sonnet-5      ║
              ║    • time  = 1,240 ms             ║
              ║    • tokens = 340 in / 890 out    ║
              ║    • status = OK / ERROR / CANCEL ║
              ║    • conversation ID              ║
              ╚═══════════════════╤═══════════════╝
                                  v
                  ┌───────────────────────────────┐
                  │ Hide private stuff (PII):     │
                  │ emails, phones, card numbers  │
                  └───────────────┬───────────────┘
                                  v
                  ┌───────────────────────────────┐
                  │ Drop note into a BUCKET       │
                  │ and MOVE ON IMMEDIATELY       │
                  │ (user is not waiting for this)│
                  └───────────────┬───────────────┘
                                  v
                             ╱──────────────╲
                            ╱ Bucket has 50  ╲
                        No ╱  notes, OR       ╲ Yes
              ┌───────────<   200ms passed?    >──────┐
              │            ╲                  ╱       │
              │             ╲────────────────╱        │
              │                                       v
              │                        ┌────────────────────────────┐
              │                        │ Send whole bucket to       │
              │                        │ INGESTION SERVICE          │
              │                        └─────────────┬──────────────┘
              │                                      v
              │                                 ╱──────────╲
              │                                ╱ Notes look ╲
              │                            No ╱   correct?   ╲ Yes
              │                     ┌────────<                >──────┐
              │                     │         ╲              ╱       │
              │                     v          ╲────────────╱        v
              │           ┌──────────────────┐              ┌──────────────────┐
              │           │ Put in DLQ       │              │ SAVE TO DATABASE │
              │           │ (bad-note box)   │              └────────┬─────────┘
              │           └──────────────────┘                       v
              │                                             ┌──────────────────┐
              │                                             │ Dashboard charts │
              │                                             │ update           │
              │                                             └────────┬─────────┘
              v                                                      v
         ╱────────────────────╲
        ╱   User sends another ╲
    Yes╱      message?          ╲ No
  ┌───<                          >───┐
  │    ╲                        ╱    │
  │     ╲──────────────────────╱     │
  │                                  v
  └──► back to "User types"     ┌─────────┐
                                │   END   │
                                └─────────┘
```

---

# PART 2 — The SDK (the "spy")

Normally your app talks straight to the AI. You want notes about every call, so you put a spy
in the middle. It is a **toll booth** — every car still gets through, but each one gets counted
on the way past.

**The whole question is: how do you get the toll booth onto the road?** Three ways, and the
answer is that you build all three because they share one core.

### Way 1 — Manual (the beginner way) ❌

```js
const start = Date.now()
const res  = await claude.messages.create({ ... })
log({ ms: Date.now() - start, ... })   // ← typed at every call site
```

Rejected as the primary mechanism: you must remember every time; a teammate's new call is
silently unlogged; a call inside a third-party library is unreachable. **Kept as an escape
hatch** (`withInference()`) for one-off spans.

### Way 2 — `Proxy` wrapping (the good way) ✅ **primary**

```js
const claude = instrument(new Anthropic())
//             ^^^^^^^^^^ one word, one time, one place
```

Every `claude.messages.create(...)` in the whole app is now recorded. **No call site changes.**

JavaScript's `Proxy` returns a fake object that behaves exactly like the real one. When your
code asks for `.messages.create`, the fake hands back a wrapped version: start stopwatch → call
the real one → stop stopwatch → write note.

**Analogy:** a receptionist in front of the manager's door. You still say "I need the manager."
She notes when you went in and when you came out. You never notice she is there.

```
   your code says:  claude.messages.create(...)
                          │
                          v
                 ┌──────────────────┐
                 │  PROXY (fake)    │  start stopwatch
                 └────────┬─────────┘
                          v
                 ┌──────────────────┐
                 │  REAL Anthropic  │
                 │  SDK             │
                 └────────┬─────────┘
                          v
                 ┌──────────────────┐
                 │  PROXY again     │  stop stopwatch → write note
                 └────────┬─────────┘
                          v
                   answer goes back
```

**Implementation notes:** the proxy must be *deep* (`client.messages` is itself proxied so
`.create` can be intercepted), and for streaming it must **wrap the async iterator without
consuming it** — pass each chunk straight through while counting. Non-consuming stream
proxying is the single subtlest piece of code in the project.

### Way 3 — Loader hook (the expert way) 🏆 **this is "AUTO-INSTRUMENT"**

Zero lines of app code change. Only how the app is started:

```bash
node --import @ollive/sdk/register  app.js
```

Node runs your code *before* the app loads. You intercept `import "@anthropic-ai/sdk"` and hand
back an **already-wrapped** module. The app believes it received the real library.

**Analogy:** you replace the manager's door with a revolving door that counts people — at 4am,
before anyone arrives. Nobody in the building ever finds out.

This is literally how **Datadog, New Relic and OpenTelemetry** work. On Node 24, try
`module.registerHooks()` first — it is dramatically less code than `require-in-the-middle` +
`import-in-the-middle`.

**Known limitation to state honestly in the README:** Next.js bundles server code, so the
module specifier the loader is watching for may not survive bundling. Fix by adding the
provider SDKs to `serverExternalPackages` in `next.config.ts`. Ship a plain
`examples/zero-code/app.mjs` run with bare `node` as the honest proof.

### Way 4 — `fetch` interceptor (widest net, secondary)

Hook global `fetch`/undici and you catch **every** provider that talks HTTP, including ones you
never wrote an adapter for. **Analogy:** instead of watching each door, put a camera on the
building's only exit gate. Downside: you see raw HTTP, not typed objects, so extracting token
usage is fiddly. Used as a **fallback layer** with span-brand de-duplication so a call already
captured by the Proxy is not counted twice.

### Way 5 — OpenTelemetry GenAI conventions (naming, not mechanism)

Do not adopt the full OTel SDK — too heavy for this. **Do** name your fields after the GenAI
semantic conventions (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`).
Costs nothing, and lets you say *"these events export to any OTel backend without remapping."*

### Layer summary

| Layer | Effort | Status | Value |
|---|---|---|---|
| L1 manual `withInference()` | free | in | escape hatch for one-off spans |
| **L2 `Proxy` — `instrument(client)`** | ~2 h | **core (Phase 2)** | **the workhorse** |
| **L3 `--import` loader** | **~1.5 h** | **core (Phase 9)** | **🏆 the differentiator** |
| L4 `fetch` interceptor | ~1 h | cut | breadth, but L2+L3 already cover both providers |

L3 costs only ~1.5 h **because it reuses L2 entirely** — the loader supplies interception, not
instrumentation. Node 24's built-in `module.registerHooks()` replaces what used to require both
`require-in-the-middle` and `import-in-the-middle`. If it fights the provider SDKs' dual
CJS/ESM builds, timebox at 2 h and fall back to that older pair.

L4 is dropped: with only two providers, both already covered by named adapters, a
transport-level net adds breadth you never exercise. It stays in `docs/` as a described
extension point — worth one paragraph, not one hour.

### Tricky bit 1 — streaming: when do you stop the stopwatch?

Record **three** numbers, not one:

```
   0ms          820ms                                  3,100ms
    │             │                                       │
    ├── request ──┤                                       │
    │             ├─ "Py" "thon" " is" " a" "lang"... ────┤
    │             │                                       │
    │         ★ TTFT                                  ★ TOTAL
    │        = 820 ms                                = 3,100 ms
    │     (how fast it FEELS)                       890 tokens
    │                                             → 287 tokens/sec
    │                                               ★ THROUGHPUT
```

- **TTFT** (time to first token) — how fast it *feels*. The most important latency number for
  a streaming UI, and the one most candidates forget to capture.
- **Total latency** — full duration.
- **Tokens/sec** — throughput.

Provider details: Anthropic reports input tokens in `message_start` and output tokens in
`message_delta`. OpenAI requires `stream_options: { include_usage: true }` or you get no usage
at all. The adapter normalises both.

### Tricky bit 2 — how does the spy know the conversation ID?

The spy lives deep in the code; the conversation ID lives at the web request. Threading it
through every function signature is ugly. Use **`AsyncLocalStorage`** — a hospital wristband.

```
   REQUEST ARRIVES
     │  snap on wristband: { conversationId: "abc-123", userId: "u9" }
     v
     ├── route handler
     │     └── some service function
     │           └── SPY   ← reads the wristband. Zero parameters passed.
     v
   REQUEST ENDS  → wristband removed automatically
```

The patient moves between rooms; every doctor reads the band without being told who it is.

### What one "note" looks like

```json
{
  "event_id":        "01J8X...",
  "conversation_id": "abc-123",
  "message_id":      "m-002",
  "provider":        "anthropic",
  "model":           "claude-sonnet-5",
  "status":          "ok",
  "started_at":      "2026-07-31T14:22:01.100Z",
  "ttft_ms":         820,
  "latency_ms":      3100,
  "input_tokens":    340,
  "output_tokens":   890,
  "tokens_per_sec":  287,
  "cost_usd":        0.0142,
  "input_preview":   "What is Python?",
  "output_preview":  "Python is a programming...",
  "error_type":      null
}
```

**Previews only, never full text.** The full text already lives in `messages`; duplicating it
makes the log table fat, and charts scan millions of rows.

### The spy's own flowchart

```
                    ┌──────────────────────────┐
                    │ App calls the AI         │
                    └────────────┬─────────────┘
                                 v
                    ┌──────────────────────────┐
                    │ Read wristband:          │
                    │   conversation ID, user  │
                    └────────────┬─────────────┘
                                 v
                    ┌──────────────────────────┐
                    │ Start stopwatch          │
                    │ Note: provider, model    │
                    └────────────┬─────────────┘
                                 v
                    ┌──────────────────────────┐
                    │ Call the REAL AI library │
                    └────────────┬─────────────┘
                                 v
                            ╱──────────╲
                           ╱ Streaming? ╲
                       No ╱              ╲ Yes
              ┌──────────<                >──────────┐
              │           ╲              ╱           │
              v            ╲────────────╱            v
   ┌────────────────────┐               ┌───────────────────────────┐
   │ Wait for full      │               │ Pass each word through,   │
   │ answer             │               │ mark TTFT on the FIRST one│
   └─────────┬──────────┘               │ keep counting the rest    │
             │                          └─────────────┬─────────────┘
             └──────────────┬─────────────────────────┘
                            v
                       ╱──────────╲
                      ╱  Finished  ╲
                     ╱   how?       ╲
        ┌───────────<                >───────────┐
        │            ╲              ╱            │
   ok   │             ╲────────────╱             │  error / user hit Stop
        v                    │                   v
 ┌──────────────┐            │           ┌──────────────────────┐
 │ status = ok  │            │           │ status = error       │
 │              │            │           │   or  = cancelled    │
 │              │            │           │ (still save partial  │
 │              │            │           │  tokens + time!)     │
 └──────┬───────┘            │           └──────────┬───────────┘
        └────────────────────┴──────────────────────┘
                             v
                 ┌───────────────────────────┐
                 │ Stop stopwatch            │
                 │ Read token counts         │
                 │ Calculate cost            │
                 └─────────────┬─────────────┘
                               v
                 ┌───────────────────────────┐
                 │ Hide private info (PII)   │
                 └─────────────┬─────────────┘
                               v
                 ┌───────────────────────────┐
                 │ Drop note in bucket       │
                 │ RETURN IMMEDIATELY        │
                 └─────────────┬─────────────┘
                               v
                 ┌───────────────────────────┐
                 │ Answer goes back to app   │
                 └───────────────────────────┘
```

Every branch of the spy is wrapped in "if this fails, swallow it and carry on."

---

# PART 3 — The bucket and the ingestion service

### Why a bucket? (batching)

1,000 chats/sec would mean 1,000 extra network calls/sec *just for logging*. So the spy drops
notes in a **postbox** and the van collects when **either 50 notes** pile up **or 200 ms**
pass — whichever first. 1,000 notes/sec becomes ~20 network calls/sec. **50× less traffic.**

**Honest tradeoff:** if the process is killed right now, whatever is still in the bucket is
lost. Worst case ≈ 200 ms of notes. Fine for telemetry; **not** fine for money or medical
records — those need a disk-backed write-ahead log first.

### What if the ingestion server is down?

| Choice | Verdict |
|---|---|
| Make the app wait | ❌ **Never.** Breaks the one rule — chat freezes because logging is sick. |
| Let the bucket grow forever | ❌ Memory fills, app crashes. Logging killed the app. |
| **Cap the bucket; when full drop the OLDEST and count them** | ✅ |

**Analogy:** a bin in a busy kitchen. When it is full you do not stop cooking, and you do not
let rubbish spill across the floor. You dump the oldest bag and write on the wall *"lost 340."*
That counter is reported, not hidden. Silent loss is the failure; counted loss is a metric.

**Retry with backoff and jitter:** 1s → 2s → 4s → 8s, plus a random fraction of a second.
Without jitter every instance retries at the *same* instant and re-kills the server the moment
it recovers — a **thundering herd**.

**Non-retryable vs retryable:** 4xx (bad payload, bad key) is non-retryable — drop it and fire
`onError`; retrying will never help. 5xx and network errors are retryable. A 401 additionally
trips a 60-second circuit breaker.

### The ingestion service's four jobs

```
   BUCKET of 50 notes arrives
            │
            v
   ┌────────────────────────────────┐
   │ 1. WHO ARE YOU?   (auth)       │   API key. Strangers can't dump junk in the DB.
   └───────────────┬────────────────┘
                   v
   ┌────────────────────────────────┐
   │ 2. IS THIS SHAPED RIGHT?       │   Zod. Is latency_ms a number? Is it 5MB of junk?
   │    (validate)                  │
   └───────────────┬────────────────┘
                   v
   ┌────────────────────────────────┐
   │ 3. CLEAN + ENRICH              │   Re-scan for PII. Compute cost. Stamp server time.
   └───────────────┬────────────────┘
                   v
   ┌────────────────────────────────┐
   │ 4. SAVE                        │
   └───────────────┬────────────────┘
                   v
           reply: 202 Accepted
```

`202 Accepted` means *"got it, I'll handle it"* — honest, because the write happens a moment
later. `200 OK` would be a lie. Small detail; graders notice it.

**Two timestamps, always.** The spy records when it *observed* the call; the server records
when it *received* the note. The gap is your pipeline lag. When that gap starts growing you are
drowning — and you know before your users do. It also detects client clock skew: if
`client_ts > server_ts`, trust the server and flag the row.

### The "don't save twice" problem (idempotency)

```
   SDK ──── sends 50 notes ────►  Ingestion   saved them ✅
   SDK ◄─── reply lost ✂ ──────  Ingestion
   SDK: "no reply, must have failed — resend"
   SDK ──── sends the SAME 50 ──►  Ingestion   saved TWICE ❌
```

Your dashboard now shows double the traffic. **Fix:** every note carries a unique `event_id`
generated by the spy; the DB rule is *"if this ID exists, ignore."*

**Analogy:** a bouncer with a guest list. Same name twice? In once.

The proper name for the pair: **at-least-once delivery + idempotent writes**. Exactly-once
*delivery* over a network is effectively impossible, so the industry stopped trying and made
double-saving harmless instead. Same outcome, far simpler.

### What is an "event bus"?

Slide a **conveyor belt** between ingestion and the database.

```
   Ingestion ──► BELT ──► Worker ──► Database
                          Worker ──►
                          Worker ──►
```

**Analogy — a restaurant kitchen:**

| Without a belt | With a belt |
|---|---|
| The waiter takes your order **and cooks it** | The waiter clips the order to a rail and walks away |
| Kitchen slow? Waiter stuck, nobody gets served | Chefs pull from the rail at their own pace |
| Busy night? Hire more waiters | Busy night? Add more chefs |

**What it buys:** ingestion answers fast regardless of DB speed; a DB outage means orders pile
up rather than vanish; spikes are absorbed by adding workers; and you can hang a *second*
consumer (live alerts) off the same belt later without touching the first.

**The honest truth:** at demo scale you do not need this. Direct-to-DB is fine. It is a listed
bonus and it is how real systems work, so it is worth having — cheaply.

| Option | Verdict |
|---|---|
| **Kafka** | The industrial answer. Extra services, slow start, partition management. **Overkill.** |
| **Redis Streams** | Consumer groups, at-least-once, PEL redelivery — 95% of Kafka at 10% of the hassle. **Ship as an optional profile.** |
| **Postgres as the belt** (`SKIP LOCKED` + `LISTEN/NOTIFY`) | Zero extra services. **Default**, so the repo runs with nothing installed. |

**Decision:** hide it behind a three-method `EventBus` interface (`publish` / `consume` /
`ack`). Default `PostgresQueueBus`; `RedisStreamsBus` behind a compose profile. Then write in
the README: *"the bus is an interface; Kafka is a drop-in adapter when volume justifies
partitioning."* That earns the credit without the pain.

### The bad-note box (DLQ)

If one note is broken and fails forever, everything behind it is stuck — one bad parcel blocks
the post office. **After 5 attempts, move it to a `dlq` table and carry on.**

**Analogy:** a parcel with an unreadable address goes in the *problem parcels* bin; the postman
finishes his route. Add `POST /v1/dlq/replay` so you can re-drive them after a fix.

### End to end

```
  ┌──────────────┐
  │  SPY         │
  │  writes note │
  └──────┬───────┘
         v
  ┌──────────────────────────┐
  │  BUCKET                  │
  │  wait for 50 notes       │
  │  OR 200 milliseconds     │
  └──────────┬───────────────┘
             v
        ╱──────────────╲
       ╱ Bucket full?   ╲
   No ╱                  ╲ Yes
  ┌──<                    >───┐
  │   ╲                  ╱    │
  │    ╲────────────────╱     │
  │  keep waiting             v
  │                  ┌────────────────────┐
  │                  │ SEND all 50        │
  │                  └─────────┬──────────┘
  │                            v
  │                       ╱──────────╲
  │                      ╱ Did it     ╲
  │                  No ╱   arrive?    ╲ Yes
  │            ┌───────<                >──────┐
  │            │        ╲              ╱       │
  │            v         ╲────────────╱        v
  │  ┌──────────────────────┐        ┌───────────────────┐
  │  │ Wait 1s,2s,4s,8s     │        │ 1. Check API key  │
  │  │ then retry           │        │ 2. Check shape    │
  │  │                      │        │ 3. Clean + cost   │
  │  │ Bucket overflowing?  │        └─────────┬─────────┘
  │  │ → drop oldest,       │                  v
  │  │   count the loss     │             ╱──────────╲
  │  └──────────────────────┘            ╱  Valid?    ╲
  │                                  No ╱              ╲ Yes
  │                          ┌─────────<                >────────┐
  │                          │          ╲              ╱         │
  │                          v           ╲────────────╱          v
  │                 ┌──────────────┐                  ┌─────────────────┐
  │                 │ DLQ          │                  │ Put on belt     │
  │                 │ broken notes │                  │ reply 202       │
  │                 └──────────────┘                  └────────┬────────┘
  │                                                            v
  │                                                   ┌─────────────────┐
  │                                                   │ Worker picks up │
  │                                                   └────────┬────────┘
  │                                                            v
  │                                                       ╱──────────╲
  │                                                      ╱ Seen this  ╲
  │                                                  Yes╱  ID before?  ╲No
  │                                            ┌───────<                >──────┐
  │                                            │        ╲              ╱       │
  │                                            v         ╲────────────╱        v
  │                                     ┌────────────┐              ┌──────────────┐
  │                                     │ Skip it    │              │ SAVE         │
  │                                     │ (bouncer)  │              └──────┬───────┘
  │                                     └────────────┘                     v
  │                                                              ┌──────────────────┐
  └──────────────────────────────────────────────────────────────│ Charts update    │
                                                                 └──────────────────┘
```

---

# PART 4 — The database

### You are storing two completely different kinds of things

| | **Chat data** | **Log data** |
|---|---|---|
| Example | "User said: What is Python?" | "Call took 1,240 ms, 890 tokens" |
| Size | Small | **Huge**, grows forever |
| Changed after writing? | Yes | **Never** — write once |
| How you read it | One conversation at a time | **Never one row** — "average across millions" |
| Must be exactly right? | **Yes** | Losing 0.1% is survivable |

**Analogy:** chat data is a **filing cabinet of customer folders** — you pull out one folder.
Log data is a **security camera tape** — nobody watches one frame; you ask "how many people
entered between 2pm and 3pm?" Same building, different storage needs.

### The tables, with example data

**`conversations`** — one row per chat thread → powers *list conversations*

| id | title | status | created_at | last_message_at |
|---|---|---|---|---|
| `c-01J8X…` | "Learning Python" | `active` | 14:00:00 | 14:22:05 |
| `c-01J8Y…` | "Fix my SQL query" | `archived` | 09:12:00 | 09:40:11 |

**`messages`** — one row per message → powers *resume a conversation*

| id | conversation_id | seq | role | content |
|---|---|---|---|---|
| `m-001` | `c-01J8X…` | 1 | `user` | "What is Python?" |
| `m-002` | `c-01J8X…` | 2 | `assistant` | "Python is a programming language…" |
| `m-003` | `c-01J8X…` | 3 | `user` | "Show me an example" |

**`inference_events`** — one row per AI call

| event_id | conv_id | msg_id | provider | model | status | ttft_ms | latency_ms | in_tok | out_tok | cost_usd |
|---|---|---|---|---|---|---|---|---|---|---|
| `e-01J8Z…` | `c-01J8X…` | `m-002` | anthropic | claude-sonnet-5 | `ok` | 820 | 3100 | 340 | 890 | 0.0142 |
| `e-01J9A…` | `c-01J8X…` | `m-004` | openai | gpt-4.1 | `error` | — | 30000 | 512 | 0 | 0.0015 |
| `e-01J9B…` | `c-01J8Y…` | `m-011` | anthropic | claude-sonnet-5 | `cancelled` | 640 | 1200 | 200 | 95 | 0.0021 |

Three statuses: `ok`, `error`, `cancelled`. **The cancelled row still has real numbers** — the
user hit Stop, but you recorded what happened up to that point. That detail shows you thought
it through, and it is the best 30 seconds of the demo video.

**`inference_rollup_1m`** — pre-computed summary, one row per minute per model

| minute | model | calls | errors | avg_ms | p95_ms | tokens | cost_usd |
|---|---|---|---|---|---|---|---|
| 14:22 | claude-sonnet-5 | 412 | 3 | 1180 | 2400 | 88,300 | 1.42 |
| 14:23 | claude-sonnet-5 | 388 | 0 | 1090 | 2210 | 79,110 | 1.28 |

**`dlq`** — broken notes, parked not lost

### How they link

```
   ┌──────────────────────┐
   │   conversations      │   "Learning Python"
   └──────────┬───────────┘
              │  one conversation has many messages
              v
   ┌──────────────────────┐
   │   messages           │   1. user: "What is Python?"
   └──────────┬───────────┘   2. assistant: "Python is…"
              │  each assistant message came from one AI call
              v
   ┌──────────────────────┐
   │   inference_events   │   3,100 ms, 890 tokens, $0.0142
   └──────────────────────┘
```

Read **downwards** for the chat. Read **upwards** to answer *"this call was slow — what was the
user actually asking?"* That upward path is the entire point of the product.

### The eight decisions worth defending

**1. Previews, not full text.** The log row keeps ~300 chars of question and answer. Full text
lives in `messages`. Charts scan millions of rows; every extra byte per row is felt. *The
security log says "person in red jacket, 14:22" — not their life story.*

**2. Cost is a frozen number, with a `pricing_version`.** Prices change. Calculate cost at
chart-time and last year's history silently changes when a vendor cuts prices. *Your old
receipts do not change when the shop raises prices.*

**3. Slice the log table by month (RANGE partitioning).** One physical table per month, which
Postgres presents as one logical table. "Last 24 hours" touches only this month's slice.
Deleting June = `DROP` the June table, instant, no row-by-row delete and no lock storm.
*One box of receipts per month, not one giant box.*

**4. Time-sorted IDs (UUIDv7), not random (UUIDv4).** Random IDs scatter inserts across the
B-tree; time-sorted IDs always append. Faster, and the timestamp is readable from the ID.
*A library shelved by date received vs by random number.*

**5. BRIN index on the time column, not B-tree.** The table is append-only and physically
time-ordered, which is exactly BRIN's assumption. A BRIN index over 10M rows is kilobytes where
a B-tree is hundreds of megabytes. B-tree stays on `event_id` (uniqueness) and on
`conversation_id` (the drill-down).

**6. The rollup table — why charts are instant.** 24 h of charts = **1,440 rows** instead of 5
million. *A shop does not recount every receipt to know yesterday's takings; they wrote the
total in a book at closing.* **Tradeoff, say it out loud:** the summary is up to a minute
behind and only answers questions you planned for. Raw rows remain for anything unusual.
**Summaries are a cache, not the truth** — and a nightly reconciliation job recomputes
yesterday from raw and alerts on >0.1% drift, which lets you say *"my aggregates are verifiable
against raw."*

**7. p95, not average.** 99 requests at 1 s and one at 100 s gives an average of 2 s — "looks
fine" — while someone had an awful time. `p50` = typical, `p95` = the number that matters,
`p99` = your angriest users. Dashboards that show only averages are how teams convince
themselves everything is fine while customers complain. Store fixed **histogram buckets** in
the rollup so percentiles are computed cheaply and are mergeable across buckets.

**8. The `attributes` JSONB escape hatch.** Every provider returns some odd extra field. One
flexible column beats a migration per surprise. *A "misc" drawer.* **Rule:** if you find
yourself searching the drawer often, promote that field to a real column. Add a GIN index only
when a real query needs it — not preemptively.

**Also decided:** `timestamptz` in UTC everywhere, never naive timestamps.
`messages` cascade-delete with their conversation. `inference_events` uses
`ON DELETE SET NULL` so telemetry survives a chat deletion — *but* a GDPR erasure request must
also null the previews, so ship a `redact_conversation(id)` function and say why both exist.

### Why Postgres, and not the others

| Option | Verdict |
|---|---|
| **Postgres** ✅ | Relational integrity for chat, JSONB for flexibility, partitioning for the huge log table, rollups make charts fast. **One thing to run, install and explain.** |
| MongoDB | Flexible, but weak at exactly what the dashboards need — joins and time-bucketed aggregation. JSONB already gives the flexibility you'd go there for. |
| SQLite | Lovely and simple, but concurrent writers are a problem and there is no partitioning. Toy-scale only. |
| ClickHouse alone | Brilliant for the log side, wrong for chat — no real updates or transactions, and conversations need both. |
| Postgres **+** ClickHouse | What Langfuse and Signoz actually do at scale. Two databases to run, seed, back up and explain — for demo-sized data. **Not yet.** |
| Postgres + TimescaleDB | Genuine middle ground (hypertables, continuous aggregates, compression). Rejected only because it ties you to a Timescale-enabled image and rules out plain Neon. |

**The sentence that wins the point:**

> *"Chat and telemetry sit behind separate repository interfaces. At roughly 10 million events
> a day I'd move `inference_events` to ClickHouse — a swap of one adapter, not a rewrite."*

Knowing **when you would change your mind** is worth more than the choice itself.

### One picture

```
   ┌─────────────────────────────────────────────────────────┐
   │                      POSTGRES                           │
   │                                                         │
   │   THE FILING CABINET                THE CAMERA TAPE     │
   │   (small, precise, edited)          (huge, write-once)  │
   │                                                         │
   │   ┌──────────────────┐              ┌─────────────────┐ │
   │   │  conversations   │              │ inference_events│ │
   │   └────────┬─────────┘              │   ├─ 2026_06    │ │
   │            │                        │   ├─ 2026_07    │ │
   │            v                        │   └─ 2026_08    │ │
   │   ┌──────────────────┐              └────────┬────────┘ │
   │   │  messages        │◄─────links───┐        │ every    │
   │   └──────────────────┘              │        │ minute   │
   │                                     │        v          │
   │   ┌──────────────────┐              │  ┌──────────────┐ │
   │   │  dlq (broken)    │              │  │ rollup_1m    │ │
   │   └──────────────────┘              │  └──────┬───────┘ │
   └─────────────────────────────────────┼─────────┼─────────┘
                                         │         │
                      chat UI reads ─────┘         └──► dashboard
                      (list / resume)                   reads (fast)
```

**Left = the app. Right = the observability product. Same database, different rules.**

### Schema (DDL sketch)

```sql
CREATE TYPE conversation_status AS ENUM ('active','archived','deleted');
CREATE TYPE message_role        AS ENUM ('user','assistant','system');
CREATE TYPE inference_status    AS ENUM ('ok','error','cancelled','timeout');

CREATE TABLE conversations (
  id               uuid PRIMARY KEY,               -- UUIDv7
  user_id          text,
  title            text,
  status           conversation_status NOT NULL DEFAULT 'active',
  message_count    int  NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_message_at  timestamptz,
  metadata         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX conversations_list_idx
  ON conversations (user_id, last_message_at DESC) WHERE status <> 'deleted';

CREATE TABLE messages (
  id               uuid PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              int  NOT NULL,
  role             message_role NOT NULL,
  content          text NOT NULL,
  token_count      int,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);

CREATE TABLE inference_events (
  event_id         uuid        NOT NULL,           -- client-generated, idempotency key
  created_at       timestamptz NOT NULL,           -- partition key
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id       uuid REFERENCES messages(id)      ON DELETE SET NULL,
  provider         text NOT NULL,
  model            text NOT NULL,
  status           inference_status NOT NULL,
  streamed         boolean NOT NULL DEFAULT false,
  ttft_ms          int,
  latency_ms       int  NOT NULL,
  input_tokens     int,
  output_tokens    int,
  tokens_per_sec   numeric(10,2),
  cost_usd         numeric(12,6),
  pricing_version  text,
  finish_reason    text,
  error_type       text,                            -- rate_limit|timeout|auth|content_filter|
  error_message    text,                            -- context_length|server_error|cancelled
  input_preview    text,
  output_preview   text,
  redaction_hits   int NOT NULL DEFAULT 0,
  client_ts        timestamptz NOT NULL,            -- when the SDK observed it
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  attributes       jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (event_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX inference_events_time_brin ON inference_events USING brin (created_at);
CREATE INDEX inference_events_conv_idx  ON inference_events (conversation_id, created_at DESC);
CREATE INDEX inference_events_err_idx   ON inference_events (created_at DESC)
  WHERE status <> 'ok';                              -- partial: error panel scans little

CREATE TABLE inference_rollup_1m (
  bucket        timestamptz NOT NULL,
  provider      text NOT NULL,
  model         text NOT NULL,
  calls         bigint NOT NULL,
  errors        bigint NOT NULL,
  cancelled     bigint NOT NULL,
  sum_latency   bigint NOT NULL,
  sum_ttft      bigint NOT NULL,
  input_tokens  bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cost_usd      numeric(14,6) NOT NULL,
  hist          int[] NOT NULL,        -- fixed latency buckets → mergeable percentiles
  PRIMARY KEY (bucket, provider, model)
);

CREATE TABLE dlq (
  id            uuid PRIMARY KEY,
  payload       jsonb NOT NULL,
  error         text  NOT NULL,
  stage         text  NOT NULL,
  attempts      int   NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
```

Insert path is **one statement**: a CTE that does `INSERT … ON CONFLICT DO NOTHING`, and only
for rows that were actually inserted, upserts the rollup. That is how at-least-once delivery
becomes exactly-once *aggregation*.

**Retention (numbers, not intentions):** raw events 90 days via a monthly `DROP PARTITION`
cron; rollups 400 days (they are tiny); DLQ 30 days. *"We'd add retention" is not a policy;
90 days is.*

---

# PART 5 — The bonus items

> **Update — 9 of 10 shipped.** This was written as a forecast of 8. The event bus and Docker
> Compose both landed; only k8s did not. The table below has been updated to the outcome, with
> the original forecast kept in the last column where it differed — the places the plan was
> wrong are more informative than the places it was right.

**9 of 10 bonus items are built.** Only k8s is outstanding, because there is no cluster to
verify manifests against.

Note that **auto-instrumentation is not on this list** — it sits in the main body of the brief,
not the bonus section. It is a core requirement that most candidates under-deliver, which is
exactly why the loader hook is worth the hours.

| Bonus | Status | How |
|---|---|---|
| **Streaming** | ✅ **in** | SSE (not WebSocket — unidirectional, survives proxies, no extra protocol). SDK marks TTFT on the first chunk. |
| **Cancel a conversation** | ✅ **in** | `AbortController` in the browser → `req.signal` on the server → provider `signal`. Emits a `cancelled` event **with partial tokens**. |
| **List conversations** | ✅ **in** | `conversations_list_idx`, sidebar. |
| **Resume a conversation** | ✅ **in** | Load `messages` by `(conversation_id, seq)`. |
| **Multi-provider** | ✅ **in** | Two hand-rolled adapters: `AnthropicAdapter` + `OpenAICompatibleAdapter`. The second is base-URL-driven, so DeepSeek / Groq / xAI / Together / Ollama are **config entries, not code** — ship the map even though only OpenAI is keyed, and say so. |
| **Dashboards** | ✅ **in** | In-app (Recharts) over the rollup tables: latency p50/p95/p99, throughput req/min + tokens/sec, error rate by type, cost by model. Raw-vs-rollup toggle to demonstrate both query paths. |
| **PII redaction** | ✅ **in** | Defense in depth — redact in the **SDK before transmit** (PII never leaves the process) **and re-scan at ingestion** (central policy). Detectors: email, phone, SSN, credit card **with Luhn check**, IP, JWT/bearer/API keys. **Hash rather than drop** (`sha256` prefix) so you can still count distinct without storing the value. Presidio/LLM classifiers are the heavyweight option — overkill here, name them anyway. |
| **Event-based** | ✅ **built** | **`pgmq`, not `SKIP LOCKED`.** The forecast was a hand-rolled queue; pgmq turned out to be available and gives SQS semantics — visibility timeouts, long polling via `read_with_poll`, archive-on-delete — for none of the code. Behind an `EventSink` interface: `DirectSink`, `PgmqSink`, and a `KafkaSink` that **throws by design** with the threshold that would justify it written in the file. Resolved at boot, so a database without the extension degrades to direct writes with a warning rather than failing. |
| **Docker Compose** | ✅ **built** | `docker compose up` from a clean checkout. **Verified on every push** — not on this machine, which still has no container runtime, but on a GitHub Actions runner, which is the stronger claim. The job asserts the stack boots, the schema verifies *inside the image*, `pgmq=true`, all three services answer, and an event survives HTTP → queue → worker → Postgres. |
| **k8s** | ❌ **not built** | The only one outstanding. The probes and graceful shutdown *are* the k8s contract, so the manifests in `docs/containerization.md` should apply cleanly — but "should" is the problem. There is no cluster to check against, so they stay a design document rather than an applyable `k8s/` directory. |

**Why k8s stays unshipped:** an unverifiable claim is worse than a stated gap. A reviewer who
runs `kubectl apply`, hits an error, and realises the manifests were never executed now doubts
everything else in the repo. This is the same reasoning that kept `compose.yaml` out of the
repo until CI could run it — the difference is that Docker found a way to be verified and k8s
has not yet.

**The lesson from doing it anyway:** "deferred with the seams open" was the right call at
planning time *and* the seams held. But the phrase is only worth anything if you eventually go
back and prove it. Two of the three deferred items are now proven; the third is still a
promise, and is labelled as one.

**Multi-provider rejected alternative:** the Vercel AI SDK would save real time and has a built-in
`experimental_telemetry` hook — but wrapping someone else's wrapper weakens the
auto-instrumentation story, which is the highest-signal part of this assignment. Hand-rolled
adapters keep the Proxy/loader narrative genuine. Note the AI SDK in "what I'd do with more
time."

**Unified error taxonomy** across providers: `rate_limit | timeout | auth | content_filter |
context_length | server_error | cancelled`. Normalising these is most of the value of the
adapter layer — and with two genuinely different SDK shapes (Anthropic's typed stream events vs
OpenAI's `stream_options.include_usage`) you can prove the abstraction is real rather than a
single vendor wrapped twice.

**Multi-provider rejected alternative:** the Vercel AI SDK would save real time and has a built-in
`experimental_telemetry` hook — but wrapping someone else's wrapper weakens the
auto-instrumentation story, which is the highest-signal part of this assignment. Hand-rolled
adapters keep the Proxy/loader narrative genuine. Note the AI SDK in "what I'd do with more
time."

**Unified error taxonomy** across providers: `rate_limit | timeout | auth | content_filter |
context_length | server_error | cancelled`. Normalising these is most of the value of the
adapter layer.

---

# PART 6 — Tech stack

| Layer | Pick | Why / rejected |
|---|---|---|
| Language | **TypeScript everywhere** | One Zod schema is literally the contract shared by SDK and ingestion validator — no schema drift. Rejected Python/Go ingestion: better data-eng story, but the event schema gets maintained twice. |
| Monorepo | **npm workspaces** | pnpm/turbo not installed; npm workspaces is zero-install and sufficient. |
| Chat app | **Next.js App Router + React + Tailwind** | Matches existing proficiency; SSE from a route handler is straightforward. |
| Ingestion | **Fastify** | Fast, tiny, good schema story; separate process proves the SDK→service boundary is real. |
| Validation | **Zod** | Single source of truth → SDK payload type + ingest validator + published JSON Schema. |
| DB | **Neon Postgres** | Managed, free tier, no install. Serverless driver works from Vercel. See Part 4. |
| Bus | **`EventBus` interface**, Postgres `SKIP LOCKED` impl if time allows | No extra infrastructure needed. See Part 3. |
| Charts | **Recharts** | Self-contained; no extra service. Grafana rejected — needs a container, and the dashboard stops being your code. |
| Model | **`claude-sonnet-5`** + **`gpt-4.1`** | Two genuinely different SDK shapes, so the adapter layer is provably real. |
| Hosting | **Vercel** (one project) + **Neon** | Two accounts, one deploy, live URL on day one. |

### The ingestion service under managed hosting

Vercel has no long-running processes, which would normally kill a standalone Fastify service.
The fix keeps both stories intact — **write the ingest logic framework-free**:

```
packages/ingest-core/     handleBatch(payload) → result     ← all the logic lives here
        │                 (no HTTP framework, no server)
        ├──► apps/ingest/            Fastify wrapper   — local dev, self-host, future Docker
        └──► apps/web/api/v1/events  Next route (~10 lines) — what actually deploys
```

Same code, two entry points. Locally you run the real separate service on its own port, which
proves the SDK→network→ingestion boundary is genuine and not a function call. In production it
deploys as one Vercel project. **Say this explicitly in the README** — it reads as deliberate
design, and it is exactly what makes the later Docker step packaging rather than rework.

**No separate worker process is needed.** The 1-minute rollup is maintained by the *same SQL
statement* that inserts the event (one CTE: `INSERT … ON CONFLICT DO NOTHING` → upsert the
rollup only for rows actually inserted). That is what makes at-least-once delivery produce
exactly-once aggregation, and it removes the one component managed hosting can't run.

### Repo layout

```
ollive/
├─ apps/
│  ├─ web/          Next.js — chat UI + dashboard + /api/chat (SSE) + /api/v1/events
│  └─ ingest/       Fastify wrapper over ingest-core — local dev + self-host entry point
├─ packages/
│  ├─ contracts/    the Zod event schema  ← the contract everything derives from
│  ├─ config/       env parsed + validated once at boot (the container seam)
│  ├─ sdk/          instrument(), transport queue, redaction, ALS context
│  │   └─ register.ts   the --import loader hook  ← 🏆
│  ├─ providers/    anthropic + openai-compatible adapters, error taxonomy, pricing
│  ├─ ingest-core/  validate → redact → price → persist   (framework-free)
│  └─ db/           migrations + repositories (ChatRepo | EventRepo, deliberately split)
├─ examples/
│  ├─ zero-code/    plain node app, NO logging code, instrumented by the flag alone  ← 🏆
│  └─ load/         traffic generator so the charts have shape before recording
└─ docs/
   ├─ architecture.md          ingestion flow, logging strategy, scaling, failure modes
   ├─ auto-instrumentation.md  the 4 layers, why L2+L3, the Next.js bundling caveat
   └─ containerization.md      Dockerfiles + compose + k8s, labelled UNVERIFIED
```

**Critical files:**
- `packages/contracts/src/event.ts` — the one Zod schema; every boundary derives from it
- `packages/db/migrations/002_inference_events.sql` — the schema-design deliverable
- `packages/sdk/src/instrument/proxy.ts` — Proxy + non-consuming stream wrapping
- `packages/sdk/src/transport/queue.ts` — bounded buffer, batching, backoff, drop accounting
- `packages/sdk/register.ts` — the loader hook; the differentiator lives here
- `packages/ingest-core/src/handle-batch.ts` — the dedupe + rollup CTE
- `examples/zero-code/app.mjs` — must contain **zero** logging code; that is the whole point

### The serverless flush problem

On Vercel the process **freezes the moment the response is returned** — so a 200 ms batch timer
would never fire and every event in the bucket would be lost. Two mitigations, both required:

1. **`after()` from `next/server`** — registers work that runs *after* the response is sent but
   *before* the function is frozen. The transport flushes there.
2. **Flush-on-response as well as on-timer** — in serverless mode the queue detects it is not
   long-lived and drops its flush threshold to 1, trading batching efficiency for durability.

This is a real difference between the local Fastify path and the deployed path, and it is worth
a paragraph in the README. Most candidates do not notice it, and their deployed demo silently
logs nothing.

---

# PART 7 — Failure handling

| What breaks | Behaviour | Data lost? |
|---|---|---|
| Ingestion down | Backoff retry; bucket caps; drop oldest and **count** | Only on long outage. Counted, never silent. |
| DB down | Notes stay on the bus; worker retries; nothing ACKed | **No** — drains on recovery |
| Batch sent twice | `event_id` conflict → ignored | **No** |
| One broken note | 5 attempts → DLQ + replay endpoint | **No** — parked, doesn't block others |
| Poison payload (5 MB) | Size cap rejects at the edge with 413 | That event only |
| Provider 429 / timeout | Logged with `error_type`, surfaced to user, app-level retry | No |
| Client disconnects mid-stream | `cancelled` event **with partial tokens and TTFT** | No |
| App killed with full bucket | Up to 200 ms of notes | Accepted tradeoff, documented |
| Clock skew | `client_ts > server_ts` → trust server, flag row | No |
| Bad ingest key | 401 → non-retryable, 60 s circuit breaker; **startup preflight fails loudly at boot** | Whole misconfig window — hence the preflight |
| Rollup drift | Nightly reconciliation vs raw; >0.1% → rebuild | No — rollups are a rebuildable cache |
| **SDK itself throws** | try/catch everywhere; **chat carries on** | Those notes only |

**Also decided:** if `INGEST_ENDPOINT` is unset the transport becomes a **no-op with one
startup warning**. Never throw, never retry into the void. A grader who clones without reading
hits this first.

---

# PART 8 — Build order

Every phase ends **demoable**. An 80%-done project that runs beats a 95%-done project that
does not.

**The README is written incrementally, not at the end.** After each phase, spend 10 minutes
adding its section while the decisions are fresh. This is the single biggest schedule risk
mitigation in the plan — "write the README last" is how a graded deliverable becomes a rushed
40 minutes at hour 19.

### Day 1 — get to a complete submission (~11.5 h)

| # | Phase | Hrs | You can demo |
|---|---|---|---|
| 0 | Skeleton: npm workspaces, TS refs, `packages/config` (env via Zod), `.env.example`, **Neon DB provisioned**, migration runner. **Deploy an empty Vercel project now** so the URL exists and the pipeline is proven | 1.5 | `npm run db:migrate` creates the schema; a live URL responds |
| 1 | **Chat that works**: Anthropic adapter, SSE route, streaming UI, conversations + messages persisted, sliding-window context | 3 | A working streaming chatbot |
| 2 | **SDK + transport + ingest + storage**: contracts → Proxy → stream accumulator (TTFT/usage) → ALS wristband → bounded queue + `after()` → `ingest-core` → dedupe+rollup CTE. *Direct write behind the `EventBus` interface so the seam exists* | 4 | End-to-end. `SELECT * FROM inference_events` shows real latency and token numbers. **Requirements 1–4 all met — this alone is submittable** |
| 2b | **Container seams**: `/healthz` + `/readyz`, SIGTERM graceful flush, stdout JSON logs | 0.5 | `curl /readyz` fails when the DB is unreachable and passes when it isn't |
| 3 | **Dashboards**: latency p50/p95/p99, throughput, error rate, cost by model + conversation drill-down | 2.5 | The README screenshots |

**── CUT LINE. Stop here and you have a complete, defensible submission. ──**

### Day 2 — the differentiator and the cheap wins (~8.5 h)

Ordered by **value per hour**, so stopping at any point is fine.

| # | Phase | Hrs | Why it's here |
|---|---|---|---|
| 4 | **Cancel / list / resume** | 1.5 | Three named bonus items for 1.5 h — the best ratio in the whole plan. Hit Stop → a `cancelled` row with **partial tokens and a real TTFT** appears in the dashboard. Best 30 seconds of the demo video. |
| **9** | **🏆 Loader hook + `examples/zero-code`** | **1.5** | **CORE.** `module.registerHooks()` on Node 24, scoped to two specifiers, reusing the Phase-2 `instrument()`. The `with-flag` / `without-flag` diff is the most memorable artifact in the repo. Do it while the Proxy code is still fresh. |
| 5 | **Multi-provider** (OpenAI adapter + base-URL map) | 1.5 | Second real vendor; the group-by-provider dashboard panels light up for free. Also proves the loader works on more than one SDK shape. |
| 6 | **PII redaction** | 1.5 | Self-contained, visibly impressive, and Luhn-validated card detection is a nice detail. |
| 11 | **README polish + `docs/architecture.md` + `docs/containerization.md` + Loom** | 2.5 | **Never cut.** Cheaper than it looks *because* you wrote each section as you went. |

**Total: ~20 h over 2 days.**

**Stretch (Day 3 if it exists), in order:**
1. Postgres `SKIP LOCKED` event bus + DLQ replay (~2 h, no infrastructure needed)
2. Docker Compose — the seams are already in, so this is Dockerfiles + `compose.yaml` +
   verifying, once a runtime exists (~2.5 h incl. install)
3. k8s manifests against k3d (~2 h)

### Where the axe falls, in order

1. **PII redaction** (Phase 6) — the detectors are a self-contained module; describing the
   design in the README costs 15 minutes instead of 1.5 hours.
2. **Multi-provider** (Phase 5) — the adapter interface and error taxonomy still exist and are
   visible in the code; only the second live vendor goes.
3. **The dashboard's raw-vs-rollup toggle** — keep the rollup path, drop the comparison view.

**Explicitly NOT on the cut list any more: the loader hook.** If time gets tight, Phase 5 and 6
go first. The loader is the thing that makes this submission different from everyone else's.

**Never cut:** Phase 3 (the most visually persuasive artifact), Phase 9 (the differentiator),
Phase 11, and the live demo link — **deploy it in Phase 0, not at the end.** A deploy that
first runs at hour 19 is a deploy that fails at hour 19.

### Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `module.registerHooks()` doesn't cleanly intercept the provider SDKs' dual CJS/ESM builds | Medium | Timebox to 2 h. Fall back to `require-in-the-middle` + `import-in-the-middle` (well-trodden, ~1 h more). The ESM `.mjs` example is the supported path — test it first, not last. |
| Vercel `after()` doesn't flush the buffer on the deployed build | Medium | **Test on the deployed URL at the end of Phase 2, not at hour 19.** Fallback: serverless mode drops the flush threshold to 1. |
| OpenAI streaming returns no usage | Low | Known cause — `stream_options: { include_usage: true }`. Already in the adapter spec. |
| Neon cold-start latency pollutes the latency charts | Low | It shows up as ingestion lag, not model latency, because the two timestamps are separate. Mention it in the README as a demonstration of *why* both timestamps exist. |

---

# PART 9 — Deliverables

**README:** setup (clone → `.env` → one command), architecture diagram, schema design
decisions, tradeoffs made, what I'd improve with more time.

**`docs/architecture.md`:** ingestion flow, logging strategy, scaling considerations, failure
handling assumptions (Part 7 verbatim as a table).

**Demo (3 min Loom):** chat streams in → dashboard updates live → hit **Stop** mid-stream →
a `cancelled` row with partial tokens appears → switch to OpenAI → the provider panel splits →
type a fake credit card → the preview shows a hash → kill the ingest service and keep chatting
to prove the chat survives.

Run `examples/load` before recording so the charts have shape instead of three data points.

**End the video on the zero-code demo — it is the strongest thing you have.** Show
`examples/zero-code/app.mjs` on screen and point out there is no logging code anywhere in it.
Then:

```bash
node examples/zero-code/app.mjs                                 # dashboard: nothing
node --import @ollive/sdk/register examples/zero-code/app.mjs   # dashboard: an event appears
```

Same file, unmodified, run twice. That is auto-instrumentation demonstrated rather than
claimed, and it takes 30 seconds.

**The README section that earns the most:** *"Tradeoffs made"* and *"What I'd improve with more
time."* Write them last, when you know what actually hurt. Name containers, the L4 fetch
interceptor, and ClickHouse there with the specific threshold that would trigger each.

---

# PART 10 — Verification

- `npm run db:migrate` then inspect: 5 tables + this month's partition exist
- Send a chat message; confirm one row in `inference_events` with non-null `ttft_ms`,
  `latency_ms`, both token counts, and a `cost_usd`
- Kill the ingest service, send 20 messages → **chat still works**; restart it → events arrive
- Replay the same batch twice → row count unchanged (idempotency)
- Post a malformed event → lands in `dlq`, does not block the next valid one
- Hit **Stop** mid-stream → a `cancelled` row with partial tokens and a real TTFT
- Type an email + a valid card number into chat → previews show hashes, `redaction_hits > 0`
- `examples/load` for 60 s → rollup rows appear; dashboard p95 matches
  `percentile_cont` over raw within tolerance
- Switch to OpenAI, send a message → a row with `provider = 'openai'` and non-null usage
  (proves `stream_options.include_usage` was set — without it OpenAI returns no usage at all)
- **On the deployed Vercel URL, not just locally:** send a message, confirm the event lands.
  This is the `after()` flush check, and it is the one most likely to silently fail.

**The two that prove the differentiator:**

- `node examples/zero-code/app.mjs` → **zero** events in the DB
- `node --import @ollive/sdk/register examples/zero-code/app.mjs` → events appear, with correct
  model, latency and token counts — **and `git diff` on that file is empty**

**The container seams:**

- `curl /readyz` returns 503 with the DB unreachable, 200 with it reachable; `/healthz` returns
  200 in both cases (they must genuinely differ, or the probes are decorative)
- `kill -TERM <pid>` → the buffered events are flushed before the process exits, not lost

---

# Prerequisites before Phase 0

1. **Neon account** → create a project, copy the connection string
2. **Vercel account** → linked to the GitHub repo
3. **`OPENAI_API_KEY`** alongside the existing `ANTHROPIC_API_KEY`
4. **GitHub repo created** — the deliverable is the repo, so it exists from commit one
