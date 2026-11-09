// @vitest-environment node
/**
 * Whether the installed Codex still takes each permission mode the way the adapter sends it (#2185). Codex 0.165 and
 * newer refuse `approval_policy = "untrusted"` in a config layer, and Ask for approval rests on `untrusted` sent on
 * requests instead, so a Codex that stops taking it there shows up here before a user's thread does. For each mode it
 * starts an ephemeral thread with `runtimePolicy` and moves another thread to it with `thread/settings/update`, and
 * checks Codex reports the same approval policy, reviewer and sandbox back. It runs in a throwaway `CODEX_HOME`, needs
 * no sign-in, reads nothing from the user's own Codex home, runs no model turn and never runs in CI:
 *
 *   SOTTO_CODEX_POLICY_LIVE=1 npx vitest run tests/integration/codexApprovalPolicyLive.test.ts --maxWorkers=1
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { describe, expect, it } from 'vitest'
import { runtimePolicy } from '../../src/main/agents/providers/codex/codex'
import { findExecutable, nativeEnvironment } from '../../src/main/agents/subscriptionCodex'
import type { AgentRuntimeMode } from '../../src/shared/agents'

const LIVE = process.env.SOTTO_CODEX_POLICY_LIVE === '1'
const MODES: readonly AgentRuntimeMode[] = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } }
const sandboxType = (sandbox: string) => sandbox === 'read-only' ? 'readOnly' : sandbox === 'workspace-write' ? 'workspaceWrite' : 'dangerFullAccess'

class AppServer {
  private next = 0
  private readonly waiters = new Map<number, (message: Message) => void>()
  private readonly notes: Message[] = []
  private readonly noteWaiters: (() => void)[] = []
  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      let message: Message
      try { message = JSON.parse(line) } catch { return }
      if (message.method && message.id === undefined) { this.notes.push(message); this.noteWaiters.splice(0).forEach(wake => wake()); return }
      if (message.id === undefined || message.method) return
      this.waiters.get(message.id)?.(message); this.waiters.delete(message.id)
    })
  }
  static async start(executable: string, home: string, cwd: string): Promise<AppServer> {
    const child = spawn(executable, ['app-server'], { cwd, env: { ...nativeEnvironment(), CODEX_HOME: home }, windowsHide: true, shell: false, stdio: 'pipe' })
    child.stderr.resume()
    const server = new AppServer(child)
    await server.rpc('initialize', { clientInfo: { name: 'sotto-probe', title: 'Sotto probe', version: '1.0' }, capabilities: { experimentalApi: true } })
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    return server
  }
  rpc(method: string, params: unknown): Promise<Message> {
    return new Promise((resolve, reject) => {
      const id = ++this.next
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000)
      this.waiters.set(id, message => { clearTimeout(timer); resolve(message) })
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  /** The first notification named `method` for `threadId`, already arrived or still to come. */
  async notification(method: string, threadId: string): Promise<Message> {
    const deadline = Date.now() + 60_000
    for (;;) {
      const found = this.notes.findIndex(note => note.method === method && note.params?.threadId === threadId)
      if (found >= 0) return this.notes.splice(found, 1)[0]!
      if (Date.now() > deadline) throw new Error(`${method} never arrived`)
      await new Promise<void>(wake => { this.noteWaiters.push(wake); setTimeout(wake, 1000).unref() })
    }
  }
  async stop(): Promise<void> {
    const closed = new Promise(resolve => this.child.once('close', resolve))
    this.child.stdin.end(); setTimeout(() => this.child.kill(), 2000).unref()
    await closed
  }
}

describe.skipIf(!LIVE)('Codex permission modes against the installed app-server (requires SOTTO_CODEX_POLICY_LIVE=1)', () => {
  it('takes each mode on thread/start and thread/settings/update and reports it back', async () => {
    const executable = await findExecutable()
    if (!executable) throw new Error('Codex is not installed')
    const home = await mkdtemp(join(tmpdir(), 'sotto-codex-policy-'))
    if (dirname(resolve(home)) !== resolve(tmpdir()) || !home.includes('sotto-codex-policy-')) throw new Error('Unexpected probe directory')
    const server = await AppServer.start(executable, home, home)
    try {
      for (const [index, mode] of MODES.entries()) {
        const policy = runtimePolicy(mode)
        const started = await server.rpc('thread/start', { cwd: home, ephemeral: true, modelProvider: 'openai', ...policy })
        expect(started.error, `${mode} on thread/start`).toBeUndefined()
        expect(started.result, `${mode} on thread/start`).toMatchObject({ approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer, sandbox: { type: sandboxType(policy.sandbox) } })

        const from = runtimePolicy(MODES[(index + 1) % MODES.length])
        const other = await server.rpc('thread/start', { cwd: home, ephemeral: true, modelProvider: 'openai', ...from })
        const threadId = (other.result?.thread as { id: string }).id
        const updated = await server.rpc('thread/settings/update', { threadId, approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer, sandboxPolicy: { type: sandboxType(policy.sandbox) } })
        expect(updated.error, `${mode} on thread/settings/update`).toBeUndefined()
        const note = await server.notification('thread/settings/updated', threadId)
        expect(note.params?.threadSettings, `${mode} after thread/settings/update`).toMatchObject({ approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer, sandboxPolicy: { type: sandboxType(policy.sandbox) } })
      }
    } finally {
      await server.stop()
      await rm(home, { recursive: true, force: true })
    }
  }, 300_000)
})
