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
  developmentUrl: string | undefined,
  bundledHtml: string,
): RendererSource {
  if (!isPackaged && developmentUrl) {
    return { kind: 'url', value: developmentUrl }
  }

  return { kind: 'file', value: bundledHtml }
}
