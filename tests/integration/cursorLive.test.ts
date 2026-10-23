// @vitest-environment node
/**
 * Cursor's own CLI (ADR-0123). Never in CI: it needs Cursor's CLI installed and signed in, and it spends a few short turns on
 * the user's Cursor plan. Run with
 *
 *   SOTTO_CURSOR_LIVE=1 npx vitest run tests/integration/cursorLive.test.ts
 *
 * Sotto's Cursor folder for the run is a scratch folder inside the test's own root, so the user's own ~/.cursor is never
 * read or written: the test checks its cli-config.json is as it was. The model is the cheapest checked, GPT-5.4 Nano, at
 * low effort, unless SOTTO_CURSOR_MODEL names another.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CursorAcpHost } from '../../src/main/agents/cursor'

const live = process.env.SOTTO_CURSOR_LIVE === '1'
const MODEL = process.env.SOTTO_CURSOR_MODEL ?? 'gpt-5.4-nano'
const userConfig = (): Promise<string> => readFile(join(process.env.CURSOR_CONFIG_DIR ?? join(homedir(), '.cursor'), 'cli-config.json'), 'utf8').catch(() => '')

it.skipIf(!live)('runs, asks, resumes and writes short text on Cursor’s own CLI, in Sotto’s own Cursor folder', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-cursor-live-'))
  const project = join(root, 'project')
  const before = await userConfig()
  const options = { configDirectory: join(root, 'cursor-config'), requestTimeoutMs: 90_000 }
  let host = new CursorAcpHost(join(root, 'sotto'), options)
  try {
    execFileSync('git', ['init', '-q', project]); await writeFile(join(project, 'README.md'), 'Live probe\n')
    const connected = await host.connect()
    expect(connected.models.find(model => model.id === MODEL)).toMatchObject({ provider: 'Cursor', source: 'OpenAI', ready: true })
    expect(connected.models[0]).toMatchObject({ id: 'default', name: 'Auto', source: 'Cursor' })
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'live', title: 'Live', path: project })
    const id = randomUUID()
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'live', modelId: MODEL, title: 'Live probe', reasoningEffort: 'low' })
    host.observeThreads([id])
    const thread = async () => (await host.snapshot()).threads.find(candidate => candidate.id === id)!
    expect(await host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'hello', text: 'Reply with the word hello and nothing else. Do not use any tools.' })).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).status, { timeout: 120_000, interval: 500 }).toBe('idle')
    expect((await thread()).messages.filter(message => message.role === 'assistant').map(message => message.text.toLowerCase()).join(' ')).toContain('hello')
    // A command asks under Ask for approval; a reject reaches the model as a refused tool call and the turn goes on.
    await host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'command', text: 'Run the shell command `git status --short` in this folder, then reply in five words.' })
    await expect.poll(async () => (await thread()).requests.length, { timeout: 120_000, interval: 500 }).toBe(1)
    const request = (await thread()).requests[0]!
    expect(request.kind).toBe('permission')
    expect(request.permissionChoices?.map(choice => choice.kind)).toEqual(['allow-once', 'deny'])
    await host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: request.id, answer: '', approved: false })
    await expect.poll(async () => (await thread()).status, { timeout: 120_000, interval: 500 }).toBe('idle')
    const shown = (await thread()).messages.map(message => [message.id, message.role, message.text])
    // A new Sotto run loads the session back from Cursor's replay, with the same messages.
    host.disconnect(); await host.closed()
    host = new CursorAcpHost(join(root, 'sotto'), options)
    host.observeThreads([id])
    await host.connect()
    await expect.poll(async () => (await thread()).messages.length, { timeout: 60_000, interval: 500 }).toBe(shown.length)
    expect((await thread()).messages.map(message => [message.id, message.role, message.text])).toEqual(shown)
    // Short text in a session of its own, in ask mode.
    const title = await host.writeShortText(id, { instruction: 'Write a git branch name (kebab-case, at most four words) for this task. Reply with the name only.', material: 'Add a dark mode toggle.' })
    expect(title).toMatch(/[a-z]/u)
    expect(await userConfig()).toBe(before)
  } finally { host.disconnect(); await host.closed(); await rm(root, { recursive: true, force: true }).catch(() => undefined) }
})
