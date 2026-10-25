// @vitest-environment node
/**
 * DeepSeek Harness's own CLI (ADR-0138). Never in CI: it needs `dsh` installed and one of the user's own model
 * servers answering. Run with
 *
 *   SOTTO_DEEPSEEK_LIVE=1 SOTTO_DEEPSEEK_SERVER=<http://host:port/v1> SOTTO_DEEPSEEK_MODEL=<model id on it> \
 *     npx vitest run tests/integration/deepseekLive.test.ts
 *
 * `SOTTO_DEEPSEEK_EXECUTABLE` may name the `dsh` to start, and `SOTTO_DEEPSEEK_CONTEXT` the model's context window
 * (131072 by default). The server must need no key: this version runs keyless servers only. Sotto's harness folder
 * for the run is a scratch folder inside the test's own root, so the user's own ~/.dsh is never read or written.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DeepSeekAcpHost } from '../../src/main/agents/deepseek'
import type { OwnServer } from '../../src/shared/ownModelServers'

const live = process.env.SOTTO_DEEPSEEK_LIVE === '1'
const ADDRESS = process.env.SOTTO_DEEPSEEK_SERVER ?? ''
const MODEL = process.env.SOTTO_DEEPSEEK_MODEL ?? ''
const CONTEXT = Number(process.env.SOTTO_DEEPSEEK_CONTEXT ?? 131_072)
const EXECUTABLE = process.env.SOTTO_DEEPSEEK_EXECUTABLE

const servers = (): OwnServer[] => [{
  id: 'own-live', name: 'Live server', address: ADDRESS, keyed: false,
  models: [{ id: MODEL, name: MODEL, context: CONTEXT, thinking: true, images: false }],
}]

it.skipIf(!live)('runs, asks and resumes on DeepSeek Harness’s own CLI, on the user’s own model server', { timeout: 600_000 }, async () => {
  if (!ADDRESS || !MODEL) throw new Error('Set SOTTO_DEEPSEEK_SERVER and SOTTO_DEEPSEEK_MODEL.')
  const root = await mkdtemp(join(tmpdir(), 'sotto-deepseek-live-'))
  const project = join(root, 'project')
  const options = { requestTimeoutMs: 120_000, startTimeoutMs: 180_000, servers: async () => servers(), ...(EXECUTABLE ? { executable: EXECUTABLE } : {}) }
  let host = new DeepSeekAcpHost(join(root, 'sotto'), options)
  try {
    execFileSync('git', ['init', '-q', project]); await writeFile(join(project, 'README.md'), 'Live probe\n')
    const connected = await host.connect()
    expect(connected.models).toEqual([expect.objectContaining({ id: `own-live/${MODEL}`, provider: 'DeepSeek Harness', source: 'Live server', ready: true })])
    // The overlay Sotto generated is in its own folder, and names the server the test was given.
    const patch = await readFile(join(root, 'sotto', 'deepseek', 'sotto-acp.patch.yml'), 'utf8')
    expect(patch).toContain(ADDRESS)
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'live', title: 'Live', path: project })
    const id = randomUUID()
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'live', modelId: `own-live/${MODEL}`, title: 'Live probe', reasoningEffort: 'low', runtimeMode: 'auto-accept-edits' })
    host.observeThreads([id])
    const thread = async () => (await host.snapshot()).threads.find(candidate => candidate.id === id)!
    const send = (messageId: string, text: string) => host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId, text })
    // A request that never comes says what the turn did instead, so a model that stopped at the denial is named.
    const waitForRequest = async (): Promise<void> => {
      const deadline = Date.now() + 180_000
      for (;;) {
        const current = await thread()
        if (current.requests.length === 1) return
        if (Date.now() > deadline) throw new Error(`No request arrived. Thread status: ${current.status}. Replies: ${current.messages.filter(message => message.role === 'assistant').map(message => message.text).join(' | ').slice(0, 2_000)}`)
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    expect(await send('hello', 'Reply with the word hello and nothing else. Do not use any tools.')).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).status, { timeout: 180_000, interval: 500 }).toBe('idle')
    expect((await thread()).messages.filter(message => message.role === 'assistant').map(message => message.text.toLowerCase()).join(' ')).toContain('hello')
    expect((await thread()).usage?.contextUsed).toBeGreaterThan(0)
    // Inside the workspace sandbox, a write runs unasked.
    expect(await send('write', 'Create a file named live.txt in the current workspace containing exactly LIVE_OK, then stop.')).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).status, { timeout: 180_000, interval: 500 }).toBe('idle')
    expect((await thread()).requests).toEqual([])
    expect(await readFile(join(project, 'live.txt'), 'utf8')).toContain('LIVE_OK')
    // Ask for approval: a write outside the sandbox is denied first, and the model's retry comes to the user. The
    // target sits in the home folder, not under the test's temp root: a macOS sandbox lets temp writes through.
    const escalated = join(homedir(), 'sotto-deepseek-live-escalated.txt'), refused = join(homedir(), 'sotto-deepseek-live-refused.txt')
    await rm(escalated, { force: true }); await rm(refused, { force: true })
    await host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'approval-required' })
    await expect.poll(async () => (await thread()).runtimeMode, { timeout: 60_000, interval: 500 }).toBe('approval-required')
    expect(await send('escalate', `Create ${escalated} containing exactly ESC_OK using bash, not filesystem tools. First try the command without sandbox_permissions. If the sandbox denies it, retry that exact command once with sandbox_permissions and a one-sentence justification. Then stop.`)).toEqual({ accepted: true })
    await waitForRequest()
    const request = (await thread()).requests[0]!
    expect(request.kind).toBe('permission')
    expect(request.context?.command).toContain('sotto-deepseek-live-escalated.txt')
    expect(request.permissionChoices?.map(choice => choice.kind)).toEqual(['allow-once', 'deny'])
    await host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: request.id, answer: '', approved: true })
    await expect.poll(async () => (await thread()).status, { timeout: 180_000, interval: 500 }).toBe('idle')
    expect(await readFile(escalated, 'utf8')).toContain('ESC_OK')
    // And rejected, nothing lands.
    expect(await send('refuse', `Create ${refused} containing exactly NO using bash, not filesystem tools. First try the command without sandbox_permissions. If the sandbox denies it, retry that exact command once with sandbox_permissions and a one-sentence justification. If approval is rejected, stop and say so.`)).toEqual({ accepted: true })
    await waitForRequest()
    await host.execute({ type: 'answer', threadId: id, commandId: randomUUID(), requestId: (await thread()).requests[0]!.id, answer: '', approved: false })
    await expect.poll(async () => (await thread()).status, { timeout: 180_000, interval: 500 }).toBe('idle')
    await expect(readFile(refused, 'utf8')).rejects.toThrow()
    await rm(escalated, { force: true })
    // A new Sotto run resumes the same provider session and carries on in it.
    host.disconnect(); await host.closed()
    host = new DeepSeekAcpHost(join(root, 'sotto'), options)
    host.observeThreads([id])
    await host.connect()
    await expect.poll(async () => (await thread()).status, { timeout: 120_000, interval: 500 }).toBe('idle')
    expect(await host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'after', text: 'Reply with the word again and nothing else. Do not use any tools.' })).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).status, { timeout: 180_000, interval: 500 }).toBe('idle')
    expect((await thread()).messages.filter(message => message.role === 'assistant').map(message => message.text.toLowerCase()).join(' ')).toContain('again')
  } finally {
    host.disconnect(); await host.closed()
    await rm(root, { recursive: true, force: true })
  }
})
