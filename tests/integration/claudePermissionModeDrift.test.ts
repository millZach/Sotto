// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeProtocol } from '../../src/main/agents/claudeProtocol'
import type { AgentRuntimeMode } from '../../src/shared/agents'
import { claudeFixture } from '../fixtures/claudeFixture'

// Something between Sotto and Claude Code, such as a wrapper script on PATH or managed settings, can start the CLI in
// another permission mode than the one Sotto launched it with. Each turn's init frame says which mode runs (#657).
const fixtures: Awaited<ReturnType<typeof claudeFixture>>[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.cleanup() })
/** A thread on `runtimeMode` whose CLI reports `reported` in its turn's init frame, as the real CLI does at a turn's start. */
async function drifted(runtimeMode: AgentRuntimeMode, reported: string, script: Record<string, unknown> = {}, wrapped = false) {
  // A wrapped CLI runs as the child of a wrapper that does not `exec` it, as a shell script named claude may.
  const root = wrapped ? await mkdtemp(join(tmpdir(), 'sotto-claude-')) : undefined
  const f = await claudeFixture(root, 15_000, undefined, root ? { args: [resolve('tests/fixtures/fakeClaudeWrapper.mjs'), resolve('tests/fixtures/fakeClaudeThread.mjs'), root] } : {})
  fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Mode', path: f.root })
  await writeFile(join(f.root, 'initialize-script.json'), JSON.stringify({ initAtTurn: true, initReport: { permissionMode: reported }, ...script }))
  // The CLI offers /compact, so a thread can compact as well as send.
  await writeFile(join(f.root, 'skills.json'), JSON.stringify([{ name: 'compact', description: 'Native compaction' }]))
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: f.projectId, title: 'Mode', modelId: f.modelId, runtimeMode })
  return f
}
type Fixture = Awaited<ReturnType<typeof drifted>>
const thread = async (f: Fixture) => (await f.host.snapshot()).threads.find(value => value.id === 'thread')!
const send = (f: Fixture, text: string) => f.host.execute({ type: 'send', threadId: 'thread', commandId: randomUUID(), messageId: randomUUID(), text })
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

const cliPid = async (f: Fixture): Promise<number> => (JSON.parse(await readFile(join(f.root, `settings-${await f.realId('thread')}.json`), 'utf8')) as { pid: number }).pid

for (const wrapped of [false, true]) it(`stops a turn before it acts when Claude Code${wrapped ? ', run by a wrapper without exec,' : ''} runs looser than the thread shows`, async () => {
  const f = await drifted('auto', 'bypassPermissions', { holdAfterInit: 'tool-release' }, wrapped)
  expect(await send(f, 'Clean up the build folder')).toMatchObject({ accepted: true })
  await expect.poll(async () => (await thread(f)).lastTurn?.status).toBe('failed')
  const stopped = await thread(f)
  expect(stopped.status).toBe('error')
  expect(stopped.messages.map(message => message.text)).toEqual(['Clean up the build folder'])
  const error = stopped.activities?.find(row => row.kind === 'turn' && row.status === 'failed')?.error
  expect(error).toContain('Claude Code started in Full access although this thread is set to Auto. Sotto stopped it as soon as Claude Code reported its mode, before its first reply, so Claude chose no tool for this message. '
    + 'Anything Claude Code, its startup hooks or a wrapper script did as it started may have run in that mode, so check the project.')
  expect(error).not.toContain('Nothing ran')
  expect(error).toContain('a wrapper script named claude on your PATH')
  // The CLI is ended at once rather than left to finish, with whatever started it, and the turn fails only once it is
  // seen gone, so the step its model was about to take never runs.
  expect(alive(await cliPid(f))).toBe(false)
  await writeFile(join(f.root, 'tool-release'), '')
  expect(existsSync(join(f.root, 'tool-ran'))).toBe(false)
  // The thread shows the mode the user chose, not the one that ran.
  expect(stopped.runtimeMode).toBe('auto')
})

it('names the background work that ended with a stopped CLI, and how to get it back', async () => {
  const f = await drifted('auto', 'bypassPermissions', { holdAfterInit: 'tool-release', startupFrames: [
    { type: 'system', subtype: 'task_started', task_id: 'agent-task', task_type: 'local_agent', description: 'Review the diff', is_backgrounded: true, spawn_depth: 1 }] })
  expect(await send(f, 'Clean up the build folder')).toMatchObject({ accepted: true })
  await expect.poll(async () => (await thread(f)).lastTurn?.status).toBe('failed')
  const stopped = await thread(f)
  expect(stopped.backgroundWork).toBeUndefined()
  expect(stopped.activities?.find(row => row.kind === 'turn' && row.status === 'failed')?.error).toBe('Claude Code started in Full access although this thread is set to Auto. Sotto stopped it as soon as Claude Code reported its mode, before its first reply, so Claude chose no tool for this message. '
    + 'Anything Claude Code, its startup hooks or a wrapper script did as it started may have run in that mode, so check the project. '
    + '"Review the diff", started earlier, stopped with it. Something between Sotto and Claude Code changed the mode, such as a wrapper script named claude on your PATH '
    + 'or Claude Code’s managed settings. Fix that, then send your message again. Ask Claude to start it again if you still need it.')
})

it('says Claude Code may still be running when the stop cannot be confirmed, without waiting for a close that never comes', async () => {
  // A CLI that outlives its kill, as one a wrapper moved out of the tree may: the halt cannot confirm it ended, and the
  // CLI never closes. The turn still fails with the warning, and the next send waits for the close rather than start a
  // second CLI beside it.
  const halt = vi.spyOn(ClaudeProtocol.prototype, 'halt').mockResolvedValue(false)
  const stop = vi.spyOn(ClaudeProtocol.prototype, 'stop').mockImplementation(() => undefined)
  const f = await drifted('auto', 'bypassPermissions', { holdAfterInit: 'tool-release' })
  expect(await send(f, 'Clean up the build folder')).toMatchObject({ accepted: true })
  await expect.poll(async () => (await thread(f)).lastTurn?.status).toBe('failed')
  const stopped = await thread(f)
  expect(halt).toHaveBeenCalledOnce()
  const pid = await cliPid(f)
  expect(alive(pid)).toBe(true)
  expect(stopped.status).toBe('error')
  expect(stopped.activities?.find(row => row.kind === 'turn' && row.status === 'failed')?.error).toBe('Claude Code started in Full access although this thread is set to Auto. '
    + 'Sotto tried to stop it as soon as Claude Code reported its mode, but could not confirm that it ended, so Claude Code may still be running in that mode. '
    + 'End any claude process still running for this project in Task Manager, Activity Monitor or with kill, then check the project for changes. '
    + 'Something between Sotto and Claude Code changed the mode, such as a wrapper script named claude on your PATH or Claude Code’s managed settings. Fix that, then send your message again.')
  // The next send is held behind the close: no second CLI starts while the first may still be running.
  let sent = false
  const next = send(f, 'Tidy the readme').then(result => { sent = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  expect(sent).toBe(false)
  stop.mockRestore(); halt.mockRestore()
  process.kill(pid, 'SIGKILL')
  // Once the first CLI closes, the held send goes on; what it meets then (this fake wrote no session log before the halt)
  // is not this test's question.
  await next.catch(() => undefined)
})

it('fails a /compact that Claude Code starts looser than the thread shows, and the next send goes', async () => {
  const f = await drifted('auto', 'bypassPermissions', { holdAfterInit: 'tool-release' })
  expect(await f.host.execute({ type: 'compact-thread', commandId: 'compact', threadId: 'thread' })).toMatchObject({ accepted: true })
  await expect.poll(async () => (await thread(f)).compaction?.status).toBe('failed')
  const stopped = await thread(f)
  expect(stopped.status).toBe('error')
  expect(stopped.compaction?.error).toContain('Sotto stopped it as soon as Claude Code reported its mode, before its first reply')
  expect(alive(await cliPid(f))).toBe(false)
  // Sending again starts a new CLI; with the mode fixed, the turn runs.
  await rm(join(f.root, 'initialize-script.json'))
  expect(await send(f, 'Tidy the readme')).toMatchObject({ accepted: true })
  await f.driver.completeTurn('thread', 'Tidied.')
  await expect.poll(async () => (await thread(f)).lastTurn?.status).toBe('completed')
})

it('lets a turn go on with a note when Claude Code runs stricter than the thread shows', async () => {
  const f = await drifted('full-access', 'default')
  expect(await send(f, 'Tidy the readme')).toMatchObject({ accepted: true })
  await f.driver.completeTurn('thread', 'Tidied.')
  await expect.poll(async () => (await thread(f)).messages.at(-1)?.text).toBe('Tidied.')
  const done = await thread(f)
  expect(done.lastTurn?.status).toBe('completed')
  const notes = done.activities?.filter(row => row.kind === 'status') ?? []
  expect(notes).toEqual([expect.objectContaining({ status: 'completed', title: 'Stricter permission mode',
    text: 'Claude Code is running in Ask for approval, which is stricter than this thread’s Full access, so it may ask or refuse more than you chose.' })])
})

it('says nothing when Claude Code runs the mode the thread shows', async () => {
  const f = await drifted('auto-accept-edits', 'acceptEdits')
  expect(await send(f, 'Fix the typo')).toMatchObject({ accepted: true })
  await f.driver.completeTurn('thread', 'Fixed.')
  await expect.poll(async () => (await thread(f)).messages.at(-1)?.text).toBe('Fixed.')
  expect((await thread(f)).activities?.filter(row => row.kind === 'status')).toEqual([])
  expect((await thread(f)).lastTurn?.status).toBe('completed')
})
