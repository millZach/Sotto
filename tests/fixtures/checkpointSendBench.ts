/**
 * One process of `tests/perf/checkpointSend.perf.test.ts`: takes a thread's checkpoints across several sends into
 * one working copy, the way the send hook and the completed-turn hook do, and prints what each cost as JSON.
 *
 * Usage: node <bundle> <working copy> <sends> <unchanged|edit|commit> [seeded]
 * Under `edit`, each turn rewrites one file, `bench-edit.txt`, which the benchmark adds to its own synthetic copies.
 * Under `commit`, each turn ends with an empty commit, which moves `HEAD` and so turns any held verdict around.
 * `seeded` starts from a synthetic `checkpoints.json` of about 1.5 MB: 1,000 unavailable checkpoints and five
 * completed ones of 1,000 files each, the shape and size of the file on the development machine.
 */
import fs from 'node:fs'
import childProcess, { execFileSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { FilesService } from '../../src/main/files/service'
import { CheckpointService } from '../../src/main/tools/checkpoints'
import type { CheckpointThread } from '../../src/main/tools/checkpointTypes'

const [folder, sendsText, mode, seeded] = process.argv.slice(2)
const repo = resolve(folder!), sends = Number(sendsText)

// Count every working-copy file whose contents are read: `fs.promises` and the ESM bindings stay in step.
let reads = 0, readBytes = 0
const readFile = fs.promises.readFile
fs.promises.readFile = (async (...args: Parameters<typeof readFile>) => {
  const result = await readFile(...args)
  if (typeof args[0] === 'string' && resolve(args[0]).toLowerCase().startsWith(repo.toLowerCase())) { reads++; readBytes += result.length }
  return result
}) as typeof readFile
// Count the working-copy listings a send runs: none when a verdict is held.
let listings = 0
const execFile = childProcess.execFile
childProcess.execFile = ((...args: Parameters<typeof execFile>) => {
  if (Array.isArray(args[1]) && args[1].includes('-o') && args[1].includes('ls-files')) listings++
  return execFile(...args)
}) as typeof execFile
syncBuiltinESMExports()

const directory = await mkdtemp(join(tmpdir(), 'sotto-checkpoint-bench-'))
if (seeded === 'seeded') {
  const createdAt = new Date().toISOString(), empty = { files: {}, index: '', head: '' }
  const base = { threadId: 'seed', workspaceId: 'f'.repeat(64), cwd: join(directory, 'seed'), checkout: join(directory, 'seed'), providerId: 'codex', bindingId: 'codex:seed', createdAt, beforeUsers: [] }
  const files = (salt: string) => Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`area-${index % 40}/file-${index}.txt`, { hash: (salt + index.toString(16)).padStart(64, '0'), mode: 33206 }]))
  const records = [
    ...Array.from({ length: 1_000 }, () => ({ ...base, id: randomUUID(), before: empty, status: 'unavailable', reason: 'This working copy exceeds the checkpoint size limit (64 MiB total, 8 MiB per file).' })),
    ...Array.from({ length: 5 }, () => ({ ...base, id: randomUUID(), before: { files: files('a'), index: '', head: '' }, after: { files: files('b'), index: '', head: '' }, afterUsers: ['seed-user'], status: 'ready' })),
  ]
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'checkpoints.json'), `${JSON.stringify({ version: 1, records }, null, 2)}\n`)
}
const state: CheckpointThread = { threadId: 'bench', providerId: 'codex', bindingId: 'codex:bench', userMessageIds: [], busy: false, running: false, rollbackSupported: true }
const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'bench', workingDirectory: repo }), copyPath: () => undefined, reveal: async () => undefined })
const service = new CheckpointService({ files, directory, resolveThread: async id => id === state.threadId ? { ...state } : null,
  rollback: async () => ({ accepted: false }), refresh: async () => undefined })
await service.initialize()
const stored = join(directory, 'checkpoints.json')
const storedAt = async (): Promise<number> => (await stat(stored)).mtimeMs

const rows = []
for (let send = 0; send < sends; send++) {
  const was = await storedAt()
  reads = 0; readBytes = 0; listings = 0
  let started = performance.now()
  await service.beforeTurn(state.threadId)
  const beforeMs = performance.now() - started
  const before = { reads, readBytes, listings }
  const rewrote = await storedAt() !== was
  if (mode === 'edit') await writeFile(join(repo, 'bench-edit.txt'), `turn ${send} ${'x'.repeat(4000)}\n`)
  if (mode === 'commit') execFileSync('git', ['-c', 'user.name=Bench', '-c', 'user.email=bench@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '--allow-empty', '-m', `Turn ${send}`], { cwd: repo, windowsHide: true })
  state.userMessageIds = [...state.userMessageIds, `user-${send}`]
  reads = 0; readBytes = 0
  started = performance.now()
  await service.afterTurn(state.threadId)
  const afterMs = performance.now() - started
  rows.push({ beforeMs, afterMs, beforeReads: before.reads, beforeReadBytes: before.readBytes, beforeListings: before.listings, afterReads: reads, rewrote })
}
const checkpoints = await service.checkpoints({ threadId: state.threadId })
service.dispose()
await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
process.stdout.write(`${JSON.stringify({ rows, statuses: checkpoints.ok ? checkpoints.value.checkpoints.map(item => item.status) : [] })}\n`)
