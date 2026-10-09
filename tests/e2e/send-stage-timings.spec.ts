/**
 * A send in the running app writes its send stages to its turn record (#763). The built app runs the real Claude
 * and Codex adapters over the fake CLIs in `tests/fixtures/` (`SOTTO_E2E_NATIVE_FIXTURE_ROOT` in `src/main/index.ts`),
 * with the workspace, its checkpoints and Git status wired as they always are. Each fake answers every prompt at
 * once. The window sends a prompt to a thread in a Git working copy, and `turns.jsonl` in the profile must then hold
 * that send's record with every step timed and no text in it. Run after `npm run build`:
 *
 *   npx playwright test tests/e2e/send-stage-timings.spec.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { SEND_STAGE_FIELDS } from '../../src/main/agents/sendStages'
import { closeSotto, launchSotto, type LaunchedSotto } from './support/sottoLaunch'

const PROMPT = 'Synthetic stage-timing prompt'
const REPLY = 'Synthetic stage-timing reply'

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider}: a send writes how long each step took to its turn record`, async () => {
    test.setTimeout(180_000)
    const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-stages-'))
    const root = join(profile, 'native-fixture')
    const project = join(root, 'project')
    for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
    for (const folder of ['claude', 'codex']) await writeFile(join(root, folder, 'script.json'), JSON.stringify({ reply: REPLY }))
    await writeFile(join(project, 'README.md'), 'Filler\n')
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Sotto e2e', '-c', 'user.email=e2e@example.invalid', ...args], { cwd: project, stdio: 'ignore', windowsHide: true })
    git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'Filler')
    const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
    process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
    process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
    let launched: LaunchedSotto | undefined
    try {
      launched = await launchSotto('success', profile)
      const { page } = launched
      const threadId = await page.evaluate(async ({ provider, project, prompt }) => {
        await window.sotto!.updateSettings({ onboardingComplete: true })
        const agents = window.sotto!.agents!
        const configured = await agents.command({ type: 'configure', patch: { provider, enabled: true, enabledProviders: [provider], } })
        if (configured.error) throw new Error(configured.error)
        const connected = await agents.command({ type: 'connect', provider })
        if (connected.error) throw new Error(connected.error)
        const created = await agents.command({ type: 'create-project', provider, title: 'Stage timings', path: project, useExisting: true })
        if (created.error) throw new Error(created.error)
        const projectId = created.host.projects.find(item => item.title === 'Stage timings')!.id
        const model = (await agents.get()).host.models.find(item => item.providerId === provider && item.ready)
        if (!model) throw new Error(`No ready ${provider} model.`)
        const thread = await agents.command({ type: 'create-thread', projectId, title: 'Timed', titleSource: 'user', modelId: model.id, workingCopy: 'shared', managed: false })
        if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
        // Twice: the first send starts the provider's session, the second is a send to a session already running.
        for (let index = 0; index < 2; index++) {
          for (let wait = 0; (await agents.get()).host.threads.find(item => item.id === thread.activeThreadId)?.status !== 'idle'; wait++) {
            if (wait > 600) throw new Error('The thread did not finish its turn.')
            await new Promise(done => setTimeout(done, 50))
          }
          const sent = await agents.command({ type: 'manual-send', threadId: thread.activeThreadId, text: prompt })
          if (sent.error) throw new Error(sent.error)
        }
        return thread.activeThreadId
      }, { provider, project, prompt: PROMPT })
      const records = async () => (await readFile(join(profile, 'turns.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
        .map(line => ({ line, record: JSON.parse(line) as { commandType: string; threadId: string | null; outcome: string; timings: Record<string, unknown> } }))
        // The window names a thread with its host (`host:<host>:<thread>`); the host's own record names it alone.
        .filter(({ record }) => record.commandType === 'manual-send' && record.threadId !== null && threadId.endsWith(`:${record.threadId}`))
      await expect.poll(async () => (await records()).length, { timeout: 60_000 }).toBe(2)
      for (const { line, record } of await records()) {
        expect(record.outcome).toBe('completed')
        for (const stage of SEND_STAGE_FIELDS) expect(record.timings[stage], stage).toEqual(expect.any(Number))
        expect(line).not.toContain(PROMPT)
        expect(line).not.toContain(REPLY)
        expect(line).not.toContain('Stage timings')
      }
      const violations = await Promise.all(['claude', 'codex'].map(folder => readFile(join(root, folder, 'violations.jsonl'), 'utf8').catch(() => '')))
      expect(violations.join('')).toBe('')
      console.log(`send stages: ${JSON.stringify({ provider, records: (await records()).map(({ record }) => Object.fromEntries(SEND_STAGE_FIELDS.map(stage => [stage, record.timings[stage]]))) })}`)
    } finally {
      if (launched) await closeSotto(launched)
      for (const [key, value] of [['SOTTO_E2E_NATIVE_FIXTURE_ROOT', previous.root], ['SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE', previous.executable]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value
      }
      await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
    }
  })
}
