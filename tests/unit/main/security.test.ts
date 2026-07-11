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
    expect(selectRendererSource(false, 'http://localhost:5173', 'C:/app/index.html')).toEqual({
      kind: 'url',
      value: 'http://localhost:5173',
    })
  })

  it('uses bundled HTML when packaged even if a development URL is set', () => {
    expect(selectRendererSource(true, 'https://example.invalid', 'C:/app/index.html')).toEqual({
      kind: 'file',
      value: 'C:/app/index.html',
    })
  })

  it('uses bundled HTML when no development URL is available', () => {
    expect(selectRendererSource(false, undefined, 'C:/app/index.html')).toEqual({
      kind: 'file',
      value: 'C:/app/index.html',
    })
  })
})
