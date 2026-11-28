// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import {
  enableWasmThreadSupport,
  disableChromiumFeatures,
  disableDnsPrefetching,
  blockSpellcheckDictionaryDownloads,
  selectRendererSource,
  secureWebPreferences,
} from '../../../src/main/security'

describe('spellcheck privacy', () => {
  it('keeps spellcheck enabled while giving Hunspell a hostless download URL', () => {
    const setSpellCheckerDictionaryDownloadURL = vi.fn()
    const setSpellCheckerEnabled = vi.fn()
    const session = { setSpellCheckerDictionaryDownloadURL, setSpellCheckerEnabled }
    blockSpellcheckDictionaryDownloads(session)

    expect(setSpellCheckerDictionaryDownloadURL).toHaveBeenCalledWith('data:,')
    expect(setSpellCheckerEnabled).not.toHaveBeenCalled()
  })
})

describe('secureWebPreferences', () => {
  it('isolates every renderer from Node', () => {
    expect(secureWebPreferences('C:/app/preload.js')).toMatchObject({
      preload: 'C:/app/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    })
  })
})

describe('selectRendererSource', () => {
  it('uses the development URL only while unpackaged', () => {
    expect(
      selectRendererSource(
        false,
        new URL('http://localhost:5173/index.html'),
        'C:/app/index.html',
      ),
    ).toEqual({
      kind: 'url',
      value: 'http://localhost:5173/index.html',
    })
  })

  it('uses bundled HTML when packaged even if a development URL is set', () => {
    expect(
      selectRendererSource(
        true,
        new URL('https://example.invalid/renderer'),
        'C:/app/index.html',
      ),
    ).toEqual({ kind: 'file', value: 'C:/app/index.html' })
  })

  it('uses bundled HTML when no development URL is available', () => {
    expect(selectRendererSource(false, undefined, 'C:/app/index.html')).toEqual({
      kind: 'file',
      value: 'C:/app/index.html',
    })
  })

  it.each([
    'https://attacker.invalid/index.html',
    'http://user:password@localhost:5173/index.html',
    'file:///C:/renderer/index.html',
    'http://192.168.1.4:5173/index.html',
    'http://localhost:5173/unexpected.html',
  ])('rejects an unsafe unpackaged renderer URL: %s', (raw) => {
    expect(selectRendererSource(false, new URL(raw), 'C:/app/index.html')).toEqual({
      kind: 'file',
      value: 'C:/app/index.html',
    })
  })
})

describe('wasm thread support', () => {
  it('enables SharedArrayBuffer for multithreaded local inference before app readiness', () => {
    const appended: Array<readonly [string, string]> = []

    enableWasmThreadSupport({
      appendSwitch: (key: string, value: string) => {
        appended.push([key, value])
      },
    })

    expect(appended).toEqual([['enable-features', 'SharedArrayBuffer']])
  })
})

describe('DNS prefetching', () => {
  it.each([
    ['', 'dnsPrefetchingEnabled=false'],
    ['preferredColorScheme=2', 'preferredColorScheme=2,dnsPrefetchingEnabled=false'],
    ['dnsPrefetchingEnabled=true', 'dnsPrefetchingEnabled=true,dnsPrefetchingEnabled=false'],
  ])('disables prefetching while keeping existing Blink settings: %s', (existing, expected) => {
    const appendSwitch = vi.fn()
    const getSwitchValue = vi.fn(() => existing)
    disableDnsPrefetching({ appendSwitch, getSwitchValue })
    expect(getSwitchValue).toHaveBeenCalledWith('blink-settings')
    expect(appendSwitch).toHaveBeenCalledWith('blink-settings', expected)
  })
})

describe('Chromium features turned off', () => {
  // The desktop browser takes every document did-navigate reports as new, which a typed secret's rules hold only while
  // no back-forward cache gives an old one back (ADR-0222, decision 12).
  it.each([
    ['linux', '', 'BackForwardCache'],
    ['darwin', 'Translate', 'Translate,BackForwardCache'],
    ['win32', '', 'CalculateNativeWinOcclusion,BackForwardCache'],
    ['win32', 'BackForwardCache,Translate', 'BackForwardCache,Translate,CalculateNativeWinOcclusion'],
  ] as const)('turns off the back-forward cache on %s, keeping what was off already: %s', (platform, existing, expected) => {
    const appendSwitch = vi.fn()
    disableChromiumFeatures({ appendSwitch, getSwitchValue: () => existing }, platform)
    // One switch only: Chromium takes the last --disable-features it is given.
    expect(appendSwitch.mock.calls).toEqual([['disable-features', expected]])
  })
})
