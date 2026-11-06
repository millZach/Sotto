import { describe, expect, it } from 'vitest'
import { parseProviderRecords } from '../../fixtures/providerRecords'

// The fakes append one newline-terminated record at a time, and a reader can land mid-append (#1622).
describe('parseProviderRecords', () => {
  it('leaves a trailing line with no newline yet for the next read', () => {
    expect(parseProviderRecords('{"a":1}\n{"b":2}\n{"c":"hal')).toEqual([{ a: 1 }, { b: 2 }])
    expect(parseProviderRecords('{"a":1}\n{"b":2}\n{"c":"hal', { trim: false })).toEqual([{ a: 1 }, { b: 2 }])
    expect(parseProviderRecords('{"a":')).toEqual([])
  })

  it('reads every finished record and still throws on a finished line that is not JSON', () => {
    expect(parseProviderRecords('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }])
    expect(() => parseProviderRecords('{"a":1}\n{"b":\n')).toThrow(SyntaxError)
  })
})
