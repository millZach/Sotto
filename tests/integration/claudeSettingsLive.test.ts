// @vitest-environment node
/**
 * Opt-in live check (#317) that the installed, signed-in Claude Code takes all three settings requests Sotto
 * sends to a running session: `set_model`, `apply_flag_settings` with `effortLevel`, and `set_permission_mode`.
 * It creates a synthetic project in a temporary folder, starts one thread's CLI and changes its settings. No
 * prompt is sent and no model turn runs. What the CLI reports back through `get_settings` is compared, and only
 * whether each value matched is printed, with the CLI version and the timings; no prompt, reply or key is.
 *
 *   PowerShell:  $env:SOTTO_CLAUDE_LIVE = '1'; npx vitest run tests/integration/claudeSettingsLive.test.ts --maxWorkers=1 --disable-console-intercept
 *   sh:          SOTTO_CLAUDE_LIVE=1 npx vitest run tests/integration/claudeSettingsLive.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeStreamJsonHost, type ClaudeSettingsEvent } from '../../src/main/agents/claude'
import { object, type ClaudeFrame, type ClaudeProtocol } from '../../src/main/agents/claudeProtocol'
import type { AgentHostResult } from '../../src/main/agents/host'
import type { AgentRuntimeMode } from '../../src/shared/agents'
import { round } from '../fixtures/perfBench'

const LIVE = process.env.SOTTO_CLAUDE_LIVE === '1'
type Runtimes = { runtimes: Map<string, { protocol: ClaudeProtocol }>; stopSession(id: string): Promise<void>; frame(id: string, frame: ClaudeFrame): void }

describe.skipIf(!LIVE)('Claude settings on a running session (live)', () => {
  it('applies a model, an effort level and a permission mode to the running CLI without starting another', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-claude-settings-live-')); const cwd = join(root, 'project'); await mkdir(cwd)
    const events: ClaudeSettingsEvent[] = []
    const options = { userDataPath: root, requestTimeoutMs: 20_000, pollIntervalMs: 250, logEvent: (event: ClaudeSettingsEvent) => { events.push(event) } }
    const host = new ClaudeStreamJsonHost(options)
    const id = randomUUID()
    const internals = () => host as unknown as Runtimes
    const runtime = () => internals().runtimes.get(id)
    // The permission mode the CLI reports on its own system frames, read field by field and nothing else.
    const reportedModes: unknown[] = []
    const frame = internals().frame.bind(host)
    internals().frame = (thread, value) => {
      if (value.type === 'system' && 'permissionMode' in value) reportedModes.push(value.permissionMode)
      frame(thread, value)
    }
    /** What the CLI says it will use for its next request; fields it does not report are absent. */
    const applied = async (): Promise<Record<string, unknown>> => object((await runtime()!.protocol.control({ subtype: 'get_settings' })).applied) ?? {}
    const timed = async (change: { modelId?: string; reasoningEffort?: string; runtimeMode?: AgentRuntimeMode }): Promise<{ result: AgentHostResult; ms: number }> => {
      const startedAt = performance.now()
      const result = await host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, ...change })
      return { result, ms: round(performance.now() - startedAt) }
    }
    try {
      const status = await host.connect()
      expect(status.connected, status.error ?? 'Claude Code is not signed in').toBe(true)
      // Two ready models that each report at least two effort levels, so every change has somewhere to go.
      const models = status.models.filter(model => model.ready && (model.reasoningEfforts?.length ?? 0) >= 2)
      expect(models.length).toBeGreaterThanOrEqual(2)
      const [first, second] = models as [typeof models[0], typeof models[0]]
      await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'synthetic', title: 'Synthetic settings', path: cwd })
      await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'synthetic', title: 'Synthetic settings',
        modelId: first.id, reasoningEffort: first.reasoningEfforts![0]!, runtimeMode: 'approval-required' })
      host.observeThreads([id])
      await host.refreshThread(id)
      const cli = runtime()
      expect(cli).toBeDefined()
      const initial = await applied()

      const effortLevel = first.reasoningEfforts![1]!
      const effort = await timed({ reasoningEffort: effortLevel })
      const afterEffort = await applied()
      // Aliases such as `default` and `opus` can name the same model, so the change moves on through the catalog
      // until the CLI reports a different one.
      let target = second
      let model = await timed({ modelId: target.id })
      let afterModel = await applied()
      let modelPresses = 1
      for (const candidate of models.slice(2)) {
        if (afterModel.model !== initial.model) break
        target = candidate; model = await timed({ modelId: target.id }); afterModel = await applied(); modelPresses++
      }
      const modesBefore = reportedModes.length
      const mode = await timed({ runtimeMode: 'auto-accept-edits' })
      const afterMode = await applied()
      const modesReported = reportedModes.slice(modesBefore)
      const back = await timed({ runtimeMode: 'approval-required' })
      for (const change of [effort, model, mode, back]) expect(change.result.accepted).toBe(true)
      // Every change reached the process that was already running; none started another.
      expect(runtime()).toBe(cli)
      expect(events.length).toBeGreaterThanOrEqual(4)
      expect(events.every(event => event === 'claude-settings-applied-live')).toBe(true)

      // The old path on a running session, for comparison: stop the CLI, then change a setting, which starts it again.
      const stoppedAt = performance.now()
      await internals().stopSession(id)
      const restart = await timed({ reasoningEffort: first.reasoningEfforts![0]! })
      const restartMs = round(performance.now() - stoppedAt)
      expect(restart.result.accepted).toBe(true)
      expect(events.at(-1)).toBe('claude-settings-applied-restart')

      const readBack = (after: Record<string, unknown>, key: string, expected: unknown) =>
        !(key in after) ? 'not reported' : after[key] === expected ? 'matched' : after[key] !== initial[key] ? 'changed' : 'unchanged'
      console.info(`claude settings live: ${JSON.stringify({
        cliVersion: (await host.snapshot()).version,
        acknowledged: { set_model: model.result.accepted, apply_flag_settings: effort.result.accepted, set_permission_mode: mode.result.accepted },
        readBack: { effort: readBack(afterEffort, 'effort', effortLevel), model: readBack(afterModel, 'model', target.id), effortAfterModel: readBack(afterModel, 'effort', effortLevel), permissionMode: readBack(afterMode, 'permissionMode', 'acceptEdits') },
        // Model names and modes are settings, not anything the thread said, so the values themselves are shown.
        models: { from: first.id, to: target.id, presses: modelPresses, appliedBefore: initial.model ?? null, appliedAfter: afterModel.model ?? null },
        permissionModeFrames: modesReported,
        appliedFields: Object.keys(afterMode).sort(),
        pressToAcceptedMs: { effort: effort.ms, model: model.ms, permissionMode: mode.ms, permissionModeBack: back.ms },
        stopAndStartAgainMs: restartMs, startOnlyMs: restart.ms,
      })}`)
      // The CLI must never report the effort it was given as something else.
      if ('effort' in afterEffort) expect(afterEffort.effort).toBe(effortLevel)
      if ('permissionMode' in afterMode) expect(afterMode.permissionMode).toBe('acceptEdits')
      if (modesReported.length) expect(modesReported.at(-1)).toBe('acceptEdits')
      if ('model' in afterModel) expect(afterModel.model).not.toBe(initial.model)
    } finally {
      host.disconnect(); await host.closed()
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 240_000)
})
