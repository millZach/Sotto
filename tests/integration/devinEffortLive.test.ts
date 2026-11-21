// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DevinAcpHost } from '../../src/main/agents/devin'
import { DevinRpc, devinEnvironment, findDevinExecutable } from '../../src/main/agents/devinRpc'
import { devinPolicyPath } from '../../src/main/agents/devinPolicy'
import { thinkingConfig } from '../../src/main/agents/devinThinking'

/**
 * Against the installed Devin CLI: the levels of every model are read after connecting, a thread starts on the level
 * chosen for it, a started thread changes level in place, and Devin's own session holds the level Sotto set. Two short
 * turns on SWE-2, which Devin lists as free.
 */
describe('requires SOTTO_DEVIN_LIVE=1', () => {
  it.skipIf(process.env['SOTTO_DEVIN_LIVE'] !== '1')('reads Devin\'s thinking levels and runs a thread at the chosen one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-devin-effort-live-'))
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-devin-effort-live-')) throw new Error('Unexpected temporary directory')
    const cwd = join(root, 'project'); const data = join(root, 'sotto')
    await mkdir(cwd); await mkdir(data)
    execFileSync('git', ['init', '--quiet', cwd], { windowsHide: true, stdio: 'ignore' })
    let host = new DevinAcpHost(data)
    const id = randomUUID()
    const thread = async () => (await host.snapshot()).threads.find(entry => entry.id === id)!
    const send = (text: string) => host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text })
    try {
      const started = performance.now()
      const connected = await host.connect()
      console.info('devin-effort-live', { stage: 'connected', ms: Math.round(performance.now() - started), models: connected.models.length,
        readAtConnect: connected.models.filter(model => model.reasoningEfforts !== undefined).length })
      // Every model is read in the background; the saved file names them all.
      await expect.poll(async () => (await host.snapshot()).models.every(model => model.reasoningEfforts !== undefined), { timeout: 240_000, interval: 1_000 }).toBe(true)
      console.info('devin-effort-live', { stage: 'all-read', ms: Math.round(performance.now() - started) })
      const models = (await host.snapshot()).models
      const swe = models.find(model => model.id.startsWith('swe-2-') && model.name === 'SWE-2')!
      expect(swe).toMatchObject({ reasoningEfforts: ['medium', 'high', 'max'] })
      expect(models.find(model => model.id === 'claude-opus-4-6')).toMatchObject({ reasoningEfforts: [], noReasoningEfforts: true })
      expect(models.find(model => model.name === 'Claude Opus 5.5')).toMatchObject({ reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] })
      console.info('devin-effort-live', { stage: 'levels', withLevels: models.filter(model => model.reasoningEfforts?.length).length,
        without: models.filter(model => model.noReasoningEfforts).map(model => model.id) })
      const saved = async (): Promise<number> => Object.keys((JSON.parse(await readFile(join(data, 'devin', 'thinking-levels.json'), 'utf8')) as { models: Record<string, unknown> }).models).length
      await expect.poll(saved).toBe(models.length)

      // A thread on SWE-2 at Max, which is not its default (High).
      await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'live', title: 'Synthetic effort check', path: cwd })
      await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'live', title: 'Synthetic effort check', modelId: swe.id, reasoningEffort: 'max' })
      host.observeThreads([id])
      expect(await thread()).toMatchObject({ reasoningEffort: 'max' })
      expect(await send('Reply with the single word OK. Do not use any tools.')).toEqual({ accepted: true })
      await expect.poll(async () => (await thread()).status, { timeout: 120_000 }).toBe('idle')
      expect((await thread()).messages.some(message => message.role === 'assistant')).toBe(true)

      // Changed in place on the started thread, then a second turn.
      const changed = await host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, reasoningEffort: 'medium' })
      expect(changed.accepted).toBe(true)
      expect(await thread()).toMatchObject({ reasoningEffort: 'medium' })
      expect(await send('Reply with the single word OK again. Do not use any tools.')).toEqual({ accepted: true })
      await expect.poll(async () => (await thread()).status, { timeout: 120_000 }).toBe('idle')

      // Devin's own record of the session: loaded by a client of its own once Sotto lets it go, it reports Medium.
      const sessionId = JSON.parse(await readFile(join(data, 'devin-threads.json'), 'utf8'))[id].devinSessionId as string
      host.disconnect(); await host.closed()
      const executable = (await findDevinExecutable())!
      let loaded: { current: string } | undefined
      const reader = new DevinRpc(executable, ['--config', devinPolicyPath(data, 'nothing'), 'acp'], cwd, devinEnvironment(), 30_000, () => undefined, () => undefined)
      try {
        await reader.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
        await reader.request('session/load', { sessionId, cwd, mcpServers: [] }, value => { loaded = thinkingConfig(value) })
      } finally { reader.close(); await reader.closed }
      console.info('devin-effort-live', { stage: 'devin-session', thinking: loaded?.current })
      expect(loaded?.current).toBe('medium')

      // Reopened by Sotto on another connect, the saved levels are there at once and the thread keeps its level.
      host = new DevinAcpHost(data)
      const again = await host.connect()
      expect(again.models.find(model => model.id === swe.id)).toMatchObject({ reasoningEfforts: ['medium', 'high', 'max'] })
      expect(await thread()).toMatchObject({ reasoningEffort: 'medium' })
    } finally {
      host.disconnect(); await host.closed()
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }, 600_000)
})
