import { describe, expect, it } from 'vitest'

import { selectRendererSource, secureWebPreferences } from '../../../src/main/security'

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
