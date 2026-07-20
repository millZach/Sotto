import type { WebPreferences } from 'electron'

export type RendererRole = 'main' | 'widget'

export type RendererSource =
  | Readonly<{ kind: 'url'; value: string }>
  | Readonly<{ kind: 'file'; value: string }>

export interface CommandLineAdapter {
  appendSwitch(key: string, value: string): void
}

/**
 * Chromium withholds SharedArrayBuffer without cross-origin isolation, which
 * file:// renderers can never satisfy. Enabling the feature directly keeps the
 * local inference worker eligible for multithreaded WASM. Must run before the
 * app is ready.
 */
export function enableWasmThreadSupport(commandLine: CommandLineAdapter): void {
  commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')
}

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
    url.pathname === '/index.html' || url.pathname === '/widget.html'

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
