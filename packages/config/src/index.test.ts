import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  __resetConfigForTests,
  dbConfig,
  providerConfig,
  telemetryConfig,
} from './index.js'

/**
 * These tests exist because configuration failures are the ones that waste the
 * most time: they surface far from their cause and usually in production. The
 * behaviour worth guaranteeing is that a bad environment fails *at boot* with a
 * message naming the variable.
 */

function withEnv(vars: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('OLLIVE_') || key.startsWith('INGEST_') || key.startsWith('DATABASE_')) {
      delete process.env[key]
    }
  }
  for (const p of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY']) {
    delete process.env[p]
  }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetConfigForTests()
}

beforeEach(() => withEnv({}))

describe('dbConfig', () => {
  it('names the missing variable rather than failing obscurely', () => {
    assert.throws(() => dbConfig(), /DATABASE_URL/)
  })

  it('rejects a URL that is not postgres', () => {
    withEnv({ DATABASE_URL: 'mysql://localhost/x' })
    assert.throws(() => dbConfig(), /postgres/)
  })

  it('accepts a valid URL and defaults the pool size', () => {
    withEnv({ DATABASE_URL: 'postgresql://u:p@host/db?sslmode=require' })
    assert.equal(dbConfig().poolMax, 5)
  })
})

describe('providerConfig', () => {
  it('requires at least one provider key', () => {
    assert.throws(() => providerConfig(), /at least one provider key/)
  })

  it('reports only the providers that are actually usable', () => {
    withEnv({ ANTHROPIC_API_KEY: 'sk-ant-x' })
    const cfg = providerConfig()

    assert.deepEqual(cfg.available, ['anthropic'])
    assert.equal(cfg.has('anthropic'), true)
    assert.equal(cfg.has('openai'), false)
  })

  it('reports multiple providers when multiple keys are present', () => {
    withEnv({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-proj-y' })
    assert.deepEqual(providerConfig().available, ['anthropic', 'openai'])
  })
})

describe('telemetryConfig', () => {
  it('treats a missing endpoint as disabled, not as an error', () => {
    // The rule the whole SDK rests on: absent telemetry must never break the
    // application being instrumented. Not even at startup.
    const cfg = telemetryConfig()

    assert.equal(cfg.enabled, false)
    assert.equal(cfg.endpoint, null)
  })

  it('applies sane defaults', () => {
    withEnv({ INGEST_ENDPOINT: 'http://localhost:3001' })
    const cfg = telemetryConfig()

    assert.equal(cfg.enabled, true)
    assert.equal(cfg.batchSize, 50)
    assert.equal(cfg.flushMs, 200)
    assert.equal(cfg.maxQueue, 1_000)
    assert.equal(cfg.previewChars, 300)
    assert.equal(cfg.redaction, 'both')
  })

  it('coerces numeric strings from the environment', () => {
    withEnv({ INGEST_ENDPOINT: 'http://localhost:3001', OLLIVE_BATCH_SIZE: '10' })
    assert.equal(telemetryConfig().batchSize, 10)
  })

  it('rejects an out-of-range value instead of silently clamping it', () => {
    withEnv({ INGEST_ENDPOINT: 'http://localhost:3001', OLLIVE_BATCH_SIZE: '99999' })
    assert.throws(() => telemetryConfig(), /OLLIVE_BATCH_SIZE/)
  })

  it('rejects a malformed endpoint URL', () => {
    withEnv({ INGEST_ENDPOINT: 'not-a-url' })
    assert.throws(() => telemetryConfig(), /INGEST_ENDPOINT/)
  })
})
