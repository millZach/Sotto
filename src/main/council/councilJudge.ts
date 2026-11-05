import { lstat, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

/** The owned directory is a capability boundary, never an origin's working folder. */
export async function assertCouncilJudgeDirectory(directory: string, path: string): Promise<void> {
  const root = resolve(directory, 'council-evidence', 'judges')
  const child = relative(root, resolve(path)).split(sep)
  if (child.length !== 2 || child.some(part => !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(part))) {
    throw new Error('A Climb judge needs its owned evidence folder.')
  }
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== join(await realpath(root), ...child)) {
    throw new Error('The Climb judge folder moved or is unavailable. Start a fresh assessment.')
  }
}

/** No tools, MCP, hooks, skills, plugins or project instructions. Unsupported CLIs fail closed. */
export const COUNCIL_JUDGE_CLAUDE_ARGS = ['--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', ''] as const
