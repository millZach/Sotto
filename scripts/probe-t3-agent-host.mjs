import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
/* global process, console, setTimeout, fetch */

// This live check creates an owned project/thread in the existing T3 instance.
// --with-prompts additionally uses its ready Claude subscription for two tiny
// turns. It never reads unrelated thread content or changes provider settings.
const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const smokeRoot = join(root, 'artifacts', 'agent-control-smoke')
const runId = `Sotto integration ${new Date().toISOString().replace(/[:.]/gu, '-')}`
const projectPath = resolve(smokeRoot, runId)
if (!projectPath.startsWith(smokeRoot + sep)) throw new Error('Smoke directory escaped its owned root.')
await mkdir(projectPath, { recursive: true })
const bundlePath = join(tmpdir(), `sotto-t3-host-${randomUUID()}.cjs`)
await build({ entryPoints: [join(root, 'src/main/agents/t3.ts')], outfile: bundlePath, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
const { T3CodeHost } = await import(pathToFileURL(bundlePath).href)
const label = `Sotto live proof ${randomUUID()}`
const endpoint = process.env.SOTTO_T3_ENDPOINT ?? 'http://127.0.0.1:3773'
const projectId = randomUUID()
const threadId = randomUUID()
const ownMessageId = randomUUID()
const externalMessageId = randomUUID()
let credential = ''
const host = new T3CodeHost({ clientLabel: label, onCredential: value => { credential = value } })
const report = {
  runAt: new Date().toISOString(), projectPath, projectId, threadId, version: '',
  authenticated: false, providerDiscovery: false, folderExists: true, projectVisibleInSharedState: false,
  threadVisibleInSharedState: false, sameCommandReplayDoesNotDuplicate: false, reconnect: false,
  ownPromptAccepted: false, ownPromptCompleted: false, externalMessageDetected: false,
  questionReceived: false, questionAnswered: false, changedThreadGuard: false, nativeWindowVisuallyInspected: false,
  testSessionRevoked: false, limitations: [],
}

async function until(check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await host.snapshot()
    if (check(snapshot)) return snapshot
    await new Promise(resolve => setTimeout(resolve, 750))
  }
  throw new Error('The live T3 check did not reach the expected state in time.')
}

async function revokeOwnedSession() {
  if (process.platform !== 'win32') return
  const install = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 't3code')
  const executable = join(install, 'T3 Code (Alpha).exe')
  const bin = join(install, 'resources', 'server.asar', 'apps', 'server', 'dist', 'bin.mjs')
  const options = { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30_000 }
  const result = await execFileAsync(executable, [bin, 'auth', 'session', 'list', '--base-dir', join(homedir(), '.t3'), '--json'], options)
  const sessions = JSON.parse(result.stdout).filter(session => session.client?.label === label)
  for (const session of sessions) await execFileAsync(executable, [bin, 'auth', 'session', 'revoke', session.sessionId, '--base-dir', join(homedir(), '.t3')], options)
  report.testSessionRevoked = true
}

try {
  const initial = await host.connect({ endpoint, credential: '' })
  report.version = initial.version
  report.authenticated = initial.connected
  report.providerDiscovery = initial.models.length > 0
  const model = initial.models.find(model => model.ready && /claude/iu.test(model.provider) && /haiku/iu.test(model.name)) ??
    initial.models.find(model => model.ready && /claude/iu.test(model.provider))
  if (!model) throw new Error('This proof needs a ready Claude provider in the existing T3 environment.')
  const createProject = { type: 'create-project', commandId: randomUUID(), projectId, title: runId, path: projectPath }
  if (!(await host.execute(createProject)).accepted) throw new Error('T3 did not acknowledge the owned project.')
  report.projectVisibleInSharedState = (await until(snapshot => snapshot.projects.some(project => project.id === projectId))).projects.some(project => project.id === projectId)
  const createThread = { type: 'create-thread', commandId: randomUUID(), threadId, projectId, title: 'Sotto live compatibility check', modelId: model.id }
  if (!(await host.execute(createThread)).accepted) throw new Error('T3 did not acknowledge the owned thread.')
  host.observeThreads([threadId])
  await until(snapshot => snapshot.threads.some(thread => thread.id === threadId))
  report.threadVisibleInSharedState = true
  await host.execute(createThread)
  const replayed = await host.snapshot()
  report.sameCommandReplayDoesNotDuplicate = replayed.threads.filter(thread => thread.id === threadId).length === 1
  host.disconnect()
  await rm(bundlePath, { force: true })
  const reconnected = await host.connect({ endpoint, credential })
  report.reconnect = reconnected.projects.some(project => project.id === projectId) && reconnected.threads.some(thread => thread.id === threadId)
  console.log(JSON.stringify({ stage: 'shared-state', ...report }))

  if (process.argv.includes('--with-prompts')) {
    const submitted = await host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: ownMessageId,
      text: 'Reply exactly Sotto integration verified. Do not use tools or modify files.' })
    report.ownPromptAccepted = submitted.accepted
    const completed = await until(snapshot => {
      const thread = snapshot.threads.find(thread => thread.id === threadId)
      return thread?.status === 'idle' && thread.messages.some(message => message.role === 'assistant' && message.text.includes('Sotto integration verified'))
    })
    report.ownPromptCompleted = true
    const ownThread = completed.threads.find(thread => thread.id === threadId)
    if (!ownThread?.messages.find(message => message.id === ownMessageId)?.commandId) throw new Error('Sotto origin correlation was not preserved.')

    // A direct host submission has a different message ID and never passes
    // through Sotto's origin ledger, as with a message sent in T3 itself.
    const response = await fetch(endpoint + '/api/orchestration/dispatch', {
      method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'thread.turn.start', commandId: randomUUID(), threadId,
        message: { messageId: externalMessageId, role: 'user', attachments: [],
          text: 'Use AskUserQuestion to ask exactly one question: May this harmless integration check finish? Offer Proceed and Cancel. Use no other tools and do not touch files. After the answer, reply exactly Sotto question verified.' },
        runtimeMode: 'approval-required', interactionMode: 'default', createdAt: new Date().toISOString() }),
    })
    if (!response.ok) throw new Error(`External host submission returned HTTP ${response.status}.`)
    const asked = await until(snapshot => {
      const thread = snapshot.threads.find(thread => thread.id === threadId)
      const external = thread?.messages.find(message => message.id === externalMessageId)
      if (external && !external.commandId) report.externalMessageDetected = true
      return thread?.requests.some(request => request.kind === 'question')
    })
    const request = asked.threads.find(thread => thread.id === threadId)?.requests.find(request => request.kind === 'question')
    report.questionReceived = Boolean(request)
    if (!request) throw new Error('The requested clarification was not exposed.')
    const answered = await host.execute({ type: 'answer', commandId: randomUUID(), threadId, requestId: request.id, answer: 'Proceed' })
    if (!answered.accepted) throw new Error('T3 did not acknowledge the question response.')
    await until(snapshot => {
      const thread = snapshot.threads.find(thread => thread.id === threadId)
      return thread?.status === 'idle' && thread.requests.length === 0 && thread.messages.some(message => message.role === 'assistant' && message.text.includes('Sotto question verified'))
    })
    report.questionAnswered = true
    try {
      await host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: randomUUID(),
        text: 'This stale automatic reply must never be submitted.', expectedLastUserMessageId: ownMessageId })
      throw new Error('T3 adapter did not reject an automatic reply after external control changed.')
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('The thread changed in T3')) throw error
      report.changedThreadGuard = true
    }
  } else report.limitations.push('Provider execution, questions, and direct submission origin were not run; enable --with-prompts only for an authorized existing subscription smoke check.')
  report.limitations.push('Native T3 window visual confirmation and physical microphone/speaker validation are separate checks.')
} catch (error) {
  report.limitations.push(error instanceof Error ? error.message : 'The live probe failed.')
  process.exitCode = 1
} finally {
  host.disconnect()
  try { await revokeOwnedSession() } catch { report.limitations.push('Test client session could not be revoked automatically; remove its Sotto live proof label in T3 client settings.') }
  await writeFile(join(projectPath, 'compatibility-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
