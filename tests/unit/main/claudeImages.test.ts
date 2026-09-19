// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AGENT_MAX_IMAGE_BYTES, attachmentSizeBytes, type AgentAttachment } from '../../../src/shared/agents'
import { claudeFixture } from '../../fixtures/claudeFixture'

const fixtures: Awaited<ReturnType<typeof claudeFixture>>[] = []
const image: AgentAttachment = { id: 'shot', name: 'Screenshot.png', mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=' }
const reference = (attachment: AgentAttachment) => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachmentSizeBytes(attachment.dataUrl) })

afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })
async function fixture(models?: unknown[], requestTimeoutMs = 2000) {
  const f = await claudeFixture(undefined, requestTimeoutMs); fixtures.push(f)
  if (models) await writeFile(join(f.root, 'models.json'), JSON.stringify(models))
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Images', path: f.root })
  return f
}
async function restart(f: Awaited<ReturnType<typeof claudeFixture>>, requestTimeoutMs = 2000) {
  f.host.disconnect(); await f.adapter.closed()
  const restarted = await claudeFixture(f.root, requestTimeoutMs)
  fixtures.splice(fixtures.indexOf(f), 1, restarted)
  await restarted.host.connect()
  return restarted
}
async function createThread(f: Awaited<ReturnType<typeof claudeFixture>>, id: string, modelId = f.modelId) {
  expect(await f.host.execute({ type: 'create-thread', commandId: `create-${id}`, threadId: id, projectId: f.projectId, title: 'Images', modelId })).toEqual({ accepted: true })
  f.host.observeThreads?.([id])
}

it('enables images for every Claude catalog entry and sends image-only prompts without empty text blocks', async () => {
  const models = [
    { value: 'default', displayName: 'Default' },
    { value: 'sonnet', displayName: 'Sonnet' },
    { value: 'opus', displayName: 'Opus' },
    { value: 'haiku', displayName: 'Haiku' },
    { value: 'future-claude-model', displayName: 'Future model' },
  ]
  const f = await fixture(models)
  expect((await f.host.snapshot()).models.map(model => [model.id, model.supportsImages])).toEqual(models.map(model => [model.value, true]))
  for (const model of models) {
    await createThread(f, model.value, model.value)
    expect(await f.host.execute({ type: 'send', commandId: `send-${model.value}`, messageId: `message-${model.value}`, threadId: model.value, text: '', attachments: [image] })).toEqual({ accepted: true })
  }
  const sends = (await f.driver.requests()).filter(record => record.method === 'user')
  expect(sends).toHaveLength(models.length)
  for (const send of sends) expect(send.params?.frame).toMatchObject({ message: { content: [
    { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.dataUrl.split(',')[1] } },
  ] } })
})

it('keeps image-only and captioned receipts after reconnect without replaying image bytes', async () => {
  const f = await fixture()
  await createThread(f, 'thread')
  const first = { type: 'send' as const, commandId: 'first', messageId: 'first-message', threadId: 'thread', text: '', attachments: [image] }
  expect(await f.host.execute(first)).toEqual({ accepted: true })
  await f.driver.completeTurn('thread', 'First screenshot')
  await expect.poll(async () => (await f.host.snapshot()).threads[0]?.status).toBe('idle')
  const second = { type: 'send' as const, commandId: 'second', messageId: 'second-message', threadId: 'thread', text: 'Compare these screenshots', attachments: [{ ...image, id: 'shot-2', name: 'Second.png' }] }
  expect(await f.host.execute(second)).toEqual({ accepted: true })
  const sends = (await f.driver.requests()).filter(record => record.method === 'user')
  expect(sends[1]?.params?.frame).toMatchObject({ message: { content: [
    { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.dataUrl.split(',')[1] } },
    { type: 'text', text: second.text },
  ] } })
  const restarted = await restart(f)
  const restored = await restarted.adapter.refreshThread('thread')
  expect(restored.threads[0]?.messages.filter(message => message.role === 'user')).toEqual([
    expect.objectContaining({ id: first.messageId, commandId: first.commandId, text: '', attachments: [reference(image)] }),
    expect.objectContaining({ id: second.messageId, commandId: second.commandId, text: second.text, attachments: [reference(second.attachments[0]!)] }),
  ])
  expect(await restarted.host.execute(first)).toEqual({ accepted: true })
  expect((await restarted.driver.requests()).filter(record => record.method === 'user')).toHaveLength(2)
  const aliases = await readFile(join(f.root, 'claude-threads.json'), 'utf8')
  expect(aliases).not.toContain(image.dataUrl.split(',')[1])
  expect(aliases).not.toContain(second.text)
})

it('accepts the full 20 MiB image batch through native stdout and transcript catch-up', async () => {
  const f = await fixture(undefined, 15_000)
  await createThread(f, 'thread')
  const bytes = Buffer.alloc(AGENT_MAX_IMAGE_BYTES)
  Buffer.from(image.dataUrl.split(',')[1]!, 'base64').copy(bytes)
  const large = { ...image, dataUrl: 'data:image/png;base64,' + bytes.toString('base64') }
  const attachments = [large, { ...large, id: 'shot-2' }]
  expect(await f.host.execute({ type: 'send', commandId: 'large', messageId: 'large-message', threadId: 'thread', text: 'Large screenshots', attachments })).toEqual({ accepted: true })
  const restarted = await restart(f, 15_000)
  const restored = await restarted.adapter.refreshThread('thread')
  expect(restored.connected).toBe(true)
  expect(restored.threads[0]?.messages).toContainEqual(expect.objectContaining({ id: 'large-message', attachments: attachments.map(reference) }))
}, 60_000)
