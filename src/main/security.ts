import type { WebPreferences } from 'electron'

export type RendererSource =
  | Readonly<{ kind: 'url'; value: string }>
  | Readonly<{ kind: 'file'; value: string }>

export function secureWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  }
}

export function selectRendererSource(
  isPackaged: boolean,
  developmentUrl: URL | undefined,
  bundledHtml: string,
): RendererSource {
  if (!isPackaged && developmentUrl && isTrustedDevelopmentRenderer(developmentUrl)) {
    return { kind: 'url', value: developmentUrl.href }
  }

  return { kind: 'file', value: bundledHtml }
}

function isTrustedDevelopmentRenderer(url: URL): boolean {
  const hostname = url.hostname.toLowerCase()
  const isLoopback =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  const isKnownDocument =
    url.pathname === '/src/renderer/index.html' ||
    url.pathname === '/src/renderer/widget.html'

  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    isLoopback &&
    isKnownDocument &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
  )
}
