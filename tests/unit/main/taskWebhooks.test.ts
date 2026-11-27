// @vitest-environment node
// ADR-0218: the webhook listener takes a signed JSON object on loopback for a task whose webhook is on. Unsigned, stale,
// forged, oversized, browser-sent and too-frequent requests start nothing, and the body reaches the task only as data.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { WEBHOOK_TASK_LIMIT, WebhookListener, webhookSignature, type WebhookHandler } from '../../../src/main/automation/taskWebhooks'
import { WEBHOOK_BODY_BYTES_MAX, webhookPath } from '../../../src/shared/scheduledTasks'

const listeners: WebhookListener[] = []
afterEach(async () => { for (const listener of listeners.splice(0)) await listener.close() })

const SECRET = 'synthetic-secret-for-tests-only'
async function listen(now = () => Date.now()) {
  const taskId = randomUUID()
  const delivered: { delivery: string; body: Record<string, unknown> }[] = []
  const handler: WebhookHandler = {
    secretFor: id => id === taskId ? SECRET : undefined,
    deliver: async (_id, delivery, body) => {
      const duplicate = delivered.some(item => item.delivery === delivery)
      if (!duplicate) delivered.push({ delivery, body })
      return duplicate ? { status: 200, duplicate: true, run: 'r' } : { status: 202, run: 'r' }
    },
  }
  const listener = new WebhookListener({ handler, now })
  listeners.push(listener)
  await listener.start()
  const post = async (body: string, options: { delivery?: string; timestamp?: number; secret?: string; headers?: Record<string, string>; task?: string } = {}) => {
    const timestamp = String(options.timestamp ?? Math.floor(now() / 1000))
    const delivery = options.delivery ?? `delivery-${randomUUID()}`
    const response = await fetch(`${listener.address}${webhookPath(options.task ?? taskId)}`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-sotto-timestamp': timestamp, 'x-sotto-delivery': delivery,
        'x-sotto-signature': webhookSignature(options.secret ?? SECRET, timestamp, delivery, body), ...options.headers },
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  return { listener, taskId, delivered, post }
}

describe('the webhook listener', () => {
  it('closes a listener even if it is still binding', async () => {
    const listener = new WebhookListener({ handler: { secretFor: () => undefined, deliver: async () => ({ status: 404 }) } })
    listeners.push(listener)
    await Promise.all([listener.start(), listener.close()])
    expect(listener.listening).toBe(false)
    expect(listener.address).toBeUndefined()
  })

  it('listens on loopback only and hands a signed object to its task once per delivery ID', async () => {
    const hook = await listen()
    expect(hook.listener.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    const delivery = 'delivery-0001'
    expect(await hook.post('{"title":"Synthetic"}', { delivery })).toEqual({ status: 202, body: { run: 'r' } })
    expect(await hook.post('{"title":"Synthetic"}', { delivery })).toEqual({ status: 200, body: { run: 'r', duplicate: true } })
    expect(hook.delivered).toEqual([{ delivery, body: { title: 'Synthetic' } }])
  })

  it('refuses a forged or missing signature, a stale timestamp, an unknown task and a web page', async () => {
    const hook = await listen()
    expect((await hook.post('{}', { secret: 'wrong-secret' })).status).toBe(401)
    expect((await hook.post('{}', { timestamp: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401)
    expect((await hook.post('{}', { task: randomUUID() })).status).toBe(404)
    expect((await hook.post('{}', { headers: { origin: 'https://example.invalid' } })).status).toBe(403)
    const unsigned = await fetch(`${hook.listener.address}${webhookPath(hook.taskId)}`, { method: 'POST', body: '{}' })
    expect(unsigned.status).toBe(401)
    expect((await fetch(`${hook.listener.address}/v1/anything`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect(hook.delivered).toEqual([])
  })

  it('refuses a body that is not one JSON object, or longer than 64 KB', async () => {
    const hook = await listen()
    expect((await hook.post('[1,2]')).status).toBe(400)
    expect((await hook.post('not json')).status).toBe(400)
    expect((await hook.post(JSON.stringify({ text: 'x'.repeat(WEBHOOK_BODY_BYTES_MAX) }))).status).toBe(413)
    expect(hook.delivered).toEqual([])
  })

  it('counts a task\'s requests a minute and answers Too many past its limit', async () => {
    const hook = await listen()
    for (let index = 0; index < WEBHOOK_TASK_LIMIT; index++) expect((await hook.post('{}')).status).toBe(202)
    const refused = await hook.post('{}')
    expect(refused.status).toBe(429)
    expect(hook.delivered).toHaveLength(WEBHOOK_TASK_LIMIT)
  })
})
