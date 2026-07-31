import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { preview, redact } from './redact.js'

describe('redact', () => {
  it('replaces an email with a stable token', () => {
    const a = redact('contact me at jane.doe@example.com please')
    const b = redact('jane.doe@example.com')

    assert.equal(a.hits, 1)
    assert.doesNotMatch(a.text, /jane\.doe@example\.com/)
    assert.match(a.text, /\[EMAIL:[0-9a-f]{8}\]/)

    // The same value must always produce the same token, so "how many distinct
    // users hit this" stays answerable without storing anything readable.
    const tokenA = a.text.match(/\[EMAIL:[0-9a-f]{8}\]/)![0]
    const tokenB = b.text.match(/\[EMAIL:[0-9a-f]{8}\]/)![0]
    assert.equal(tokenA, tokenB)
  })

  it('redacts a Luhn-valid card number', () => {
    const r = redact('card 4111 1111 1111 1111 on file')
    assert.equal(r.hits, 1)
    assert.doesNotMatch(r.text, /4111/)
  })

  it('leaves a 16-digit number that fails Luhn alone', () => {
    // Without the checksum, every order number and request ID gets mangled,
    // and people switch the redactor off. This is the test that keeps it usable.
    const r = redact('order 1234567812345678 shipped')
    assert.equal(r.hits, 0)
    assert.match(r.text, /1234567812345678/)
  })

  it('rejects SSN ranges the SSA never issues', () => {
    assert.equal(redact('id 000-12-3456').hits, 0)
    assert.equal(redact('id 666-12-3456').hits, 0)
    assert.equal(redact('id 900-12-3456').hits, 0)
    assert.equal(redact('ssn 123-45-6789').hits, 1)
  })

  it('redacts provider API keys', () => {
    const r = redact('use sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456 here')
    assert.equal(r.hits, 1)
    assert.doesNotMatch(r.text, /sk-ant-api03/)
  })

  it('redacts a JWT before the card pattern can maul it', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const r = redact(`token ${jwt}`)
    assert.equal(r.byKind.JWT, 1)
    assert.doesNotMatch(r.text, /eyJhbGciOi/)
  })

  it('leaves ordinary prose untouched', () => {
    const text = 'What is the capital of France? Explain in two sentences.'
    const r = redact(text)
    assert.equal(r.hits, 0)
    assert.equal(r.text, text)
  })

  it('counts by kind for the dashboard panel', () => {
    const r = redact('a@b.com and c@d.com and 4111111111111111')
    assert.equal(r.byKind.EMAIL, 2)
    assert.equal(r.byKind.CARD, 1)
    assert.equal(r.hits, 3)
  })

  it('handles null and empty input', () => {
    assert.equal(redact(null).hits, 0)
    assert.equal(redact(undefined).text, '')
    assert.equal(redact('').hits, 0)
  })
})

describe('preview', () => {
  it('redacts before truncating', () => {
    // Truncating first can slice an identifier in half; the surviving fragment
    // is both un-matchable and still sensitive.
    const text = `${'x'.repeat(20)} jane.doe@example.com ${'y'.repeat(200)}`
    const p = preview(text, 60)

    assert.doesNotMatch(p.text!, /jane\.doe/)
    assert.equal(p.hits, 1)
    assert.ok(p.text!.length <= 61)
  })

  it('returns null for absent input rather than an empty string', () => {
    assert.equal(preview(null, 100).text, null)
  })
})
