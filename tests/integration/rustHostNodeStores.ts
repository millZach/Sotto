// What Node reads of a provider store the Rust host wrote (ADR-0214). A thread started on a Rust host gets its record
// from Rust; after a rollback Node must read it with its own parser, and must not set it aside as unreadable.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { parseAntigravityThreadStore } from '../../src/main/agents/antigravity'
import { parseCursorThreadStore } from '../../src/main/agents/cursor'
import { parseDevinThreadStore } from '../../src/main/agents/devin'
import { parseGrokThreadStore } from '../../src/main/agents/grok'
import { parseHermesThreadStore } from '../../src/main/agents/hermes'
import { parseMuseThreadStore } from '../../src/main/agents/muse'
import { parseOpenCodeThreadStore } from '../../src/main/agents/opencode'
import { parseClaudeThreadStore } from '../../src/main/agents/providers/claude/claude'
import { parseCodexThreadStore } from '../../src/main/agents/providers/codex/codex'
import { unreadableEntries } from '../../src/main/storage/atomicJsonStore'

/** Each provider store the Rust host shares with Node, and Node's own parser for it. */
export const NODE_THREAD_STORES = {
  claude: { file: 'claude-threads.json', parse: parseClaudeThreadStore },
  codex: { file: 'codex-threads.json', parse: parseCodexThreadStore },
  muse: { file: 'muse-threads.json', parse: parseMuseThreadStore },
  opencode: { file: 'opencode-threads.json', parse: parseOpenCodeThreadStore },
  grok: { file: 'grok-threads.json', parse: parseGrokThreadStore },
  devin: { file: 'devin-threads.json', parse: parseDevinThreadStore },
  cursor: { file: 'cursor-threads.json', parse: parseCursorThreadStore },
  antigravity: { file: 'antigravity-threads.json', parse: parseAntigravityThreadStore },
  hermes: { file: 'hermes-threads.json', parse: parseHermesThreadStore },
} as const satisfies Record<string, { file: string; parse: (value: unknown) => Record<string, unknown> }>

/** Node reads the record a Rust host made for `threadId` whole, under the thread's project and title. */
export async function expectNodeReadsRustRecord(dataDir: string, provider: keyof typeof NODE_THREAD_STORES, threadId: string, thread: { projectId: string; title: string }): Promise<void> {
  const { file, parse } = NODE_THREAD_STORES[provider]
  const raw = JSON.parse(await readFile(join(dataDir, file), 'utf8')) as unknown
  const read = parse(raw)
  expect(unreadableEntries(read) ?? {}, `${file} has entries Node cannot read`).toEqual({})
  expect(read[threadId], `${file} has no record Node reads for the thread`).toMatchObject({ projectId: thread.projectId, title: thread.title })
  expect((await readdir(dataDir)).filter(name => name.startsWith(`${file}.corrupt-`) || name.startsWith(`${file}.unreadable-`)), `${file} was set aside`).toEqual([])
}
