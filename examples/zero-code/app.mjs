// ═══════════════════════════════════════════════════════════════════════════
//  READ THIS FILE. There is no telemetry code in it.
// ═══════════════════════════════════════════════════════════════════════════
//
//  No import from @ollive/sdk. No wrapper. No init call. No timing. Nothing.
//  It is the script anyone would write to call Claude.
//
//  Run it twice:
//
//     node examples/zero-code/app.mjs
//         → dashboard shows nothing
//
//     node --import @ollive/sdk/register examples/zero-code/app.mjs
//         → an event appears, with model, latency, TTFT and token counts
//
//  Same file. `git diff` between the two runs is empty. That difference is the
//  deliverable — auto-instrumentation demonstrated rather than claimed.
//
//  Events from the second run carry captured_by='loader', so which mechanism
//  produced them is checkable from the data, not taken on trust.

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync } from 'node:fs'

// Read the key straight from .env — this example deliberately depends on
// nothing from the project except the vendor SDK.
const env = Object.fromEntries(
  readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.trimStart().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

console.log('\nasking claude…\n')

const stream = client.messages.stream({
  model: 'claude-opus-5',
  max_tokens: 1024,
  output_config: { effort: 'low' },
  messages: [
    {
      role: 'user',
      content: 'In one short sentence: what does auto-instrumentation mean?',
    },
  ],
})

for await (const event of stream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    process.stdout.write(event.delta.text)
  }
}

console.log('\n\ndone. check http://localhost:3000/dashboard\n')

// Give the SDK's background flush a moment. Only needed because this script
// exits immediately; a long-running process flushes on its own timer, and the
// SIGTERM handler drains on shutdown.
await new Promise((r) => setTimeout(r, 1500))
