/** What a terminal may allow the CLI in it to do. Each provider spells these differently; the labels are Sotto's. */
export type TerminalPermission = 'ask' | 'edits' | 'everything'

export interface ProviderCommandOptions {
  /** The CLI's own model name, not Sotto's public model ID. */
  readonly model: string | null
  readonly reasoning: string | null
  readonly permission: TerminalPermission | null
}
