/** Opt-in, bounded native capability evidence. Only synthetic folders and native owned sessions. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrokRpc, findGrokExecutable, grokEnvironment } from '../../src/main/agents/grokRpc'
import { discoverGrokSkills } from '../../src/main/agents/grokSkills'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'
import { homedir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'

async function claudeProbe() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-phase3-claude-'))
  const name = 'sotto-phase3-check'; const nonce = `EXPANDED_${randomUUID().replaceAll('-', '')}`
  const skillDirectory = join(root, '.claude', 'skills', name)
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(skillDirectory, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic native capability check.\ndisable-model-invocation: true\n---\nArguments: $ARGUMENTS\nIf arguments include no-tools, reply with exactly ${nonce} without tools. Otherwise call Bash once with exactly printf SOTTO_TOOL_OK, then reply with exactly ${nonce}. Do nothing else.\n`)
  let host = new ClaudeStreamJsonHost({ userDataPath: join(root, 'sotto'), requestTimeoutMs: 15000, pollIntervalMs: 100 })
  const threadId = randomUUID(); let submittedTurns = 0
  const until = async (check: () => Promise<boolean>) => { const deadline = Date.now() + 90000; while (!await check()) { if (Date.now() > deadline) throw new Error('Claude capability probe timed out'); await new Promise(resolve => setTimeout(resolve, 100)) } }
  try {
    const state = await host.connect(); if (!state.connected) throw new Error(state.error ?? 'Claude authentication unavailable')
    const model = state.models.find(model => model.id === 'haiku')?.id ?? 'default'
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'synthetic', title: 'Synthetic verification', path: root })
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: 'synthetic', modelId: model, title: 'Phase 3 native verification' })
    const catalog = await host.listThreadSkills(threadId)
    const selected = catalog.skills.find(skill => skill.name === name); if (!selected) throw new Error(`Synthetic Claude skill not advertised: ${catalog.error ?? catalog.status}`)
    for (const [index, text] of [`$${name}`, `/${name} no-tools`].entries()) {
      submittedTurns++
      console.log(JSON.stringify({ stage: 'claude-send', root, model, index, catalogSkill: selected }))
      const sent = await host.execute({ type: 'send', commandId: `probe-${index}`, messageId: `probe-${index}`, threadId, text, ...(index === 0 ? { skills: [{ name: selected.name, path: selected.path }] } : {}) })
      console.log(JSON.stringify({ stage: 'claude-delivery', sent }))
      await until(async () => {
        const thread = (await host.snapshot()).threads[0]!
        for (const request of thread.requests) {
          const allow = request.kind === 'permission' && request.context?.command === 'printf SOTTO_TOOL_OK'
          await host.execute({ type: 'answer', commandId: randomUUID(), threadId, requestId: request.id, answer: '', approved: allow })
        }
        return thread.status !== 'running'
      })
    }
    const before = (await host.snapshot()).threads[0]!
    host.disconnect(); await host.closed()
    host = new ClaudeStreamJsonHost({ userDataPath: join(root, 'sotto'), requestTimeoutMs: 15000, pollIntervalMs: 100 }); await host.connect()
    const after = (await host.snapshot()).threads[0]!
    const aliases = JSON.parse(await readFile(join(root, 'sotto', 'claude-threads.json'), 'utf8'))
    const sessionId = aliases[threadId].sessionId
    const log = await readFile(join(homedir(), '.claude', 'projects', root.replace(/[^a-zA-Z0-9]/gu, '-'), `${sessionId}.jsonl`), 'utf8')
    const calls = new Map<string, string>()
    for (const line of log.trim().split('\n')) { const frame = JSON.parse(line); if (frame.type === 'assistant' && frame.message?.id) calls.set(frame.message.id, frame.message.model) }
    const evidence = { root, model, submittedTurns, modelCalls: calls.size, actualModels: [...new Set(calls.values())], expandedAnswers: before.messages.filter(message => message.role === 'assistant' && message.text.includes(nonce)).length,
      activities: before.activities, afterActivities: after.activities, restoredActivities: isDeepStrictEqual(before.activities, after.activities), beforeMessages: before.messages, afterMessages: after.messages }
    await writeFile(join(root, 'native-evidence.json'), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify({ ...evidence, beforeMessages: undefined, afterMessages: undefined }))
  } finally { host.disconnect(); await host.closed() }
}

async function main() {
  if (process.env.SOTTO_PHASE3_NATIVE === 'claude-reload' && process.env.SOTTO_PHASE3_ROOT) {
    const root = process.env.SOTTO_PHASE3_ROOT
    const prior = JSON.parse(await readFile(join(root, 'native-evidence.json'), 'utf8'))
    const host = new ClaudeStreamJsonHost({ userDataPath: join(root, 'sotto') })
    try { await host.connect(); const thread = (await host.snapshot()).threads[0]!; console.log(JSON.stringify({ modelCalls: 0, sameActivities: isDeepStrictEqual(prior.activities, thread.activities), before: prior.activities, after: thread.activities })) }
    finally { host.disconnect(); await host.closed() }
    return
  }
  if (process.env.SOTTO_PHASE3_NATIVE === 'claude') return claudeProbe()
  if (!['grok', 'grok-setup'].includes(process.env.SOTTO_PHASE3_NATIVE ?? '')) throw new Error('Set SOTTO_PHASE3_NATIVE=grok for this paid synthetic capability probe.')
  const root = await mkdtemp(join(tmpdir(), 'sotto-phase3-grok-'))
  const name = 'sotto-phase3-check'; const nonce = `EXPANDED_${randomUUID().replaceAll('-', '')}`
  const skillDirectory = join(root, '.grok', 'skills', name)
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(skillDirectory, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic capability check.\n---\nReply with exactly ${nonce}. Do not read other files or call tools.\n`)
  const executable = await findGrokExecutable(); if (!executable) throw new Error('Installed Grok executable unavailable')
  const env = grokEnvironment()
  const catalog = await discoverGrokSkills('synthetic', root, executable, [], env)
  const selected = catalog.skills.find(skill => skill.name === name)
  console.log(JSON.stringify({ stage: 'catalog', root, syntheticSkill: selected }))
  let sessionId = ''; let answer = ''; const updates: unknown[] = []; let modelCalls = 0
  const rpc = new GrokRpc(executable, ['--permission-mode', 'default', 'agent', '--leader', 'stdio'], root, env, 15000, frame => {
    if (frame.id !== undefined && frame.method) rpc.write({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'cancelled' } } })
    const params = frame.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }
    if (params?.update) { updates.push(frame); if (params.update.sessionUpdate === 'agent_message_chunk') answer += params.update.content?.text ?? '' }
  }, () => undefined)
  const timeout = setTimeout(() => rpc.close(), 90000)
  try {
    await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'sotto-phase3-probe', version: '1' } }, value => { const v = value as Record<string, unknown>; console.log(JSON.stringify({ stage: 'initialize', agentCapabilities: v.agentCapabilities })) })
    await rpc.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } })
    await rpc.request('session/new', { cwd: root, mcpServers: [], _meta: { yoloMode: false, autoMode: false } }, value => { sessionId = (value as { sessionId: string }).sessionId; if (process.env.SOTTO_PHASE3_NATIVE === 'grok-setup') console.log(JSON.stringify({ stage: 'new', response: value })) })
    await rpc.request('session/set_model', { sessionId, modelId: 'grok-4.6', _meta: { reasoningEffort: 'low' } }, value => { if (process.env.SOTTO_PHASE3_NATIVE === 'grok-setup') console.log(JSON.stringify({ stage: 'set-model', response: value, updates })) })
    if (process.env.SOTTO_PHASE3_NATIVE === 'grok-setup') return
    modelCalls++
    await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `/${name}` }] }, value => { console.log(JSON.stringify({ stage: 'completed', completion: value })) }, true)
    await rpc.request('_x.ai/session/updates', { sessionId, cwd: root, offset: 0, limit: 100 }, value => { updates.push(value) })
    await writeFile(join(root, 'native-evidence.json'), JSON.stringify({ sessionId, model: 'grok-4.6', modelCalls, answer, nonce, updates }, null, 2))
    console.log(JSON.stringify({ stage: 'result', root, model: 'grok-4.6', modelCalls, expanded: answer.includes(nonce), answer: answer.slice(0, 500) }))
  } finally { clearTimeout(timeout); rpc.close(); await rpc.closed }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
