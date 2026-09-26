// @vitest-environment node
/**
 * How long a send that carries an image waits before the provider hears it, with the attachment preview
 * store already holding some images. Drives the real coordinator and the real preview store on a
 * temporary folder; the provider is the in-process E2E host, so the numbers are Sotto's own work and
 * the disk, not a provider round trip. Timers only: nothing about the prompt or the image is recorded.
 * It asserts no time, so it runs only under `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/previewSend.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AttachmentPreviews } from '../../src/main/agents/attachmentPreviews'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import type { AgentHostCommand, AgentHostResult } from '../../src/main/agents/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import type { AgentAttachment } from '../../src/shared/agents'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'

const SENDS = 9
const MiB = 1024 * 1024

/** A PNG signature followed by padding: what the store validates, at the size a screenshot has. */
function png(bytes: number, id: string): AgentAttachment {
  const data = Buffer.alloc(bytes); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data)
  return { id, name: `${id}.png`, mimeType: 'image/png', dataUrl: `data:image/png;base64,${data.toString('base64')}` }
}

class TimedHost extends E2EAgentHost {
  heardAt = 0
  acknowledgedAt = 0
  sends = 0
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type === 'send') this.sends += 1
    this.heardAt = performance.now()
    const result = await super.execute(command)
    this.acknowledgedAt = performance.now()
    return result
  }
}

const roots: string[] = []
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

describe.skipIf(!PERF_BENCH)('send with an image', () => {
  it.each([0, 10, 50])('reports admission to provider acknowledgement with %i MiB of previews already stored', async stored => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-perf-preview-send-')); roots.push(root)
    // Earlier sends, dated now so retention keeps them, one 1 MiB screenshot each.
    const entries = Array.from({ length: stored }, (_, index) => ({ threadId: 'workshop', messageId: `earlier-${index}`,
      commandId: `earlier-${index}`, storedAt: Date.now() - 1000, attachments: [png(MiB, `earlier-${index}`)] }))
    await writeFile(join(root, 'attachment-previews.json'), JSON.stringify({ version: 1, entries }))
    const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
    await credentials.load()
    const host = new TimedHost()
    const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner,
      membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
    try {
      await control.start(); await control.command({ type: 'connect' })
      // Queued behind any preview write still running, so it resolves once the store is idle.
      const previews = (control as unknown as { attachmentPreviews: AttachmentPreviews }).attachmentPreviews
      const heard: number[] = []; const acknowledged: number[] = []; const completed: number[] = []; const saved: number[] = []
      for (let index = 0; index < SENDS; index++) {
        const admittedAt = performance.now()
        const result = await control.command({ type: 'manual-send', threadId: 'workshop', text: '', attachments: [png(MiB, `sent-${index}`)] })
        const doneAt = performance.now()
        // A person does not send the next screenshot while the last one is still being written; neither does this.
        await previews.maintain()
        const idleAt = performance.now()
        expect(result.error).toBeNull(); expect(host.sends).toBe(index + 1)
        heard.push(host.heardAt - admittedAt); acknowledged.push(host.acknowledgedAt - admittedAt)
        completed.push(doneAt - admittedAt); saved.push(idleAt - admittedAt)
        // The turn ends, so the next prompt is a send rather than a queued follow-up.
        host.event({ type: 'ready', threadId: 'workshop', text: 'Done.' })
      }
      console.info(`preview send: ${JSON.stringify({ storedMiB: stored, imageMiB: 1, sends: SENDS,
        medianMs: { providerHears: round(median(heard)), providerAcknowledges: round(median(acknowledged)), commandReturns: round(median(completed)), previewSaved: round(median(saved)) } })}`)
    } finally { control.dispose(); await control.privacyChanged() }
  }, 120_000)
})
