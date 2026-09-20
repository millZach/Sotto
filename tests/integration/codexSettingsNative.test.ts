// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'

// No turn is sent: native thread creation and settings changes alone cost no model tokens.
it.skipIf(process.env.SOTTO_CODEX_SETTINGS_LIVE !== '1').each(['approval-required', 'auto'] as const)('changes a native Codex thread from high to ultra without disconnecting (%s)', async runtimeMode => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-settings-probe-'))
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-settings-probe-')) throw new Error('Unexpected probe directory')
  const host = new CodexAppServerHost({ userDataPath: directory })
  try {
    const snapshot = await host.connect()
    const model = snapshot.models.find(model => model.id === 'gpt-6-astra' && model.reasoningEfforts?.includes('ultra') && model.reasoningEfforts.includes('high'))
    expect(model, 'Installed catalog must offer high and ultra').toBeDefined()
    const threadId = randomUUID()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'probe', title: 'Settings probe', path: directory })
    expect(await host.execute({ type: 'create-thread', commandId: randomUUID(), projectId: 'probe', threadId, title: 'Synthetic settings verification', modelId: model!.id, reasoningEffort: 'high', runtimeMode })).toEqual({ accepted: true })
    for (const reasoningEffort of ['ultra', 'high', 'ultra']) {
      expect(await host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId, reasoningEffort })).toEqual({ accepted: true })
      const changed = await host.snapshot()
      expect(changed.connected).toBe(true)
      expect(changed.threads.find(thread => thread.id === threadId)).toMatchObject({ reasoningEffort, runtimeMode })
    }
  } finally {
    host.disconnect(); await host.closed()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
