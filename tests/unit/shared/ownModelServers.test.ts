// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isPrivateHost, OWN_SERVER_WORDS, ownServerAddress, ownServerRefusalSchema, ownServerRefusalWords } from '../../../src/shared/ownModelServers'

describe('isPrivateHost', () => {
  it.each([
    'localhost', '127.0.0.1', '127.8.9.1', '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.20', '169.254.10.10',
    '100.64.0.1', '100.101.102.103', '100.127.255.254', '::1', '[::1]', 'fd7a:115c:a1e0::1', 'fe80::1', 'forge', 'spark-head',
    'box.local', 'nas.lan', 'printer.home.arpa', 'svc.internal', 'spark.tail1234.ts.net', 'app.localhost', 'SPARK.TAIL1234.TS.NET.',
  ])('counts %s as private', host => { expect(isPrivateHost(host)).toBe(true) })
  it.each(['8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '192.169.0.1', 'example.com', 'api.openai.com', '2001:db8::1', 'ts.net.example.com'])(
    'counts %s as public', host => { expect(isPrivateHost(host)).toBe(false) })
})

describe('ownServerAddress', () => {
  it('gives http and /v1 when they were left out', () => {
    expect(ownServerAddress('localhost:11434')).toEqual({ ok: true, address: 'http://localhost:11434/v1', host: 'localhost:11434' })
    expect(ownServerAddress('  http://spark-head:8888/  ')).toEqual({ ok: true, address: 'http://spark-head:8888/v1', host: 'spark-head:8888' })
  })
  it('keeps a path the user gave, without its trailing slash', () => {
    expect(ownServerAddress('http://localhost:1234/v1/')).toMatchObject({ ok: true, address: 'http://localhost:1234/v1' })
    expect(ownServerAddress('https://proxy.example.com/openai/v1')).toMatchObject({ ok: true, address: 'https://proxy.example.com/openai/v1' })
  })
  it('takes https to a public host and plain http only to a private one', () => {
    expect(ownServerAddress('https://models.example.com')).toMatchObject({ ok: true, address: 'https://models.example.com/v1' })
    expect(ownServerAddress('http://models.example.com:8000')).toEqual({ ok: false, reason: 'public-http', host: 'models.example.com:8000' })
    expect(ownServerAddress('models.example.com')).toMatchObject({ ok: false, reason: 'public-http' })
    expect(ownServerAddress('http://100.90.1.2:30000')).toMatchObject({ ok: true, address: 'http://100.90.1.2:30000/v1' })
    expect(ownServerAddress('http://[fd7a:115c:a1e0::1]:8000')).toMatchObject({ ok: true, address: 'http://[fd7a:115c:a1e0::1]:8000/v1' })
  })
  it('refuses what is not an address Sotto can reach', () => {
    for (const typed of ['', 'http://', 'ftp://localhost/v1', 'http://user:pass@localhost:8000', 'http://localhost:8000/v1?x=1', 'http://localhost:8000/#top', 'http://a b']) {
      expect(ownServerAddress(typed), typed).toMatchObject({ ok: false, reason: 'bad-address' })
    }
  })
  it('refuses an address too long for the record to hold', () => {
    expect(ownServerAddress(`http://localhost:8000/${'a'.repeat(400)}`)).toMatchObject({ ok: false, reason: 'bad-address' })
  })
})

describe('ownServerRefusalWords', () => {
  it('has words for every refusal, naming the host or the server', () => {
    for (const reason of ownServerRefusalSchema.options) expect(ownServerRefusalWords(reason, 'spark:8888', 'Spark').length).toBeGreaterThan(10)
    expect(ownServerRefusalWords('unreachable', 'spark:8888')).toContain('spark:8888')
    expect(ownServerRefusalWords('sign-in-failed', 'spark:8888', 'Spark')).toContain('Spark')
    expect(ownServerRefusalWords('failed', 'spark:8888')).toBe(OWN_SERVER_WORDS.failed)
  })
})
