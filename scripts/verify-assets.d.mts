export function verifyTerminalAssets(options?: {
  readonly nodePtyRoot?: string
  readonly platform?: string
  readonly arch?: string
}): Promise<{ readonly version: string; readonly files: number }>

export function verifyReleaseAssets(): Promise<{
  readonly claude: { readonly version: string; readonly files: number }
  readonly terminal: { readonly version: string; readonly files: number }
}>
