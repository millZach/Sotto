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
  const evidence: Record<string, unknown> = { checkedAt: new Date().toISOString(), calls, model: 'gpt-6-astra', reasoningEffort: 'high' }
  try {
    await service.start(); const connected = await service.connect(); expect(connected.connected, connected.error).toBe(true)
    const snapshot = await host.snapshot(); evidence.version = snapshot.version
    expect(snapshot.models.some(m => m.id === 'gpt-6-astra' && m.ready)).toBe(true)
    const chat = (await service.create()).chats[0]!
    const skills = await service.skills(chat.id, true)
    evidence.skills = { status: skills.status, count: skills.skills.length, scopes: [...new Set(skills.skills.map(s => s.scope))], errors: skills.errors.length }
    expect(skills.status).toBe('ready'); expect(skills.skills.some(s => s.scope === 'user')).toBe(true)
    await service.saveDraft({ chatId: chat.id, revision: 1, text: 'Synthetic persistence check. Reply exactly SOTTO_PERSONAL_OK. Do not call tools, read files, browse, delegate, or change anything.', skills: [] })
    await service.send({ chatId: chat.id, revision: 1 }); await service.settled()
    const end = Date.now() + 45000
    while (Date.now() < end && service.get().chats[0]!.status === 'running') await new Promise(r => setTimeout(r, 250))
    await service.refresh(chat.id); await service.settled()
    const before = service.get().chats[0]!
    const aliasBefore = JSON.parse(await readFile(join(root, 'codex-threads.json'), 'utf8'))[chat.id]
    evidence.nativeId = aliasBefore?.codexThreadId
    evidence.before = { nativeState: before.nativeState, status: before.status, submissions: before.submissions.map(s => ({ status: s.status, error: s.error })), messages: before.messages, activities: before.activities }
    expect(before.messages.some(m => m.role === 'assistant' && m.text.includes('SOTTO_PERSONAL_OK'))).toBe(true)
    await service.close()
    host = new CodexAppServerHost({ userDataPath: root }); instrument(host)
    service = new PersonalChatService({ userDataPath: root, host, configuration })
    await service.start(); expect(service.get().chats[0]!.messages).toEqual(before.messages)
    await service.connect(); await service.refresh(chat.id); await service.settled()
    const aliasAfter = JSON.parse(await readFile(join(root, 'codex-threads.json'), 'utf8'))[chat.id]
    expect(aliasAfter.codexThreadId).toBe(aliasBefore.codexThreadId)
    expect(service.get().chats[0]!.messages.map(m => [m.id, m.commandId, m.text])).toEqual(before.messages.map(m => [m.id, m.commandId, m.text]))
    expect(calls.filter(c => c.method === 'thread/start')).toHaveLength(1)
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(1)
    evidence.resumedSameId = true; evidence.noReplay = true
  } catch (error) { evidence.failure = error instanceof Error ? error.message : String(error); throw error }
  finally {
    await service.close()
    await mkdir('artifacts/personal-chat-native', { recursive: true }); await writeFile('artifacts/personal-chat-native/evidence.json', JSON.stringify(evidence, null, 2))
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
