# Auto-instrumentation

How code gets observed without anyone writing code to observe it.

---

## The problem

The naive approach is to log at every call site:

```js
const start = Date.now()
const res  = await claude.messages.create({ … })
log({ ms: Date.now() - start, model: '…', tokens: … })   // ← typed every time
```

Three failure modes, and the third is the one that matters:

1. You must remember, every time.
2. A colleague's new call is silently unlogged.
3. **A call inside a third-party library is unreachable.** You cannot edit code
   you do not own.

Auto-instrumentation means the application writes none of that and every call is
captured anyway — including the ones in code you did not write.

---

## The layers

| Layer | Integration | Cost | Status |
|---|---|---|---|
| L1 manual | explicit span | free | available |
| **L2 `Proxy`** | `instrument(new Anthropic())` | one word | **primary** |
| **L3 loader** | `node --import @ollive/sdk/register` | a CLI flag | **shipped** |
| L4 `fetch` hook | intercept the transport | — | **not built** — see below |

L4 would catch any vendor that speaks HTTP, including ones with no shim. It was
cut because with two providers, both covered by named shims, it adds breadth
that is never exercised — and it sees raw HTTP rather than typed objects, so
pulling usage back out is fiddly. It is the right next layer if a third-party
library starts calling a model directly.

---

## L2 — the `Proxy`

```js
const claude = instrument(new Anthropic({ apiKey }))
//             ^^^^^^^^^^ one word, one place
```

Every `claude.messages.create(…)` in the process is now measured. No call site
changes.

A `Proxy` is an object that behaves exactly like the real one but lets us
intervene on property access. The receptionist in front of the manager's door:
you still ask for the manager, she notes when you went in and came out, and you
never notice she is there.

### The hard part: streaming

**A stream can only be consumed once.** The obvious implementation reads chunks
to count tokens — and then the application receives nothing.

The wrapper has to be a *turnstile*: every chunk passes straight through to the
caller, counted on the way past.

```ts
async next() {
  const result = await inner.next()
  if (result.done) { span.end(); return result }

  const read = shim.readChunk(result.value)     // observe
  if (read?.text) { span.markFirstToken(); span.appendText(read.text) }
  if (read?.usage) span.mergeUsage(read.usage)

  return result                                  // ← untouched. this is the point.
}
```

Three subtleties in that loop:

- **`return()` is forwarded.** When a consumer breaks out of a `for await` early,
  the runtime calls it — the only signal that the caller walked away. Without
  forwarding, the vendor's socket leaks; without observing it, an abandoned
  stream never emits an event at all. This is how a cancelled chat still produces
  a row with partial tokens and a real TTFT.
- **`finalMessage()` is wrapped separately.** It consumes the stream internally,
  bypassing the iterator entirely, so a caller using that path would otherwise be
  invisible.
- **Non-iterator properties bind to the *target*, not the proxy.** Binding to the
  proxy would send the SDK's internal calls back through the trap and recurse.

### Usage arrives at both ends

Anthropic reports **input** tokens in `message_start` — before a single output
token exists — and **output** tokens in `message_delta` near the end. Reading
usage only when the stream closes records zero input tokens on every call, and
nobody notices until the cost report.

OpenAI reports none at all for a streamed call unless
`stream_options: { include_usage: true }` is set, and then delivers it on a final
chunk whose `choices` array is empty.

Both of these are in `packages/sdk/src/instrument/shims.ts`, and both are covered
by tests.

---

## L3 — the loader hook

```bash
node --import @ollive/sdk/register  app.js
```

That flag is the entire integration. `examples/zero-code/app.mjs` contains no
telemetry code at all.

### How

Node evaluates `register.ts` before the application's entry point. It installs a
`module.registerHooks` hook watching for `@anthropic-ai/sdk` and `openai`. When
the app later imports one, the hook substitutes a synthetic module:

```js
import RealClient from "file:///…/@anthropic-ai/sdk/index.mjs?ollive-raw=1";
export * from "file:///…/@anthropic-ai/sdk/index.mjs?ollive-raw=1";
import { wrapConstructor } from "file:///…/hook-runtime.js";
export default wrapConstructor(RealClient, "anthropic");
```

The `?ollive-raw=1` query makes it a different URL, so the hook skips it and the
real package loads normally. `export *` forwards every named export untouched;
only `default` — the client class — is replaced, wrapped in a `construct` trap
that instruments each instance.

You replace the manager's door with a revolving door that counts people, at 4am,
before anyone arrives. Nobody in the building finds out.

This is what Datadog, New Relic and OpenTelemetry do. `module.registerHooks`
(Node 22.15+) makes it one synchronous hook covering both module systems, instead
of the `require-in-the-middle` + `import-in-the-middle` pair with its worker
thread and message ports.

### The bug worth recording

The first version matched any `index.mjs` inside the package and hit
`@anthropic-ai/sdk/resources/index.mjs` — an internal file with no default
export. The substituted module failed to instantiate and took the whole process
down at import time:

```
SyntaxError: The requested module '…/resources/index.mjs?ollive-raw=1'
does not provide an export named 'default'
```

The fix is to anchor the pattern to the package's **top-level entry**. Match the
front door, not every door in the building.

### The limitation, stated plainly

This works on module **specifiers**. A bundler that inlines the vendor SDK into a
chunk leaves no specifier to match, and instrumentation silently captures
nothing.

Under Next.js the provider packages must therefore be listed in
`serverExternalPackages` — they are, in `apps/web/next.config.ts`, with a comment
explaining why. But "it works if you configure your bundler correctly" is a
weaker claim than a demonstration, which is why the proof is a plain-`node`
script.

---

## The proof

```bash
$ node examples/zero-code/app.mjs
loader-captured events: 0

$ node --import @ollive/sdk/register examples/zero-code/app.mjs
loader-captured events: 1
```

Same file, unmodified — `git diff` between the runs is empty.

The captured event:

```
anthropic/claude-opus-5   captured_by=loader
latency=3440ms  ttft=1697ms
tokens 26 in / 75 out   cost $0.00200500
conversation_id null     ← correct: a bare script has no conversation
```

`captured_by` is written on every event, so **which mechanism produced a row is
answerable from the data** rather than from this document. `conversation_id`
being null is not a gap — a standalone script genuinely has no conversation, and
recording one would be a lie.

---

## Correlation without threading parameters

The instrumentation runs deep inside a vendor SDK. The conversation ID lives at
the top of the HTTP request. Passing it down means changing every signature
between — which defeats the premise.

`AsyncLocalStorage` is the hospital wristband. Snap it on when the request
arrives; every doctor in every room reads it without being told who the patient
is.

```ts
await withContext({ conversationId, messageId }, async () => {
  for await (const chunk of adapter.stream({ … })) { … }
})
```

Nothing inside that callback is passed an extra parameter, and the emitted event
still carries both IDs.

It is genuinely async-aware, not a global: two concurrent requests each see their
own context. A module-level variable would interleave them and attribute one
user's tokens to another — a bug that presents as "the numbers are slightly off"
for months.

---

## The rule underneath all of it

> **If the instrumentation fails, the application must not.**

Enforced mechanically, not by care:

- `enqueue()` cannot throw, block, or await. It writes to an array and returns.
- `instrument()` returns the client **unchanged** if it cannot understand it, and
  logs a warning. It never throws during application startup.
- `Span.emit()` swallows its own errors — the model call it describes already
  succeeded.
- A shim that cannot parse a chunk does not break the stream; the event is just
  less complete.
- No `INGEST_ENDPOINT` produces a no-op transport and one startup warning. That
  is a supported state, and it is the first thing a reviewer hits when they clone
  the repo and run it without reading anything.
