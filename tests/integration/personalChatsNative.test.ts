// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import { PersonalChatService } from '../../src/main/agents/personalChats'

// Explicit opt-in. Exactly one synthetic turn in a newly owned session. Never
// reads arbitrary user conversations, changes accounts/config, or invokes tools.
it.runIf(process.env.SOTTO_NATIVE_PERSONAL_CHAT === '1')('starts one owned native conversation and resumes its same ID without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-personal-native-'))
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-personal-native-')) throw new Error('Unexpected native probe directory')
  const calls: { method: string; threadId?: unknown; ephemeral?: unknown; cwd?: unknown }[] = []
  let host = new CodexAppServerHost({ userDataPath: root, requestTimeoutMs: 15000 })
  const instrument = (adapter: CodexAppServerHost) => {
    const seam = adapter as unknown as { rpc: (method: string, params: Record<string, unknown>, ...rest: unknown[]) => Promise<void> }
    const rpc = seam.rpc.bind(adapter)
    seam.rpc = (method, params, ...rest) => { calls.push({ method, ...(params.threadId ? { threadId: params.threadId } : {}), ...(params.cwd ? { cwd: params.cwd } : {}), ...(params.ephemeral !== undefined ? { ephemeral: params.ephemeral } : {}) }); return rpc(method, params, ...rest) }
  }
  instrument(host)
  const configuration = () => ({ reasoning: 'codex', reasoningModel: 'gpt-6-astra', reasoningEffort: 'high' })
  let service = new PersonalChatService({ userDataPath: root, host, configuration })
  const steps: { name: string; startedAt: string; elapsedMs?: number; failure?: string }[] = []
  const evidence: Record<string, unknown> = { checkedAt: new Date().toISOString(), root, steps, calls, model: 'gpt-6-astra', reasoningEffort: 'high' }
  const saveEvidence = async () => {
    await mkdir('artifacts/personal-chat-native', { recursive: true })
    await writeFile('artifacts/personal-chat-native/evidence.json', JSON.stringify(evidence, null, 2))
  }
  // Persist the last awaited operation before entering it, including cleanup: an overall test
  // timeout must not discard the only clue or strand evidence behind the same shutdown barrier.
  const step = async <T>(name: string, action: () => Promise<T>, timeoutMs = 30000): Promise<T> => {
    const record: typeof steps[number] = { name, startedAt: new Date().toISOString() }
    steps.push(record); await saveEvidence()
    const started = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([action(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Native personal probe timed out during ${name}`)), timeoutMs)
      })])
    } catch (error) { record.failure = error instanceof Error ? error.message : String(error); throw error }
    finally { clearTimeout(timer); record.elapsedMs = Math.round(performance.now() - started); await saveEvidence() }
  }
  try {
    await step('start', () => service.start()); const connected = await step('connect', () => service.connect()); expect(connected.connected, connected.error).toBe(true)
    const snapshot = await step('snapshot', () => host.snapshot()); evidence.version = snapshot.version
    expect(snapshot.models.some(m => m.id === 'gpt-6-astra' && m.ready)).toBe(true)
    const chat = (await step('create local chat', () => service.create())).chats[0]!
    const skills = await step('skills', () => service.skills(chat.id, true))
    evidence.skills = { status: skills.status, count: skills.skills.length, scopes: [...new Set(skills.skills.map(s => s.scope))], errors: skills.errors.length }
    expect(skills.status).toBe('ready'); expect(skills.skills.some(s => s.scope === 'user')).toBe(true)
    await step('save draft', () => service.saveDraft({ chatId: chat.id, revision: 1, text: 'Synthetic persistence check. Reply exactly SOTTO_PERSONAL_OK. Do not call tools, read files, browse, delegate, or change anything.', skills: [] }))
    await step('send', () => service.send({ chatId: chat.id, revision: 1 })); await step('dispatch settled', () => service.settled())
    await step('wait for completion', async () => {
      const end = Date.now() + 45000
      while (Date.now() < end && service.get().chats[0]!.status === 'running') await new Promise(r => setTimeout(r, 250))
    }, 46000)
    await step('refresh completed turn', () => service.refresh(chat.id)); await step('refresh settled', () => service.settled())
    const before = service.get().chats[0]!
    const aliasBefore = JSON.parse(await readFile(join(root, 'codex-threads.json'), 'utf8'))[chat.id]
    evidence.nativeId = aliasBefore?.codexThreadId
    evidence.before = { nativeState: before.nativeState, status: before.status, submissions: before.submissions.map(s => ({ status: s.status, error: s.error })), messages: before.messages, activities: before.activities }
    expect(before.messages.some(m => m.role === 'assistant' && m.text.includes('SOTTO_PERSONAL_OK'))).toBe(true)
    await step('close first host', () => service.close())
    host = new CodexAppServerHost({ userDataPath: root }); instrument(host)
    service = new PersonalChatService({ userDataPath: root, host, configuration })
    await step('start restored service', () => service.start()); expect(service.get().chats[0]!.messages).toEqual(before.messages)
    await step('connect restored service', () => service.connect()); await step('refresh restored chat', () => service.refresh(chat.id)); await step('restored settled', () => service.settled())
    const aliasAfter = JSON.parse(await readFile(join(root, 'codex-threads.json'), 'utf8'))[chat.id]
    expect(aliasAfter.codexThreadId).toBe(aliasBefore.codexThreadId)
    expect(service.get().chats[0]!.messages.map(m => [m.id, m.commandId, m.text])).toEqual(before.messages.map(m => [m.id, m.commandId, m.text]))
    expect(calls.filter(c => c.method === 'thread/start')).toHaveLength(1)
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(1)
    evidence.resumedSameId = true; evidence.noReplay = true
  } catch (error) { evidence.failure = error instanceof Error ? error.message : String(error); throw error }
  finally {
    await saveEvidence()
    try { await step('final close', () => service.close(), 10000) }
    catch (error) { evidence.cleanupFailure = error instanceof Error ? error.message : String(error); await saveEvidence() }
    if (!evidence.failure && !evidence.cleanupFailure) await rm(root, { recursive: true, force: true })
  }
  if (evidence.cleanupFailure) throw new Error(String(evidence.cleanupFailure))
}, 120000)
