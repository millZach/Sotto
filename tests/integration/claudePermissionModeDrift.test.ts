// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentRuntimeMode } from '../../src/shared/agents'
import { claudeFixture } from '../fixtures/claudeFixture'

// Something between Sotto and Claude Code, such as a wrapper script on PATH or managed settings, can start the CLI in
// another permission mode than the one Sotto launched it with. Each turn's init frame says which mode runs (#657).
const fixtures: Awaited<ReturnType<typeof claudeFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })
/** A thread on `runtimeMode` whose CLI reports `reported` in its turn's init frame, as the real CLI does at a turn's start. */
async function drifted(runtimeMode: AgentRuntimeMode, reported: string, script: Record<string, unknown> = {}) {
  const f = await claudeFixture(undefined, 15_000)
  fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Mode', path: f.root })
  await writeFile(join(f.root, 'initialize-script.json'), JSON.stringify({ initAtTurn: true, initReport: { permissionMode: reported }, ...script }))
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'thread', projectId: f.projectId, title: 'Mode', modelId: f.modelId, runtimeMode })
  return f
}
type Fixture = Awaited<ReturnType<typeof drifted>>
const thread = async (f: Fixture) => (await f.host.snapshot()).threads.find(value => value.id === 'thread')!
const send = (f: Fixture, text: string) => f.host.execute({ type: 'send', threadId: 'thread', commandId: randomUUID(), messageId: randomUUID(), text })
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

it('stops a turn before it acts when Claude Code runs looser than the thread shows', async () => {
  const f = await drifted('auto', 'bypassPermissions', { holdAfterInit: 'tool-release' })
  expect(await send(f, 'Clean up the build folder')).toMatchObject({ accepted: true })
  await expect.poll(async () => (await thread(f)).lastTurn?.status).toBe('failed')
  const stopped = await thread(f)
  expect(stopped.status).toBe('error')
  expect(stopped.messages.map(message => message.text)).toEqual(['Clean up the build folder'])
  const error = stopped.activities?.find(row => row.kind === 'turn' && row.status === 'failed')?.error
  expect(error).toContain('Claude Code started in Full access although this thread is set to Auto, so Sotto stopped it before it acted. Nothing ran.')
  expect(error).toContain('a wrapper script named claude on your PATH')
  // The CLI is ended at once rather than left to finish, so the step its model was about to take never runs.
  const { pid } = JSON.parse(await readFile(join(f.root, `settings-${await f.realId('thread')}.json`), 'utf8')) as { pid: number }
  await expect.poll(() => alive(pid)).toBe(false)
  await writeFile(join(f.root, 'tool-release'), '')
  expect(existsSync(join(f.root, 'tool-ran'))).toBe(false)
  // The thread shows the mode the user chose, not the one that ran.
  expect(stopped.runtimeMode).toBe('auto')
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
