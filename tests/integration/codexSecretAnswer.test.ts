// @vitest-environment node
// A secret answer (#2153) goes to Codex and nowhere else in Sotto: not the thread's messages, not what main writes to
// disk, not a log line, and not the thread when Codex's own session log records the tool output that carries it, as
// Codex does natively. Fake values only.
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentControl } from '../fixtures/agentControlFixture'
import { testCredentials } from '../fixtures/testCredentials'
import { codexFixture, rolloutLine } from '../fixtures/codexFixture'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'
import type { AgentControl } from '../../src/main/agents/control'

const FAKE = 'fake-secret-123'
const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
const controls: AgentControl[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const control of controls.splice(0)) control.dispose()
  for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup()
})

/** Every file under `root` but the fake's record of what Codex received and Codex's own home, which keep it natively. */
async function sottoFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
    .filter(path => { const name = relative(root, path).replaceAll('\\', '/'); return name !== 'requests.jsonl' && !name.startsWith('home/') })
}

describe('a Codex secret answer', () => {
  it('reaches Codex, and no message, file or log line of Sotto’s', async () => {
    const logged: unknown[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args) })
    const f = await codexFixture(undefined, true); fixtures.push(f)
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    const threadId = randomUUID()
    await f.host.execute({ type: 'create-thread', threadId, commandId: randomUUID(), projectId: f.projectId, modelId: f.modelId, title: 'Implementation' })
    const credentials = await testCredentials(join(f.root, 'vault'), { mode: 'plain' })
    const control = createAgentControl({ schedule: immediatePublishScheduler, directory: f.root, host: f.host, credentials, reasoner: {} })
    controls.push(control); await control.start(); await control.command({ type: 'connect' })
    const thread = () => control.get().host.threads.find(item => item.id === threadId)!
    await control.command({ type: 'select-thread', threadId })
    await control.command({ type: 'compose', text: 'Ask me for the fake token' }); expect((await control.command({ type: 'send' })).error).toBeNull()

    await f.action(threadId, { type: 'question', text: 'Paste the fake token', params: { questions: [{ id: 'token', header: 'Token', question: 'Paste the fake token',
      isSecret: true, isOther: true, options: [{ label: 'Skip for now', description: 'Go on without it.' }] }] } })
    await expect.poll(() => thread().requests.some(request => request.kind === 'question')).toBe(true)
    const request = thread().requests.find(item => item.kind === 'question')!
    expect(request.questions![0]).toMatchObject({ id: 'token', secret: true })

    expect((await control.command({ type: 'answer', threadId, requestId: request.id, answer: '', questionAnswers: { token: { optionIds: [], text: FAKE } } })).error).toBeNull()
    await expect.poll(async () => (await f.driver.requests()).some(row => JSON.stringify(row.result?.answers) === JSON.stringify({ token: { answers: [FAKE] } }))).toBe(true)

    // Codex keeps the answer in its own session file, as the tool output the model reads.
    const directory = join(f.root, 'home', 'sessions', '2026', '09', '10'); await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `rollout-2026-09-10-${await f.realId(threadId)}.jsonl`), rolloutLine(1, { id: await f.realId(threadId), cwd: f.root }, 'session_meta')
      + rolloutLine(2, { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ answers: { token: { answers: [FAKE] } } }) }, 'response_item'))
    await f.adapter.pollSessionLogs()

    expect(JSON.stringify(thread())).not.toContain(FAKE)
    expect(JSON.stringify(await f.host.snapshot())).not.toContain(FAKE)
    control.dispose(); controls.splice(controls.indexOf(control), 1)
    for (const path of await sottoFiles(f.root)) expect(await readFile(path, 'utf8'), path).not.toContain(FAKE)
    expect(JSON.stringify(logged)).not.toContain(FAKE)
  })
})
