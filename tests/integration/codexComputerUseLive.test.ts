// @vitest-environment node
// Opt-in and paid: one Codex turn per case, asking Codex to list open apps with Computer Use. It reports which
// native requests arrive and how Computer Use tool calls end, first with the environment Sotto passes today and then
// with the parent environment passed through (secrets removed), so the two suspected causes can be told apart.
// Every request is denied, so nothing on this computer is operated.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({ passThrough: false }))
vi.mock('../../src/main/agents/subscriptionCodex', async original => {
  const actual = await original<typeof import('../../src/main/agents/subscriptionCodex')>()
  return { ...actual, nativeEnvironment: () => probe.passThrough
    ? Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|NODE_OPTIONS/i.test(key)))
    : actual.nativeEnvironment() }
})
const { CodexAppServerHost } = await import('../../src/main/agents/codex')

async function removeProbe(root: string): Promise<void> {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-codex-cu-')) throw new Error('Unexpected Computer Use test folder')
  await rm(root, { recursive: true, force: true })
}
const short = (value: string | undefined, length: number) => value === undefined ? undefined : value.length > length ? `${value.slice(0, length)}…` : value

it.skipIf(process.env.SOTTO_CODEX_COMPUTER_USE_LIVE !== '1').each([['sotto environment', undefined], ['passed-through environment', undefined], ['sotto environment', 'full-access']] as const)('Codex reaches Computer Use with the %s (%s)', async (environment, runtimeMode) => {
  probe.passThrough = environment === 'passed-through environment'
  const root = await mkdtemp(join(tmpdir(), 'sotto-codex-cu-')); const cwd = join(root, 'project'); const data = join(root, 'data')
  await mkdir(cwd); await mkdir(data)
  execFileSync('git', ['init', '--quiet', cwd], { windowsHide: true, stdio: 'ignore' })
  // SOTTO_CODEX_EXECUTABLE runs a different Codex build, such as the one the Codex desktop app ships.
  const host = new CodexAppServerHost({ userDataPath: data, ...(process.env.SOTTO_CODEX_EXECUTABLE ? { executable: process.env.SOTTO_CODEX_EXECUTABLE } : {}) })
  const requests: { kind: string; method?: string | undefined; choices: string[]; text?: string | undefined }[] = []
  try {
    const snapshot = await host.connect(); const model = snapshot.models.find(model => model.ready)
    expect(Boolean(model)).toBe(true)
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'computer-use', title: 'Computer Use', path: cwd })
    const threadId = randomUUID()
    expect((await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: 'computer-use', title: 'Computer Use', modelId: model!.id, ...(runtimeMode ? { runtimeMode } : {}) })).accepted).toBe(true)
    await host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: 'computer-use', text: process.env.SOTTO_CODEX_COMPUTER_USE_PROMPT ?? 'Use Computer Use to list the apps that are open on this computer right now. Use only Computer Use; do not run shell commands or read files. If Computer Use is unavailable or refused, reply with one line starting UNAVAILABLE: and the exact reason you were given.' })
    const thread = async () => (await host.snapshot()).threads.find(thread => thread.id === threadId)!
    const answered = new Set<string>()
    const deadline = Date.now() + 240_000
    let current = await thread()
    while (Date.now() < deadline) {
      current = await thread()
      for (const request of current.requests) {
        if (answered.has(request.id)) continue
        answered.add(request.id)
        requests.push({ kind: request.kind, method: request.context?.toolName, choices: (request.permissionChoices ?? []).map(choice => choice.kind), text: short(request.text, 160) })
        const deny = request.permissionChoices?.find(choice => choice.kind === 'deny')
        await host.execute({ type: 'answer', commandId: randomUUID(), threadId, requestId: request.id, answer: 'deny', approved: false, ...(deny ? { permissionChoice: deny.id } : {}) }).catch(error => { requests.at(-1)!.text += ` [answer failed: ${short(String(error), 120)}]` })
      }
      if (current.status !== 'running' && current.messages.some(message => message.role === 'assistant')) break
      await new Promise(done => setTimeout(done, 1000))
    }
    const tools = (current.activities ?? []).filter(activity => activity.kind === 'tool' || activity.kind === 'command')
      .map(activity => ({ kind: activity.kind, title: short(activity.title, 80), status: activity.status, error: short(activity.error, 200) }))
    const reply = current.messages.filter(message => message.role === 'assistant').at(-1)?.text
    console.log(JSON.stringify({ environment, runtimeMode: runtimeMode ?? 'default', version: (await host.snapshot()).version, status: current.status, requests, tools, reply: short(reply, 300) }, null, 1))
  } finally {
    host.disconnect(); await host.closed()
    await removeProbe(root)
  }
}, 300_000)
