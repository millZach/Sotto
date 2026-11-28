import type { Session, WebPreferences } from 'electron'

/** Keep the OS spellchecker available without contacting Chromium's dictionary CDN. */
export function blockSpellcheckDictionaryDownloads(
  session: Pick<Session, 'setSpellCheckerDictionaryDownloadURL'>,
): void {
  // Electron appends the dictionary filename to this base URL. A data URL has
  // no host and cannot produce a valid Hunspell dictionary or a network fetch.
  session.setSpellCheckerDictionaryDownloadURL('data:,')
}

/** The popup's window (ADR-0181) is its own role: it may call only the channels that name it. */
export type RendererRole = 'main' | 'widget' | 'popup'

export type RendererSource =
  | Readonly<{ kind: 'url'; value: string }>
  | Readonly<{ kind: 'file'; value: string }>

export interface CommandLineAdapter {
  appendSwitch(key: string, value: string): void
}

/** Turn off DNS prefetching before app readiness, preserving other Blink settings. */
export function disableDnsPrefetching(commandLine: CommandLineAdapter & { getSwitchValue(key: string): string }): void {
  const existing = commandLine.getSwitchValue('blink-settings')
  commandLine.appendSwitch('blink-settings', `${existing ? `${existing},` : ''}dnsPrefetchingEnabled=false`)
}

/**
 * The Chromium features Sotto turns off, before the app is ready, keeping any the caller turned off already: one
 * `disable-features` switch, as Chromium takes only the last. Hidden browser captures need a native surface on
 * Windows (ADR-0020). The back-forward cache is off everywhere: a document it gives back keeps its script and its
 * fields, and the browser takes every document its `did-navigate` reports as a new one, which a typed secret's rules
 * hold only while that is so (ADR-0222, decision 12).
 */
export function disableChromiumFeatures(commandLine: CommandLineAdapter & { getSwitchValue(key: string): string }, platform: NodeJS.Platform): void {
  const disabled = new Set(commandLine.getSwitchValue('disable-features').split(',').filter(Boolean))
  if (platform === 'win32') disabled.add('CalculateNativeWinOcclusion')
  disabled.add('BackForwardCache')
  commandLine.appendSwitch('disable-features', [...disabled].join(','))
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
    url.pathname === '/index.html' || url.pathname === '/widget.html' || url.pathname === '/popup.html'

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
