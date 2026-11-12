import { mkdir, rename, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ThreadMcpServer } from './threadToolServer'
import { piEnvironment } from './piRpc'

/** Shared Pi-owned credentials, and a gateway whose token admits only this thread's tools. */
export async function piThreadEnvironment(root: string, threadId: string, models: string, servers: readonly ThreadMcpServer[], environment?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const directory = root
  await mkdir(piSessionDirectory(root, threadId), { recursive: true, mode: 0o700 })
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
  await atomicWrite(join(directory, 'models.json'), models)
  await atomicWrite(join(directory, 'mcp.json'), JSON.stringify({ mcpServers }))
  await atomicWrite(join(directory, 'settings.json'), JSON.stringify({ autoCompact: false, autoRetry: false }))
  return piEnvironment(directory, keys, environment)
}

export const PI_ISOLATION_ARGS = ['--no-extensions', '-e', 'builtin:mcp', '--no-skills', '--no-prompt-templates', '--no-approve', '--no-themes'] as const

export function piSessionDirectory(root: string, id: string): string { return join(root, 'threads', createHash('sha256').update(id).digest('hex'), 'sessions') }

async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, text, { mode: 0o600 })
  await rename(temporary, path)
}

export async function writePiModels(root: string, models: string): Promise<void> { await mkdir(root, { recursive: true, mode: 0o700 }); await atomicWrite(join(root, 'models.json'), models) }
