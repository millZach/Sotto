// @vitest-environment node
/**
 * The one thing the fake cannot show for #1042: that a real Codex sub-agent started with `agent_type: "sotto_<role>"`
 * runs as Sotto's role, on the role's model and effort rather than its parent's. One thread on the installed Codex on
 * GPT-6 Astra at low effort, one turn that asks for one Research sub-agent, whose role is GPT-6 Luna at medium effort;
 * read back from that thread's own child session record (`parent_thread_id`, `agent_role`) and the child's turn
 * context (`model`, `effort`). It spends one short turn on the signed-in account and leaves that thread's sessions in
 * the user's Codex home like any other Sotto thread's, so it never runs in CI and runs only when asked:
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
type Line = { type?: string; payload?: Record<string, unknown> }
type Spawn = { parent_thread_id?: string; agent_role?: string }

describe('requires SOTTO_CODEX_LIVE=1', () => {
  it.skipIf(process.env.SOTTO_CODEX_LIVE !== '1')('starts a Codex sub-agent as Sotto\'s Research role, on the role\'s model and effort', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-codex-role-probe-'))
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-codex-role-probe-')) throw new Error('Unexpected probe directory')
    const host = new CodexAppServerHost({ userDataPath: directory })
    host.useWorkerRoles(new WorkerRoles(() => [{ kind: 'research', name: 'Research', what: 'Reading code, docs and the web, and reporting back.',
      provider: 'codex', model: 'gpt-6-luna', modelName: 'GPT-6 Luna', reasoningEffort: 'medium', runtimeMode: 'approval-required' }]))
    const since = Date.now()
    try {
      const snapshot = await host.connect()
      const parent = snapshot.models.find(model => model.ready && model.id === 'gpt-6-astra' && model.reasoningEfforts?.includes('low'))
      expect(parent, 'The installed catalog must offer GPT-6 Astra at low effort').toBeDefined()
      expect(snapshot.models.find(model => model.ready && model.id === 'gpt-6-luna' && model.reasoningEfforts?.includes('medium')), 'and GPT-6 Luna at medium').toBeDefined()
      const threadId = randomUUID()
      await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'probe', title: 'Role probe', path: directory })
      expect(await host.execute({ type: 'create-thread', commandId: randomUUID(), projectId: 'probe', threadId, title: 'Synthetic role probe', modelId: parent!.id, reasoningEffort: 'low', runtimeMode: 'approval-required' })).toEqual({ accepted: true })
      const parentId = (JSON.parse(await readFile(join(directory, 'codex-threads.json'), 'utf8')) as Record<string, { codexThreadId: string }>)[threadId]!.codexThreadId
      expect((await host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(),
        text: 'Start exactly one sub-agent with spawn_agent and agent_type "sotto_research". Ask it to reply with the single word ready. Wait for it, then reply with its word.' })).accepted).toBe(true)
      const deadline = Date.now() + 180_000
      let child: { model?: unknown; effort?: unknown } | undefined
      while (!child && Date.now() < deadline) {
        await new Promise(done => setTimeout(done, 2000))
        for (const path of await rolloutsSince(process.env.CODEX_HOME ?? join(homedir(), '.codex'), since)) {
          const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Line)
          const meta = lines.find(line => line.type === 'session_meta')?.payload as { source?: { subagent?: { thread_spawn?: Spawn } } } | undefined
          const spawn = meta?.source?.subagent?.thread_spawn
          const context = lines.find(line => line.type === 'turn_context')?.payload
          if (spawn?.parent_thread_id === parentId && spawn.agent_role === 'sotto_research' && context) {
            child = { model: context.model, effort: context.effort ?? context.reasoning_effort }
          }
        }
      }
      // The parent runs GPT-6 Astra at low, so these can only have come from the role.
      expect(child).toEqual({ model: 'gpt-6-luna', effort: 'medium' })
    } finally {
      host.disconnect(); await host.closed()
      await rm(directory, { recursive: true, force: true })
    }
  }, 240_000)
})
