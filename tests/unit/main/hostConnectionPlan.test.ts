import { describe, expect, it } from 'vitest'
import { afterTailnetFailure, BOOT_TAILNET_ONLY_MS, classifyTailnetFailure, connectOrder, tryTailnetAfterSsh, type ConnectFacts } from '../../../src/main/hosts/hostConnectionPlan'
import { isTailnetAddress } from '../../../src/shared/hostConnection'
import { HostConnectionError, WrongHostError } from '../../../src/main/agents/socketHostService'

// The order of a connect (ADR-0053), row by row.
const ADDRESS = 'https://forge.tail5728ca.ts.net:8443'
const facts = (patch: Partial<ConnectFacts> = {}): ConnectFacts => ({ prefer: 'tailnet', address: ADDRESS, paired: true, adding: false, ...patch })

describe('connectOrder', () => {
  it('keeps a host with no entry, which prefers SSH, on SSH', () => {
    expect(connectOrder(facts({ prefer: 'ssh' }))).toEqual(['ssh'])
  })
  it('tries the tailnet first and SSH after it when the owner prefers it, an address is known and this computer is paired', () => {
    expect(connectOrder(facts())).toEqual(['tailnet', 'ssh'])
  })
  it('goes over SSH while no address is known, this computer is not paired, or Add host is pairing it', () => {
    expect(connectOrder(facts({ address: undefined }))).toEqual(['ssh'])
    expect(connectOrder(facts({ paired: false }))).toEqual(['ssh'])
    expect(connectOrder(facts({ adding: true }))).toEqual(['ssh'])
  })
  it('goes over SSH for the first connect after Edit connection is saved, which tries the saved route', () => {
    expect(connectOrder(facts({ edited: true }))).toEqual(['ssh'])
  })
  it('tries only the tailnet for the first minute of retries of a host that starts at boot and was on its tailnet', () => {
    expect(connectOrder(facts({ startedBy: 'boot', lastVia: 'tailnet', retryingForMs: 0 }))).toEqual(['tailnet'])
    expect(connectOrder(facts({ startedBy: 'boot', lastVia: 'tailnet', retryingForMs: BOOT_TAILNET_ONLY_MS - 1 }))).toEqual(['tailnet'])
    expect(connectOrder(facts({ startedBy: 'boot', lastVia: 'tailnet', retryingForMs: BOOT_TAILNET_ONLY_MS }))).toEqual(['tailnet', 'ssh'])
  })
  it('tries SSH after the tailnet for every other host, and for a boot host that was on SSH or is not retrying', () => {
    expect(connectOrder(facts({ startedBy: 'launch-script', lastVia: 'tailnet', retryingForMs: 0 }))).toEqual(['tailnet', 'ssh'])
    expect(connectOrder(facts({ startedBy: 'boot', lastVia: 'ssh', retryingForMs: 0 }))).toEqual(['tailnet', 'ssh'])
    expect(connectOrder(facts({ startedBy: 'boot', lastVia: 'tailnet' }))).toEqual(['tailnet', 'ssh'])
  })
})

describe('afterTailnetFailure', () => {
  it('sends a tailnet that did not answer, or answered as another host, to SSH with the note, which waits for the 5-minute check', () => {
    expect(afterTailnetFailure('tailnet-unreachable', ['tailnet', 'ssh'])).toEqual({ next: 'ssh', note: 'unreachable' })
    expect(afterTailnetFailure('tailnet-wrong-host', ['tailnet', 'ssh'])).toEqual({ next: 'ssh', note: 'unreachable' })
  })
  it('sends what SSH mends to SSH with no note, so the tailnet is tried again as soon as SSH is up', () => {
    for (const failure of ['tailnet-not-desktop', 'pairing-required', 'version-mismatch'] as const) expect(afterTailnetFailure(failure, ['tailnet', 'ssh'])).toEqual({ next: 'ssh' })
  })
  it('retries the tailnet alone in the first minute of a boot host when it did not answer, and sends anything SSH mends to SSH', () => {
    expect(afterTailnetFailure('tailnet-unreachable', ['tailnet'])).toEqual({ next: 'retry-tailnet' })
    expect(afterTailnetFailure('pairing-required', ['tailnet'])).toEqual({ next: 'ssh' })
    expect(afterTailnetFailure('tailnet-wrong-host', ['tailnet'])).toEqual({ next: 'ssh', note: 'unreachable' })
  })
})

describe('tryTailnetAfterSsh', () => {
  it('moves across only when the owner prefers the tailnet, an address is known and this computer is paired', () => {
    expect(tryTailnetAfterSsh(facts())).toBe(true)
    expect(tryTailnetAfterSsh(facts({ prefer: 'ssh' }))).toBe(false)
    expect(tryTailnetAfterSsh(facts({ address: undefined }))).toBe(false)
    expect(tryTailnetAfterSsh(facts({ paired: false }))).toBe(false)
  })
  it('waits for the 5-minute check only for the address that just failed, and tries a new one at once', () => {
    expect(tryTailnetAfterSsh({ ...facts(), failed: ADDRESS })).toBe(false)
    expect(tryTailnetAfterSsh({ ...facts(), failed: 'https://forge-old.tail5728ca.ts.net:8443' })).toBe(true)
  })
})

describe('classifyTailnetFailure', () => {
  it('classes a failure by its code, never its message', () => {
    expect(classifyTailnetFailure(new TypeError('fetch failed'))).toBe('tailnet-unreachable')
    expect(classifyTailnetFailure(new HostConnectionError('The host did not answer its health check. Connect again.', 'unavailable'))).toBe('tailnet-unreachable')
    expect(classifyTailnetFailure(new HostConnectionError('x', 'disconnected'))).toBe('tailnet-unreachable')
    expect(classifyTailnetFailure(new WrongHostError())).toBe('tailnet-wrong-host')
    expect(classifyTailnetFailure(new HostConnectionError('x', 'forbidden'))).toBe('tailnet-not-desktop')
    expect(classifyTailnetFailure(new HostConnectionError('x', 'unauthenticated', undefined, true))).toBe('pairing-required')
    expect(classifyTailnetFailure(new HostConnectionError('x', 'version_mismatch'))).toBe('version-mismatch')
  })
})

describe('isTailnetAddress', () => {
  it('accepts only https on a MagicDNS name with its port', () => {
    expect(isTailnetAddress(ADDRESS)).toBe(true)
    for (const value of ['http://forge.tail5728ca.ts.net:8443', 'https://forge.tail5728ca.ts.net', 'https://forge.example.com:8443', 'https://user@forge.tail5728ca.ts.net:8443',
      'https://forge.tail5728ca.ts.net:8443/v1', 'https://forge.tail5728ca.ts.net:8443?x=1', 'https://127.0.0.1:8443', 'https://forge.ts.net.example.com:8443', 42, undefined, null]) {
      expect(isTailnetAddress(value)).toBe(false)
    }
  })
})
