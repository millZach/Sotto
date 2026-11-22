import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { ThreadMcpServer } from './threadToolServer'

/**
 * The MCP servers the user set up for their own `agy`, handed to a thread's session beside Sotto's (parity slice 3).
 * `agy` runs in Sotto's own folder (`antigravityFolders.ts`), so it never reads the user's `~/.gemini` itself; this
 * reads that one file, `~/.gemini/config/mcp_config.json`, each time a provider session starts and hands its servers
 * over in ACP's `session/new` and `session/resume`, as Claude Code reads the user's own setup. The values, keys among them, go only
 * to `agy` on this computer, through its standard input: never to a log, the renderer or another computer.
 */
export function antigravityUserMcpConfig(home = homedir()): string { return join(home, '.gemini', 'config', 'mcp_config.json') }

/** A local MCP server as ACP takes it: `agy` starts the command with these arguments and variables. */
export interface AntigravityStdioServer { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
/** What a session starts with: Sotto's own HTTP servers and the user's local or HTTP ones. */
export type AntigravitySessionServer = ThreadMcpServer | AntigravityStdioServer

const strings = z.record(z.string(), z.string())
// `agy`'s own schema (antigravity.google/docs/mcp): `command`, `args` and `env` for a local server, `url` or
// `serverUrl` for Streamable HTTP, `disabled` to switch one off. `tools` and `timeoutSeconds` only tune a server, so a
// server with them still goes, without them.
const entrySchema = z.object({
  command: z.string().min(1).optional(), args: z.array(z.string()).optional(), env: strings.optional(),
  url: z.string().min(1).optional(), serverUrl: z.string().min(1).optional(), headers: strings.optional(),
  disabled: z.boolean().optional(),
  // What ACP's `session/new` cannot carry, and `agy` 1.5.14 ignores there: a server that needs one would run otherwise
  // than the user set it up, its hidden tools shown, in another folder or without its sign-in, so it is left out.
  enabledTools: z.unknown().optional(), disabledTools: z.unknown().optional(), cwd: z.unknown().optional(), oauth: z.unknown().optional(),
  authProviderType: z.unknown().optional(),
})
type Entry = z.infer<typeof entrySchema>
const needsMoreThanAcp = (entry: Entry) => entry.enabledTools !== undefined || entry.cwd !== undefined || entry.oauth !== undefined
  || entry.authProviderType !== undefined || (entry.disabledTools !== undefined && !(Array.isArray(entry.disabledTools) && entry.disabledTools.length === 0))
const configSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()).optional() })
const pairs = (record: Record<string, string> | undefined) => Object.entries(record ?? {}).map(([name, value]) => ({ name, value }))

/**
 * The servers in the user's file, in its order. A missing, empty or unreadable file is no servers, and an entry `agy`
 * could not run (no command or address, a non-HTTP address, switched off) or could not run as set up (a setting ACP
 * cannot carry, such as `disabledTools`) is left out alone. `httpServers` is false when this `agy` refuses HTTP
 * servers, so only local ones go.
 */
export async function readAntigravityUserServers(path: string, httpServers: boolean): Promise<AntigravitySessionServer[]> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch { return [] }
  if (!text.trim()) return []
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return [] }
  const config = configSchema.safeParse(parsed)
  if (!config.success) return []
  const servers: AntigravitySessionServer[] = []
  for (const [name, value] of Object.entries(config.data.mcpServers ?? {})) {
    const entry = entrySchema.safeParse(value)
    if (!name || !entry.success || entry.data.disabled || needsMoreThanAcp(entry.data)) continue
    const url = entry.data.url ?? entry.data.serverUrl
    if (entry.data.command) servers.push({ name, command: entry.data.command, args: entry.data.args ?? [], env: pairs(entry.data.env) })
    else if (url && httpServers && /^https?:\/\/./i.test(url)) servers.push({ name, type: 'http', url, headers: pairs(entry.data.headers) })
  }
  return servers
}
