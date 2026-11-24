// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UsageService } from '../../../src/main/agents/usageService'
import { UsageStore } from '../../../src/main/agents/usageStore'
import type { AgentHost } from '../../../src/main/agents/host'
import type { UsageLocalQuery, UsageLocalRead } from '../../../src/shared/usageDashboard'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

function stubHost(): AgentHost {
  return {
    subscribe: () => () => undefined,
  } as unknown as AgentHost
}

describe('UsageService query accelerator (ADR-0215)', () => {
  it('flushes buffered writes before calling the accelerator and falls back cleanly when it returns undefined or throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sotto-usage-accel-'))
    tempDirs.push(dir)

    const store = new UsageStore(join(dir, 'usage.sqlite'))
    const service = new UsageService({ directory: dir, host: stubHost(), store })
    service.start()

    try {
      service.submitPrompt({
        providerId: 'codex',
        threadId: 'thread-1',
        messageId: 'msg-1',
        modelId: 'gpt-5',
        at: '2026-11-23T10:00:00.000Z',
        kind: 'user',
        inputKind: 'send',
      })
      service.acceptPrompt('thread-1', 'msg-1')

      let acceleratedCalls = 0
      let observedRevisionDuringAccel = -1
      service.useQueryAccelerator(async (query: UsageLocalQuery): Promise<UsageLocalRead | undefined> => {
        acceleratedCalls++
        // Verify pending writes were flushed to the store before the accelerator ran.
        const fresh = new UsageStore(join(dir, 'usage.sqlite'))
        fresh.open()
        try {
          const direct = fresh.query(query)
          observedRevisionDuringAccel = direct.metadata.revision
          return direct
        } finally {
          fresh.close()
        }
      })

      const accelerated = await service.read({ timeZone: 'UTC' })
      expect(acceleratedCalls).toBe(1)
      expect(observedRevisionDuringAccel).toBeGreaterThan(0)
      expect(accelerated.status).toBe('ready')
      expect(accelerated.activity?.totals.prompts.user).toBe(1)

      // Returning undefined transparently falls back to the TS UsageStore.
      service.useQueryAccelerator(async () => undefined)
      const fallbackUndefined = await service.read({ timeZone: 'UTC' })
      expect(fallbackUndefined.status).toBe('ready')
      expect(fallbackUndefined.activity?.totals.prompts.user).toBe(1)

      // Throwing transparently falls back to the TS UsageStore without marking persistence failed.
      service.useQueryAccelerator(async () => { throw new Error('rust-accelerator-timeout') })
      const fallbackThrow = await service.read({ timeZone: 'UTC' })
      expect(fallbackThrow.status).toBe('ready')
      expect(fallbackThrow.persistence).toBe('saved')
      expect(fallbackThrow.activity?.totals.prompts.user).toBe(1)
    } finally {
      service.close()
    }
  })
})
