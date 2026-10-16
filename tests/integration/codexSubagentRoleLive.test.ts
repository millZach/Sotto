// @vitest-environment node
/**
 * The one thing the fake cannot show for #1042: that a real Codex sub-agent started with `agent_type: "sotto_<role>"`
 * runs as Sotto's role, on its model. One thread on the installed Codex, one turn that asks for one Research sub-agent
 * on GPT-6 Luna at low effort, read back from the child's own session record (`agent_role`, `model`). It spends one
 * short turn on the signed-in account and leaves that thread's sessions in the user's Codex home like any other Sotto
 * thread's, so it never runs in CI and runs only when asked:
 *
 *   SOTTO_CODEX_LIVE=1 npx vitest run tests/integration/codexSubagentRoleLive.test.ts --maxWorkers=1
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import { WorkerRoles } from '../../src/main/agents/subagentRoles'

/** Every rollout under the Codex home's sessions folder written since `since`. */
async function rolloutsSince(home: string, since: number): Promise<string[]> {
  const found: string[] = []
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.jsonl') && (await stat(path)).mtimeMs >= since) found.push(path)
    }
  }
  await walk(join(home, 'sessions'))
  return found
}

describe('requires SOTTO_CODEX_LIVE=1', () => {
  it.skipIf(process.env.SOTTO_CODEX_LIVE !== '1')('starts a Codex sub-agent as Sotto\'s Research role, on the role\'s model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-codex-role-probe-'))
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-codex-role-probe-')) throw new Error('Unexpected probe directory')
    const host = new CodexAppServerHost({ userDataPath: directory })
    host.useWorkerRoles(new WorkerRoles(() => [{ kind: 'research', name: 'Research', what: 'Reading code, docs and the web, and reporting back.',
      provider: 'codex', model: 'gpt-6-luna', modelName: 'GPT-6 Luna', reasoningEffort: 'low', runtimeMode: 'approval-required' }]))
    const since = Date.now()
    try {
      const snapshot = await host.connect()
      const parent = snapshot.models.find(model => model.ready && model.id === 'gpt-6-luna')
      expect(parent, 'The installed catalog must offer GPT-6 Luna').toBeDefined()
      const threadId = randomUUID()
      await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'probe', title: 'Role probe', path: directory })
      expect(await host.execute({ type: 'create-thread', commandId: randomUUID(), projectId: 'probe', threadId, title: 'Synthetic role probe', modelId: parent!.id, reasoningEffort: 'low', runtimeMode: 'approval-required' })).toEqual({ accepted: true })
      expect((await host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(),
        text: 'Start exactly one sub-agent with spawn_agent and agent_type "sotto_research". Ask it to reply with the single word ready. Wait for it, then reply with its word.' })).accepted).toBe(true)
      const deadline = Date.now() + 180_000
      let child: { agent_role?: string | undefined; model?: string | undefined } | undefined
      while (!child && Date.now() < deadline) {
        await new Promise(done => setTimeout(done, 2000))
        for (const path of await rolloutsSince(process.env.CODEX_HOME ?? join(homedir(), '.codex'), since)) {
          const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> })
          const meta = lines.find(line => line.type === 'session_meta')?.payload as { source?: { subagent?: { thread_spawn?: { agent_role?: string } } } } | undefined
          const role = meta?.source?.subagent?.thread_spawn?.agent_role
          if (role === 'sotto_research') child = { agent_role: role, model: lines.find(line => line.type === 'turn_context')?.payload?.model as string | undefined }
        }
      }
      expect(child?.agent_role).toBe('sotto_research')
      expect(child?.model).toBe('gpt-6-luna')
    } finally {
      host.disconnect(); await host.closed()
      await rm(directory, { recursive: true, force: true })
    }
  }, 240_000)
})
