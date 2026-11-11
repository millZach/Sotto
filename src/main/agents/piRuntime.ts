import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ThreadMcpServer } from './threadToolServer'
import { piEnvironment } from './piRpc'

/** A config per thread prevents tool-server URLs or credentials crossing between threads. Tokens stay in memory. */
export async function piThreadEnvironment(root: string, threadId: string, models: string, servers: readonly ThreadMcpServer[], environment?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const directory = join(root, 'threads', createHash('sha256').update(threadId).digest('hex'))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const keys: Record<string, string> = {}
  const mcpServers = Object.fromEntries(servers.map((server, index) => [server.name, {
    url: server.url, exposure: 'direct', timeout: 3600,
    headers: Object.fromEntries(server.headers.map((header, headerIndex) => {
      const variable = `SOTTO_PI_MCP_${index}_${headerIndex}`
      keys[variable] = header.value
      return [header.name, '${' + variable + '}']
    })),
  }]))
  // These files contain declarations only, never the thread's bearer token or a provider key.
  await writeFile(join(directory, 'models.json'), models, { mode: 0o600 })
  await writeFile(join(directory, 'mcp.json'), JSON.stringify({ mcpServers }), { mode: 0o600 })
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ autoCompact: false, autoRetry: false }), { mode: 0o600 })
  return piEnvironment(directory, keys, environment)
}

export const PI_ISOLATION_ARGS = ['--no-extensions', '-e', 'builtin:mcp', '--no-skills', '--no-prompt-templates', '--no-approve', '--no-themes'] as const
