/**
 * Sotto's own browser tools as a thread's activity records name them, so the transcript can tell them from anyone else's
 * (ADR-0154). Main serves them on this server (`BROWSER_MCP_SERVER`); each client spells a call's title its own way.
 */
export const SOTTO_BROWSER_SERVER = 'sotto_browser'

export const SOTTO_BROWSER_TOOLS = [
  'browser_pages', 'browser_open', 'iphone_open', 'browser_start', 'browser_action', 'browser_status', 'browser_finish',
  'iphone_cloud_open', 'iphone_cloud_action', 'iphone_cloud_status', 'iphone_cloud_finish',
] as const
export type SottoBrowserTool = typeof SOTTO_BROWSER_TOOLS[number]

const NAMES: ReadonlySet<string> = new Set(SOTTO_BROWSER_TOOLS)
// Claude Code's `mcp__sotto_browser__browser_open`, Grok's `sotto_browser__browser_open`, Codex's
// `sotto_browser / browser_open` (server and tool joined by its adapter), and a client that joins them with one underscore.
const TITLE = new RegExp(`^(?:mcp__)?${SOTTO_BROWSER_SERVER}(?:__|_| / )([a-z_]+)$`, 'u')

/** The Sotto browser tool an activity record's title names, or undefined for any other tool. */
export function sottoBrowserToolOfTitle(title: string): SottoBrowserTool | undefined {
  const name = TITLE.exec(title)?.[1]
  return name !== undefined && NAMES.has(name) ? name as SottoBrowserTool : undefined
}
