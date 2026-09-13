import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { firstSottoWindow } from './support/sottoLaunch'

// Continue ONLY the owned synthetic profile from native-phase2-live. Never send a
// replacement prompt. Reviewed resume is separately opted in and attempted once.
test.describe.configure({ retries: 0, timeout: 120_000 })
test('installed Codex: recover owned Phase 2 evidence without replay', async () => {
  const requested = process.env.SOTTO_NATIVE_PHASE2_RECOVERY_ROOT
  test.skip(process.env.SOTTO_NATIVE_PHASE2_LIVE !== '1' || !requested, 'Explicit existing synthetic recovery opt-in required.')
  await promisify(execFile)(process.execPath, [resolve('scripts/verify-runtime.mjs')], { windowsHide: true, timeout: 15_000 })
  const root = requireOwnedE2EProfile(await realpath(requested!))
  const profile = join(root, 'profile')
  const original = JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
  expect(original.syntheticOnly).toBe(true)
  expect(original.plannedNativeTurns).toBe(2)
  const cached = JSON.parse(await readFile(join(profile, 'workspace.json'), 'utf8')).snapshot.threads
  expect(cached).toHaveLength(1)
  const threadId: string = cached[0].id
  expect(cached[0].title).toBe('Synthetic native Phase 2')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)
  type Frame = { direction: string; method?: string; accepted?: boolean; turn?: string; expectedTurn?: string; inputs?: Array<{ type: string; name?: string; path?: string }> }
  const wire = async (): Promise<Frame[]> => (await readFile(join(root, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const starts = (frames: Frame[]) => frames.filter(value => value.direction === 'request' && value.method === 'turn/start')
  const before = await wire()
  const resume = process.env.SOTTO_NATIVE_PHASE2_RESUME_QUEUED === '1'
  const evidence: Record<string, unknown> = { syntheticOnly: true, passed: false, reviewedResumeRequested: resume, startedAt: new Date().toISOString() }
  let app: ElectronApplication | undefined
  let page: Page
  const launch = async () => {
    app = await electron.launch({ args: [resolve('tests/fixtures/nativePhase2Main.cjs')], env: Object.fromEntries(Object.entries({
      ...process.env, SOTTO_NATIVE_THREADS_LIVE: '1', SOTTO_NATIVE_THREADS_ROOT: root,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')) })
    page = await firstSottoWindow(app)
    await page.waitForFunction(() => !!window.sotto?.agents)
    expect(await page.evaluate(() => typeof window.sottoE2E)).toBe('undefined')
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile)
    await page.evaluate(async threadId => {
      const connected = await window.sotto!.agents!.command({ type: 'connect', provider: 'codex' })
      if (connected.error) throw new Error(connected.error)
      await window.sotto!.agents!.command({ type: 'observe-threads', threadIds: [threadId] })
      await window.sotto!.agents!.command({ type: 'refresh', provider: 'codex' })
    }, threadId)
  }
  const state = () => page.evaluate(() => window.sotto!.agents!.get())
  const current = async () => (await state()).host.threads.find(value => value.id === threadId)!
  const identities = (value: typeof cached[0]) => ({ messages: value.messages.map((m: { id: string }) => hash(m.id)).sort(),
    activities: value.activities.map((a: { id: string }) => hash(a.id)).sort(), cwd: value.workingDirectory,
    lastTurn: { id: hash(value.lastTurn.id), status: value.lastTurn.status } })
  try {
    await launch()
    const restored = identities(await current())
    const baseline = identities(cached[0])
    // The first failed live run also retains hashes from before its shutdown.
    const originalMessages = original.failureState?.messages?.map((value: { id: string }) => value.id).sort() ?? baseline.messages
    expect.soft(restored.messages, 'Historical message identities must survive native resume').toEqual(expect.arrayContaining(originalMessages))
    expect.soft(restored.messages, 'Cached message identities must survive native resume').toEqual(baseline.messages)
    expect({ ...restored, messages: [] }).toEqual({ ...baseline, messages: [] })
    expect(starts(await wire())).toEqual(starts(before))
    evidence.initialReconnect = { sameMessageIds: originalMessages.every((id: string) => restored.messages.includes(id)) &&
      JSON.stringify(restored.messages) === JSON.stringify(baseline.messages), sameActivitiesCwdAndTurn: true, noReplay: true }
    const live = await current()
    expect(live.activities?.some(value => value.kind === 'command' && value.status === 'completed' && value.exitCode === 0 && value.output?.includes('SYNTHETIC_WAIT_FINISHED'))).toBe(true)
    evidence.actualToolRestored = true
    await page!.getByRole('link', { name: 'Threads', exact: true }).click()
    await page!.screenshot({ path: join(root, 'recovery-before.png') })
    if (resume) {
      expect(starts(before)).toHaveLength(1)
      expect(live.status).toBe('idle')
      expect(live.lastTurn?.status).toBe('completed')
      expect(live.requests).toHaveLength(0)
      const queued = (await state()).followups!
      expect(queued).toHaveLength(1)
      expect(queued[0]).toMatchObject({ threadId, status: 'paused' })
      expect(queued[0]!.text).toContain('QUEUED_ONLY')
      expect(queued[0]!.messageId).toBeUndefined()
      const skill = queued[0]!.skills![0]!
      expect(skill.name).toMatch(/^sotto-native-[a-f0-9]{8}$/)
      expect(await realpath(skill.path)).toBe(await realpath(join(live.workingDirectory!, '.agents', 'skills', skill.name, 'SKILL.md')))
      const proofName = `${skill.name}-proof.json`
      const proof = JSON.parse(await readFile(join(live.workingDirectory!, proofName), 'utf8'))
      expect(await realpath(proof.cwd)).toBe(await realpath(live.workingDirectory!))
      expect(await readFile(join(root, 'project', proofName), 'utf8').then(() => true, () => false)).toBe(false)
      // Durable one-shot guard is written BEFORE the only mutation, even if its
      // acknowledgement is lost. A later recovery invocation cannot repeat it.
      await writeFile(join(root, 'reviewed-resume-attempted.json'), JSON.stringify({ at: Date.now(), draft: hash(queued[0]!.draftId) }), { flag: 'wx' })
      const result = await page!.evaluate(threadId => window.sotto!.agents!.command({ type: 'resume-followups', threadId }), threadId)
      if (result.error) throw new Error(result.error)
      await expect.poll(async () => {
        const value = await current()
        return value.status === 'idle' && value.lastTurn?.status === 'completed' && value.messages.some(m => m.role === 'assistant' && m.text.trim() === 'QUEUED_DONE')
      }, { timeout: 60_000, intervals: [250] }).toBe(true)
      expect((await state()).followups).toHaveLength(0)
      const frames = await wire()
      expect(starts(frames)).toHaveLength(2)
      expect(starts(frames)[1]!.inputs).toEqual(starts(frames)[0]!.inputs)
      expect(frames.filter(value => value.direction === 'request' && value.method === 'turn/steer')).toHaveLength(1)
      expect(frames.filter(value => value.direction === 'request' && value.method === 'turn/interrupt')).toHaveLength(0)
      evidence.reviewedQueue = { dispatchedOnce: true, structuredSkillPreserved: true, reply: 'QUEUED_DONE', sourceUntouched: true }
    }
    const completed = await current()
    const beforeRestart = await wire()
    await app!.close(); app = undefined
    await launch()
    const final = identities(await current())
    const previous = identities(completed)
    expect.soft(final.messages, 'Queued-turn message identities must survive native resume').toEqual(previous.messages)
    expect({ ...final, messages: [] }).toEqual({ ...previous, messages: [] })
    expect(starts(await wire())).toEqual(starts(beforeRestart))
    expect((await wire()).filter(value => value.direction === 'request' && value.method === 'thread/start')).toHaveLength(1)
    await page!.getByRole('link', { name: 'Threads', exact: true }).click()
    await page!.screenshot({ path: join(root, 'recovery-after.png') })
    evidence.finalReconnect = { sameMessageIds: JSON.stringify(final.messages) === JSON.stringify(previous.messages), sameActivitiesCwdAndTurn: true, noReplay: true }
    evidence.passed = test.info().errors.length === 0
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await app?.close().catch(() => undefined)
    const frames = await wire()
    evidence.totalNativeTurnRequests = starts(frames).length
    evidence.totalNativeTurnAcceptances = frames.filter(value => value.direction === 'response' && value.method === 'turn/start' && value.accepted).length
    evidence.totalSteers = frames.filter(value => value.direction === 'request' && value.method === 'turn/steer').length
    evidence.finishedAt = new Date().toISOString()
    await writeFile(join(root, 'recovery-evidence.json'), JSON.stringify(evidence, null, 2))
    console.log(`Native Phase 2 recovery artifacts retained: ${root}`)
  }
})
