import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The origins Sotto has made durable for a Claude thread: those in `claude-threads.json`, then any recorded in the
 * origin journal since that file was last written whole (#767). It imports nothing from `src/`, so a Playwright
 * spec reads a profile with it as an integration test reads a fixture's.
 */
export async function storedClaudeOrigins(root: string, id: string): Promise<{ uuid: string; messageId: string; commandId: string; digest: string }[]> {
  type Origin = { uuid: string; messageId: string; commandId: string; digest: string }
  const stored = (JSON.parse(await readFile(join(root, 'claude-threads.json'), 'utf8')) as Record<string, { origins: Origin[] }>)[id]?.origins ?? []
  const journal = (await readFile(join(root, 'claude-origins.jsonl'), 'utf8').catch(() => '')).split('\n').filter(line => line.trim())
    .map(line => JSON.parse(line) as { threadId: string; origin: Origin }).filter(entry => entry.threadId === id).map(entry => entry.origin)
  return [...stored, ...journal.filter(origin => !stored.some(known => known.uuid === origin.uuid))]
}
