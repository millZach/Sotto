import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { AgentCommand } from '../../../src/shared/agents'
import { ownedE2EProfile, removeOwnedE2EProfile } from './e2eProfile'
import { closeSotto, launchSotto, type LaunchedSotto } from './sottoLaunch'

/** A Sotto started on the fake Claude Code and Codex CLIs in `tests/fixtures/`, and the folder those fakes keep their state in. */
export interface NativeCodexFixture {
  readonly launched: LaunchedSotto
  /** Holds `claude/`, `codex/` (its `script.json`, `state.json` and `control.json`) and `project/`. */
  readonly root: string
}

/**
 * Starts Sotto on its own profile with the fake native CLIs, Codex scripted by `script` (its `script.json`), runs `use`,
 * then closes Sotto, puts the fakes' environment back and removes the profile, whether `use` passed or not.
 */
export async function withNativeCodexFixture(prefix: string, script: Record<string, unknown>,
  use: (fixture: NativeCodexFixture) => Promise<void>): Promise<void> {
  const profile = (await ownedE2EProfile({ prefix })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify(script))
  const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    await use({ launched, root })
  } finally {
    if (launched) await closeSotto(launched)
    if (previous.root === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT
    else process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = previous.root
    if (previous.executable === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE
    else process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = previous.executable
    await removeOwnedE2EProfile(profile)
  }
}

/**
 * Connects Codex alone, makes a project of the fixture's `project/` folder and a thread in it on Codex's first ready model,
 * and sends `prompt`, all through the page's own bridge. `runtimeMode` is the thread's permissions, Codex's default when absent.
 */
export async function startCodexThread(page: Page, root: string, names: { readonly project: string; readonly thread: string; readonly prompt: string;
  readonly runtimeMode?: Extract<AgentCommand, { type: 'create-thread' }>['runtimeMode'] }): Promise<void> {
  await page.evaluate(async ({ path, names }) => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
    const agents = window.sotto!.agents!
    await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], checkClientUpdates: false } })
    await agents.command({ type: 'connect', provider: 'codex' })
    const created = await agents.command({ type: 'create-project', provider: 'codex', title: names.project, path, useExisting: true })
    const projectId = created.host.projects.find(project => project.title === names.project)!.id
    const modelId = (await agents.get()).host.models.find(model => model.providerId === 'codex' && model.ready)!.id
    const thread = await agents.command({ type: 'create-thread', projectId, title: names.thread, titleSource: 'user', modelId, workingCopy: 'shared',
      ...(names.runtimeMode ? { runtimeMode: names.runtimeMode } : {}) })
    if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'Missing thread')
    await agents.command({ type: 'manual-send', threadId: thread.activeThreadId, text: names.prompt })
  }, { path: join(root, 'project'), names })
}
