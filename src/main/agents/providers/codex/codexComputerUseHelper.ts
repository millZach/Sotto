import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'

/**
 * Lets a Codex thread's Computer Use run with the Codex desktop app closed. Each time the app starts it writes
 * `SKY_CUA_NATIVE_PIPE = "1"` into the env of the Computer Use servers: `node_repl` in the user's `config.toml`, and
 * `cua_repl` in the installed copy of its bundled `unified-computer-use` plugin. That sends Computer Use through a named
 * pipe only the running app serves. With "0", Codex's own Computer Use library starts its helper
 * (`codex-computer-use.exe`) as a child of the server, which exits with it, and still asks the user before each app with
 * the same confirmation. `SKY_CUA_NATIVE_PIPE` is OpenAI's internal switch, not a documented setting.
 *
 * A server from `config.toml` takes a one-key override. A plugin's server cannot: Codex refuses a partial definition
 * of it ("invalid transport"), so the thread gets the plugin's whole definition with the switch turned off, which
 * Codex uses in place of the plugin's own. Anything not as expected leaves Codex's own definition, and its pipe, alone.
 */
const PIPE = 'SKY_CUA_NATIVE_PIPE'
/** A server or plugin name that can stand in a dotted config key and a folder name. */
const plainName = /^[\w-]+$/u
const effectiveConfig = z.object({ config: z.object({
  mcp_servers: z.record(z.string(), z.unknown()).nullish(),
  plugins: z.record(z.string(), z.unknown()).nullish() }) })
const serverEnv = z.object({ env: z.record(z.string(), z.unknown()).nullish() })
const enabledPlugin = z.object({ enabled: z.literal(true) })
const pluginServers = z.object({ mcpServers: z.record(z.string(), z.unknown()) })
const pluginServer = z.object({ command: z.string(), cwd: z.string().nullish(), env: z.record(z.string(), z.string()) }).passthrough()

export type ComputerUseHelperConfig = {
  /** Dotted thread config keys for `config.toml` servers. */
  keys: Record<string, string>
  /** Whole definitions for plugin servers, to merge into the thread's `mcp_servers`. */
  servers: Record<string, unknown>
}

/**
 * The thread config that turns the app's pipe off, from Codex's effective config (a `config/read` result). Windows
 * only: the switch is read by the library's Windows transport, and a Mac's Computer Use was never tried without it.
 */
export async function computerUseHelperConfig(codexHome: string, value: unknown, platform: NodeJS.Platform = process.platform): Promise<ComputerUseHelperConfig> {
  const result: ComputerUseHelperConfig = { keys: {}, servers: {} }
  const parsed = effectiveConfig.safeParse(value)
  if (platform !== 'win32' || !parsed.success) return result
  const configured = parsed.data.config.mcp_servers ?? {}
  for (const [name, server] of Object.entries(configured)) {
    if (plainName.test(name) && serverEnv.safeParse(server).data?.env?.[PIPE] === '1') result.keys[`mcp_servers.${name}.env.${PIPE}`] = '0'
  }
  for (const [id, entry] of Object.entries(parsed.data.config.plugins ?? {})) {
    const at = id.lastIndexOf('@'), name = id.slice(0, at), marketplace = id.slice(at + 1)
    if (at < 1 || !plainName.test(name) || !plainName.test(marketplace) || !enabledPlugin.safeParse(entry).success) continue
    for (const [server, definition] of await pipedPluginServers(join(codexHome, 'plugins', 'cache', marketplace, name))) {
      if (!(server in configured) && !(server in result.servers)) result.servers[server] = definition
    }
  }
  return result
}

/**
 * A plugin's servers that use the app's pipe, each with the switch off. The app rewrites the installed version's
 * `.mcp.json` each time it starts, so of several versions only the newest file is read: an older one may name a
 * client the app no longer has, and must never replace what the plugin defines now.
 */
async function pipedPluginServers(folder: string): Promise<[string, unknown][]> {
  const versions = await readdir(folder, { withFileTypes: true }).catch(() => [])
  const newest = (await Promise.all(versions.filter(entry => entry.isDirectory()).map(async entry => {
    const file = join(folder, entry.name, '.mcp.json')
    try { return { file, changed: (await stat(file)).mtimeMs } } catch { return undefined }
  }))).reduce<{ file: string; changed: number } | undefined>((best, found) => found && (!best || found.changed > best.changed) ? found : best, undefined)
  if (!newest) return []
  let servers: Record<string, unknown>
  try {
    const read = pluginServers.safeParse(JSON.parse(await readFile(newest.file, 'utf8')))
    if (!read.success) return []
    servers = read.data.mcpServers
  } catch { return [] }
  const piped: [string, unknown][] = []
  for (const [name, value] of Object.entries(servers)) {
    const server = pluginServer.safeParse(value).data
    if (!server || server.env[PIPE] !== '1' || !plainName.test(name)) continue
    // Codex reads a plugin's relative paths against the plugin's folder, which a thread's config has no part in.
    if (!isAbsolute(server.command) || (server.cwd && !isAbsolute(server.cwd))) continue
    if (!await stat(server.command).then(found => found.isFile(), () => false)) continue
    piped.push([name, { ...server, env: { ...server.env, [PIPE]: '0' } }])
  }
  return piped
}
