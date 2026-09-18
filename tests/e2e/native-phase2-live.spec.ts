import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { AgentCommand, AgentState, AgentThread } from '../../src/shared/agents'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { firstSottoWindow, openThreads } from './support/sottoLaunch'

// Real installed subscription work. Two new turns (including queue), one steer;
// never retry this test after dispatch. No fixture provider or auth/config copying.
test.describe.configure({ retries: 0, timeout: 180_000 })
type Wire = { at: number; direction: string; method?: string; accepted?: boolean; thread?: string; turn?: string;
  expectedTurn?: string; cwd?: string; inputs?: Array<{ type: string; name?: string; path?: string }> }
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)
const run = promisify(execFile)

test('installed Codex: structured skill, worktree, queue, steer and restart without replay', async () => {
  test.skip(process.env.SOTTO_NATIVE_PHASE2_LIVE !== '1', 'Requires explicit bounded native subscription opt-in.')
  test.skip(!!process.env.SOTTO_NATIVE_PHASE2_RECOVERY_ROOT, 'Recovery mode must not create another native project or turn.')
  await run(process.execPath, [resolve('scripts/verify-runtime.mjs')], { windowsHide: true, timeout: 15_000 })
  const root = requireOwnedE2EProfile(await realpath(await mkdtemp(join(tmpdir(), 'sotto-e2e-native-'))))
  const profile = join(root, 'profile'); const project = join(root, 'project')
  const skillName = `sotto-native-${randomUUID().slice(0, 8)}`
  const proofName = `${skillName}-proof.json`
  const skillDirectory = join(project, '.agents', 'skills', skillName)
  await mkdir(profile); await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true, historyEnabled: true }))
  const nonce = randomUUID()
  const scriptName = `${skillName}-proof.cjs`
  await writeFile(join(project, scriptName), [
    "const fs = require('node:fs');",
    "if (fs.realpathSync(process.cwd()) !== fs.realpathSync(__dirname)) throw new Error('Wrong cwd');",
    `const proof = ${JSON.stringify(proofName)};`,
    "if (fs.existsSync(proof)) throw new Error('Proof already exists: no duplicate execution');",
    `fs.writeFileSync(proof, JSON.stringify({ nonce: ${JSON.stringify(nonce)}, cwd: fs.realpathSync(process.cwd()) }));`,
    "console.log('SYNTHETIC_WAIT_STARTED'); setTimeout(() => console.log('SYNTHETIC_WAIT_FINISHED'), 10000);",
  ].join('\n'))
  await writeFile(join(skillDirectory, 'SKILL.md'), [
    '---', `name: ${skillName}`, 'description: Run the explicitly selected synthetic native acceptance proof.', '---', '',
    'Operate only in this synthetic project working directory. No outside project access, network, delegates or other skills.',
    `For PROVE, invoke one shell tool with command: node ${scriptName}`,
    'The command writes one unique proof and waits 10 seconds. Wait for it to finish; do not repeat it. Then reply FIRST_DONE.',
    'For STEER_ONLY, run no additional command. Finish the current command and reply STEER_APPLIED instead of FIRST_DONE.',
    'For QUEUED_ONLY, run no tools and reply QUEUED_DONE.',
  ].join('\n'))
  const git = (args: string[]) => run('git', args, { cwd: project, windowsHide: true, timeout: 15_000 })
  await git(['init', '--quiet'])
  await git(['add', '.'])
  await git(['-c', 'user.name=Sotto Synthetic Smoke', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Synthetic native acceptance project'])

  let app: ElectronApplication | undefined
  let page: Page | undefined
  let threadId = ''
  const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), syntheticOnly: true,
    plannedNativeTurns: 2, maxNativeTurns: 3, maxSteers: 1, passed: false, checkpoints: [] }
  const checkpoints = evidence.checkpoints as string[]
  const wire = async (): Promise<Wire[]> => (await readFile(join(root, 'wire.jsonl'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as Wire)
  const checkpoint = async (name: string) => {
    checkpoints.push(name)
    await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2))
    console.log(`Native Phase 2 checkpoint: ${name}`)
  }
  const state = () => page!.evaluate(() => window.sotto!.agents!.get())
  const thread = async (): Promise<AgentThread> => {
    const current = (await state()).host.threads.find(value => value.id === threadId)
    if (!current) throw new Error('Synthetic thread missing')
    return current
  }
  const command = async (value: AgentCommand): Promise<AgentState> => {
    const result = await page!.evaluate(value => window.sotto!.agents!.command(value), value)
    if (result.error) throw new Error(result.error)
    return result
  }
  const launch = async () => {
    app = await electron.launch({ args: [resolve('tests/fixtures/nativePhase2Main.cjs')], env: Object.fromEntries(Object.entries({
      ...process.env, SOTTO_NATIVE_THREADS_LIVE: '1', SOTTO_NATIVE_THREADS_ROOT: root,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')) })
    page = await firstSottoWindow(app)
    await page.waitForFunction(() => !!window.sotto?.agents)
    expect(await page.evaluate(() => typeof window.sottoE2E)).toBe('undefined')
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile)
  }
  try {
    await launch()
    await command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'],
      speak: false, reasoning: 'none', followupLimit: 0 } })
    const connected = await command({ type: 'connect', provider: 'codex' })
    const model = connected.host.models.find(value => value.providerId === 'codex' && value.ready && /luna|mini/i.test(value.name))
    if (!model) throw new Error('No ready Luna/mini model in installed catalog; no native turn initiated.')
    const effort = ['minimal', 'low', 'none'].find(value => model.reasoningEfforts?.includes(value))
    if (!effort) throw new Error('No supported low reasoning effort; no native turn initiated.')
    evidence.model = { name: model.name, reasoningEffort: effort }; evidence.version = connected.host.providers?.find(value => value.id === 'codex')?.version ?? connected.host.version
    await checkpoint('production connected; ready economical model selected from installed catalog')
    const registered = await command({ type: 'create-project', provider: 'codex', path: project, title: 'Synthetic Phase 2', useExisting: true })
    const projectId = registered.host.projects.find(value => resolve(value.path) === resolve(project))!.id
    const created = await command({ type: 'create-thread', projectId, title: 'Synthetic native Phase 2', modelId: model.id,
      workingCopy: 'independent', runtimeMode: 'full-access', reasoningEffort: effort, managed: false })
    threadId = created.activeThreadId!
    expect(created.host.threads).toHaveLength(1)
    const working = await thread()
    expect(working.worktree).toMatchObject({ mode: 'independent', status: 'ready' })
    const cwd = await realpath(working.workingDirectory!)
    const inside = relative(root, cwd)
    expect(isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)).toBe(false)
    expect(cwd).not.toBe(await realpath(project))
    const selected = await command({ type: 'refresh-thread-skills', threadId, forceReload: true })
    const catalog = selected.skillCatalogs?.find(value => value.threadId === threadId)
    expect(catalog?.status).toBe('ready')
    expect(await realpath(catalog!.cwd)).toBe(cwd)
    const skill = catalog!.skills.find(value => value.name === skillName)!
    expect(skill).toBeTruthy()
    expect(await realpath(skill.path)).toBe(await realpath(join(cwd, '.agents', 'skills', skillName, 'SKILL.md')))
    const skills = [{ name: skill.name, path: skill.path }]
    evidence.worktree = { relativeCwd: inside.split(sep).join('/'), independent: true, skillInActualCwd: true }
    await checkpoint('independent worktree and native project skill catalog verified')

    // Only these two commands may initiate turns. Polls/readbacks never resubmit.
    await command({ type: 'manual-send', threadId, draftId: randomUUID(), skills,
      text: `$${skillName} PROVE. Use the selected skill once. Work only inside this synthetic project; no outside access.` })
    await expect.poll(async () => (await thread()).activities?.some(value => value.kind === 'command' && value.status === 'running' && value.command?.includes(scriptName)),
      { timeout: 60_000, intervals: [100] }).toBe(true)
    const active = await thread()
    const activeTurn = active.activities!.find(value => value.kind === 'command' && value.status === 'running' && value.command?.includes(scriptName))!.turnId
    expect(active.status).toBe('running')
    const queueDraft = randomUUID()
    const queued = await command({ type: 'queue-followup', threadId, draftId: queueDraft, skills,
      text: `$${skillName} QUEUED_ONLY. Reply QUEUED_DONE with no tools. No outside project access.` })
    expect(queued.followups?.some(value => value.draftId === queueDraft && value.status === 'queued')).toBe(true)
    expect((await wire()).filter(value => value.direction === 'request' && value.method === 'turn/start')).toHaveLength(1)
    await command({ type: 'steer', threadId, draftId: randomUUID(), skills,
      text: `$${skillName} STEER_ONLY. Finish the current command, then reply STEER_APPLIED. No more tools or outside project access.` })
    const afterSteer = await wire()
    const steerRequest = afterSteer.find(value => value.direction === 'request' && value.method === 'turn/steer')!
    const steerResponse = afterSteer.find(value => value.direction === 'response' && value.method === 'turn/steer')!
    expect(steerRequest.expectedTurn).toBe(digest(activeTurn))
    expect(steerResponse).toMatchObject({ accepted: true, turn: digest(activeTurn) })
    evidence.steer = { sameTurn: true, activeTurn: digest(activeTurn), queuedWhileRunning: true }
    await checkpoint('one queued follow-up and one accepted steer in the same native turn')
    await expect.poll(async () => {
      const current = await thread()
      return current.status === 'idle' && current.lastTurn?.status === 'completed' &&
        current.messages.some(value => value.role === 'assistant' && value.text.trim() === 'QUEUED_DONE')
    }, { timeout: 75_000, intervals: [250] }).toBe(true)
    const completed = await thread()
    const proof = JSON.parse(await readFile(join(cwd, proofName), 'utf8')) as { nonce: string; cwd: string }
    expect(proof).toEqual({ nonce, cwd })
    expect(await readFile(join(project, proofName), 'utf8').then(() => true, () => false)).toBe(false)
    expect(completed.messages.some(value => value.role === 'assistant' && value.text.trim() === 'STEER_APPLIED')).toBe(true)
    expect((await state()).followups).toHaveLength(0)
    expect((await state()).assignments).toHaveLength(0)
    expect(completed.requests).toHaveLength(0)
    const commands = completed.activities!.filter(value => value.kind === 'command')
    expect(commands.some(value => value.status === 'completed' && value.exitCode === 0 && value.command?.includes(scriptName) &&
      value.output?.includes('SYNTHETIC_WAIT_FINISHED') && resolve(value.cwd!) === cwd)).toBe(true)
    const beforeWire = await wire()
    const starts = beforeWire.filter(value => value.direction === 'request' && value.method === 'turn/start')
    expect(starts).toHaveLength(2)
    expect(beforeWire.filter(value => value.direction === 'request' && value.method === 'turn/steer')).toHaveLength(1)
    expect(beforeWire.filter(value => value.direction === 'request' && value.method === 'turn/interrupt')).toHaveLength(0)
    for (const input of [...starts, steerRequest]) expect(input.inputs).toEqual([
      { type: 'text' }, { type: 'skill', name: skillName, path: relative(root, skill.path).split(sep).join('/') },
    ])
    const firstCompletion = beforeWire.find(value => value.direction === 'notification' && value.method === 'turn/completed' && value.turn === digest(activeTurn))!
    expect(starts[1]!.at).toBeGreaterThanOrEqual(firstCompletion.at)
    const nativeTurns = beforeWire.filter(value => value.direction === 'response' && value.method === 'turn/start' && value.accepted).map(value => value.turn)
    expect(new Set(nativeTurns).size).toBe(2)
    evidence.execution = { nativeTurns, proofNonceMatches: true, sourceUntouched: true, completedToolCommands: commands.length,
      queuedAfterCompletion: true, structuredSkillOnSendQueueSteer: true }
    await checkpoint('two real turns completed; tool proof, structured wire input and queue order verified')
    const userIds = completed.messages.filter(value => value.role === 'user').map(value => value.id).sort()
    expect(userIds).toHaveLength(3)
    const messageIdentities = completed.messages.map(({ id, role, commandId }) => ({ id, role, commandId }))
    expect(messageIdentities.filter(value => value.role === 'user').every(value => !!value.commandId)).toBe(true)
    expect(new Set(messageIdentities.map(value => value.id)).size).toBe(messageIdentities.length)
    const activities = completed.activities!.map(value => value.id).sort()
    const activityAnchors = completed.activities!.map(({ id, afterMessageId }) => ({ id, afterMessageId }))
    const bindings = await readFile(join(profile, 'threads.json'), 'utf8')
    const aliases = JSON.parse(await readFile(join(profile, 'codex-threads.json'), 'utf8'))
    await openThreads(page!)
    await page!.screenshot({ path: join(root, 'completed.png') })
    await app!.close(); app = undefined
    await launch()
    if ((await state()).connection !== 'connected') await command({ type: 'connect', provider: 'codex' })
    await command({ type: 'observe-threads', threadIds: [threadId] })
    await command({ type: 'refresh', provider: 'codex' })
    await expect.poll(async () => (await thread()).messages.filter(value => value.role === 'user').map(value => value.id).sort(), { timeout: 20_000 }).toEqual(userIds)
    const restored = await thread()
    expect(restored.messages.map(({ id, role, commandId }) => ({ id, role, commandId }))).toEqual(messageIdentities)
    expect(restored.activities!.map(value => value.id).sort()).toEqual(activities)
    expect(restored.activities!.map(({ id, afterMessageId }) => ({ id, afterMessageId }))).toEqual(activityAnchors)
    expect(restored.workingDirectory).toBe(completed.workingDirectory)
    expect(restored.lastTurn).toEqual(completed.lastTurn)
    expect((await state()).followups).toHaveLength(0)
    expect(await readFile(join(profile, 'threads.json'), 'utf8')).toBe(bindings)
    const restoredAliases = JSON.parse(await readFile(join(profile, 'codex-threads.json'), 'utf8'))
    expect(Object.keys(restoredAliases)).toEqual(Object.keys(aliases))
    for (const id of Object.keys(aliases)) expect(restoredAliases[id].codexThreadId).toBe(aliases[id].codexThreadId)
    const afterWire = await wire()
    expect(afterWire.filter(value => value.direction === 'request' && value.method === 'turn/start')).toEqual(starts)
    expect(afterWire.filter(value => value.direction === 'request' && value.method === 'turn/steer')).toEqual([steerRequest])
    expect(afterWire.filter(value => value.direction === 'request' && value.method === 'thread/start')).toHaveLength(1)
    expect(afterWire.some(value => value.direction === 'response' && value.method === 'thread/resume' && value.accepted)).toBe(true)
    expect(await readFile(join(cwd, proofName), 'utf8')).toBe(JSON.stringify(proof))
    await openThreads(page!)
    await page!.screenshot({ path: join(root, 'restored.png') })
    evidence.reconnect = { sameNativeSession: true, sameMessagesAndActivities: true, sameCwd: true, noReplay: true }
    evidence.passed = true
    await checkpoint('production app restarted; native resume preserved identities with no replay')
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error)
    if (threadId && page && !page.isClosed()) {
      const current = await thread().catch(() => undefined)
      evidence.failureState = current && { status: current.status, lastTurn: current.lastTurn && { id: digest(current.lastTurn.id), status: current.lastTurn.status },
        messages: current.messages.map(value => ({ role: value.role, id: digest(value.id) })),
        activities: current.activities?.map(value => ({ kind: value.kind, status: value.status, exitCode: value.exitCode })), requests: current.requests.length }
      await page.screenshot({ path: join(root, 'failure.png') }).catch(() => undefined)
    }
    throw error
  } finally {
    await app?.close().catch(() => undefined)
    const frames = await wire()
    evidence.nativeTurnRequests = frames.filter(value => value.direction === 'request' && value.method === 'turn/start').length
    evidence.nativeTurnAcceptances = frames.filter(value => value.direction === 'response' && value.method === 'turn/start' && value.accepted).length
    evidence.steerRequests = frames.filter(value => value.direction === 'request' && value.method === 'turn/steer').length
    evidence.finishedAt = new Date().toISOString()
    await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2))
    console.log(`Native Phase 2 synthetic artifacts retained: ${root}`)
  }
})
