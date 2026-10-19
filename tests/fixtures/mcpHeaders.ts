/**
 * The headers a provider was given for one of Sotto's servers, in the list form Sotto's thread servers hand out
 * (`ThreadMcpServer.headers`). Codex, Claude Code and OpenCode keep them as a record of name to value in their config.
 */
export function headerList(headers: Readonly<Record<string, string>>): { name: string; value: string }[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }))
}
