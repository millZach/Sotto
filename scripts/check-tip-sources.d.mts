export interface TipSource {
  readonly provider: string
  readonly url: string
  readonly phrase: string
  readonly checked: string
}

export interface ReportedTipSource extends TipSource {
  readonly id: string
  readonly reason: 'missing' | 'gone'
}

export const TIP_SOURCES_PATH: string
export function pageText(html: string): string
export function carries(text: string, phrase: string): boolean
export function checkTipSources(sources: Readonly<Record<string, TipSource>>, fetchPage: (url: string) => Promise<{ readonly status: number; readonly text: string }>): Promise<{
  readonly reported: readonly ReportedTipSource[]
  readonly warned: readonly { readonly id: string; readonly url: string; readonly reason: string }[]
}>
export function reportMarkdown(reported: readonly ReportedTipSource[]): string
