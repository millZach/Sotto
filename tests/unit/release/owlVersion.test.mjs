// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { owlBuildArguments, resolveOwlVersion } from '../../../scripts/owl-release.mjs'

describe('Owl build version', () => {
  it('uses the next stable patch and an explicit daily number', () => {
    expect(resolveOwlVersion('0.1.34', '20261009', '1')).toBe('0.1.35-owl.20261009.1')
    expect(resolveOwlVersion('0.1.34', '20261009', '10')).toBe('0.1.35-owl.20261009.10')
    expect(resolveOwlVersion('1.2.99', '20261010', '2')).toBe('1.2.100-owl.20261010.2')
  })
  it.each(['0.1.34-owl.20261009.1', '0.1', '01.1.34'])('refuses a non-stable base %s', base => {
    expect(() => resolveOwlVersion(base, '20261009', '1')).toThrow('plain stable')
  })
  it.each(['20260229', '20261301', '2026109'])('refuses an invalid date %s', date => {
    expect(() => resolveOwlVersion('0.1.34', date, '1')).toThrow('UTC build date')
  })
  it.each([undefined, '0', '01', '-1', '1.5'])('refuses an invalid daily number %s', number => {
    expect(() => resolveOwlVersion('0.1.34', '20261009', number)).toThrow('daily build number')
  })
  it('defaults the UTC date while accepting a date override', () => {
    expect(owlBuildArguments(['--number', '2'], '20261009')).toEqual({ date: '20261009', number: '2' })
    expect(owlBuildArguments(['--date', '20261010', '--number', '1'])).toEqual({ date: '20261010', number: '1' })
  })
  it.each([['--foo', '1'], ['--number'], ['--number', '1', '--number', '2']])('refuses ambiguous arguments %s', (...args) => {
    expect(() => owlBuildArguments(args)).toThrow('Usage')
  })
})
