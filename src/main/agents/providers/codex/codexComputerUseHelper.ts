import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'

/**
 * Lets a Codex thread's Computer Use run with the Codex desktop app closed. Each time the app starts it writes
 * `SKY_CUA_NATIVE_PIPE = "1"` into the env of the Computer Use servers: `node_repl` in the user's `config.toml`, and
 * `cua_repl` in the installed copy of its bundled `unified-computer-use` plugin. That sends Computer Use through a named
 * pipe only the running app serves. With "0", Codex's own Computer Use library starts its helper
 * (`codex-computer-use.exe`) as a child of the server, which exits with it. Its question before each app goes through
 * Codex the same way either way. `SKY_CUA_NATIVE_PIPE` is OpenAI's internal switch, not a documented setting.
 *
 * Everything goes in the thread's one `mcp_servers` table: Codex applies a thread's config keys in no fixed order, and
 * a whole table set after a dotted `mcp_servers.…` key would wipe it out. A `config.toml` server takes just the env
 * key, which Codex merges into the user's definition. A plugin's server cannot: Codex refuses a partial definition of
 * it ("invalid transport"), so the thread gets the plugin's whole definition with the switch turned off, which Codex
 * uses in place of the plugin's own. Anything not as expected leaves Codex's own definition, and its pipe, alone.
 */
const PIPE = 'SKY_CUA_NATIVE_PIPE'
/** A server or plugin name that can stand in a config key and a folder name. */
const plainName = /^[\w-]+$/u
/** A version folder's name as Codex 0.170.0 allows it (`validate_plugin_version_segment`). */
const versionSegment = /^[A-Za-z0-9._+-]+$/u
/** A plain release as semver parses it: no leading zeros, no pre-release or build part. */
const release = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
/** A semver with a pre-release or build part, whose order against another Sotto does not reproduce. */
const semverWithExtras = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+(?:\+[0-9A-Za-z.-]+)?|\+[0-9A-Za-z.-]+)$/u
const LOCAL_VERSION = 'local'
const effectiveConfig = z.object({ config: z.object({
  mcp_servers: z.record(z.string(), z.unknown()).nullish(),
  plugins: z.record(z.string(), z.unknown()).nullish() }) })
const serverEnv = z.object({ env: z.record(z.string(), z.unknown()).nullish() })
/** An enabled plugin. Its `mcp_servers` table is the user's own policy for its servers, which Sotto never overrides. */
const enabledPlugin = z.object({ enabled: z.literal(true), mcp_servers: z.record(z.string(), z.unknown()).nullish() })
const pluginManifest = z.object({ mcpServers: z.enum(['./.mcp.json', '.mcp.json']) })
const pluginServers = z.object({ mcpServers: z.record(z.string(), z.unknown()) })
const pluginServer = z.object({ command: z.string(), cwd: z.string().nullish(), env: z.record(z.string(), z.string()) }).passthrough()

/**
 * What goes into a thread's `mcp_servers` to turn the app's pipe off, from Codex's effective config (a `config/read`
 * result). Windows only: the switch is read by the library's Windows transport, and a Mac was never tried without it.
 */
export async function computerUseHelperServers(codexHome: string, value: unknown, platform: NodeJS.Platform = process.platform): Promise<Record<string, unknown>> {
  const servers: Record<string, unknown> = {}
  const parsed = effectiveConfig.safeParse(value)
  if (platform !== 'win32' || !parsed.success) return servers
  const configured = parsed.data.config.mcp_servers ?? {}
  for (const [name, server] of Object.entries(configured)) {
    if (plainName.test(name) && serverEnv.safeParse(server).data?.env?.[PIPE] === '1') servers[name] = { env: { [PIPE]: '0' } }
  }
  for (const [id, entry] of Object.entries(parsed.data.config.plugins ?? {})) {
    const at = id.lastIndexOf('@'), name = id.slice(0, at), marketplace = id.slice(at + 1)
    const plugin = enabledPlugin.safeParse(entry).data
    if (at < 1 || !plainName.test(name) || !plainName.test(marketplace) || !plugin) continue
    for (const [server, definition] of await pluginServersWithoutPipe(join(codexHome, 'plugins', 'cache', marketplace, name))) {
      if (!(server in configured) && !(server in servers) && !(server in (plugin.mcp_servers ?? {}))) servers[server] = definition
    }
  }
  return servers
}

/**
 * Codex's order of two versions (`compare_plugin_versions`): as releases when both are, otherwise as bytes. A version
 * with a pre-release or build part is a semver Sotto does not order, so it answers none.
 */
function compareVersions(left: string, right: string): number | undefined {
  if (semverWithExtras.test(left) || semverWithExtras.test(right)) return undefined
  const a = release.exec(left), b = release.exec(right)
  if (a && b) return Number(a[1]) - Number(b[1]) || Number(a[2]) - Number(b[2]) || Number(a[3]) - Number(b[3])
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The version Codex loads (`active_plugin_version`): of the folders its rule allows, `local` if there is one, else the
 * one above every other. None when Sotto cannot be sure which that is, which leaves Codex's own definition in place.
 */
async function activeVersion(folder: string): Promise<string | undefined> {
  const versions = (await readdir(folder, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory())
    .map(entry => entry.name).filter(name => versionSegment.test(name) && name !== '.' && name !== '..')
  if (versions.includes(LOCAL_VERSION)) return LOCAL_VERSION
  return versions.find(candidate => versions.every(other => other === candidate || (compareVersions(candidate, other) ?? 0) > 0))
}

/** The active version's servers that use the app's pipe, each with the switch off. */
async function pluginServersWithoutPipe(folder: string): Promise<[string, unknown][]> {
  const version = await activeVersion(folder)
  if (!version) return []
  let servers: Record<string, unknown>
  try {
    const root = join(folder, version)
    if (!pluginManifest.safeParse(JSON.parse(await readFile(join(root, '.codex-plugin', 'plugin.json'), 'utf8'))).success) return []
    const read = pluginServers.safeParse(JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')))
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
