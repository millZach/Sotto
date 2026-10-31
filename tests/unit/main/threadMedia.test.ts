// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../../src/main/agents/claudeActivity'
import { CodexActivityProjection, codexItemSchema } from '../../../src/main/agents/codexActivity'
import { picturesIn, ThreadMediaStore } from '../../../src/main/agents/threadMedia'
import { agentActivitySignature } from '../../../src/shared/agentThreadDetail'
import { activitySummary } from '../../../src/shared/hostProtocol'
import { imageDimensions } from '../../../src/shared/imageDimensions'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentThread } from '../../../src/shared/agents'

/** A real 3x2 PNG: the signature, then IHDR. Only the header is read for its size. */
function png(width = 3, height = 2, salt = 0): Buffer {
  const bytes = Buffer.alloc(40)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  bytes[39] = salt
  return bytes
}
const b64 = (bytes: Buffer): string => bytes.toString('base64')

const folders: string[] = []
async function folder(): Promise<string> { const made = await mkdtemp(join(tmpdir(), 'sotto-thread-media-')); folders.push(made); return made }
afterEach(async () => { await Promise.all(folders.splice(0).map(made => rm(made, { recursive: true, force: true }))) })

describe('pictures in a tool result', () => {
  it('reads the MCP, ACP, Messages API and Codex data URL shapes, and nothing else', () => {
    const data = b64(png())
    expect(picturesIn([
      { type: 'text', text: '[Image: source: /tmp/x.png]' },
      { type: 'image', data, mimeType: 'image/png' },
      { type: 'content', content: { type: 'image', data, mimeType: 'image/jpeg' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'inputImage', imageUrl: `data:image/gif;base64,${data}` },
      { type: 'inputImage', imageUrl: 'https://example.com/b.png' },
    ]).map(picture => picture.mimeType)).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    expect(picturesIn('just words')).toEqual([])
    expect(picturesIn(Array.from({ length: 12 }, () => ({ type: 'image', data, mimeType: 'image/png' })))).toHaveLength(8)
  })
})

describe('a picture\'s size from its header', () => {
  it('reads PNG, GIF, JPEG and WebP, and nothing it does not know', () => {
    expect(imageDimensions(png(1280, 800))).toEqual({ width: 1280, height: 800 })
    const gif = Buffer.from('GIF89a\x10\x00\x20\x00', 'latin1')
    expect(imageDimensions(gif)).toEqual({ width: 16, height: 32 })
    // A JPEG with an APP0 segment ahead of its SOF0: 640 wide, 480 high.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0])
    expect(imageDimensions(jpeg)).toEqual({ width: 640, height: 480 })
    const webp = Buffer.alloc(30); webp.write('RIFF', 0, 'ascii'); webp.write('WEBPVP8X', 8, 'ascii')
    webp.writeUIntLE(99, 24, 3); webp.writeUIntLE(49, 27, 3)
    expect(imageDimensions(webp)).toEqual({ width: 100, height: 50 })
    expect(imageDimensions(Buffer.from('not a picture'))).toBeUndefined()
  })
})

describe('the thread media store', () => {
  it('answers handles at once and keeps the bytes once, by digest', async () => {
    const directory = await folder()
    const store = new ThreadMediaStore(directory)
    await store.load()
    const [handle, again] = [store.capture([{ mimeType: 'image/png', data: b64(png()) }], 'tool'), store.capture([{ mimeType: 'image/png', data: b64(png()) }], 'tool')]
    expect(handle).toEqual([{ id: 'm0', digest: expect.stringMatching(/^[a-f0-9]{64}$/u), kind: 'image', mimeType: 'image/png', sizeBytes: 40, width: 3, height: 2, name: 'picture-1.png', source: 'tool' }])
    expect(again).toEqual(handle)
    await store.idle()
    expect((await readdir(join(directory, 'thread-media'))).filter(name => name.endsWith('.png'))).toHaveLength(1)
    const record = { media: handle } as AgentActivity
    expect(await store.read(record, 'm0')).toBe(`data:image/png;base64,${b64(png())}`)
    expect(await store.read(record, 'm1')).toBeNull()
    expect(await store.read(null, 'm0')).toBeNull()
  })

  it('refuses a picture that is not the type it claims, is not one of the four types, or is too large', async () => {
    const store = new ThreadMediaStore(await folder())
    await store.load()
    expect(store.capture([
      { mimeType: 'image/jpeg', data: b64(png()) },
      { mimeType: 'image/svg+xml', data: b64(Buffer.from('<svg/>')) },
      { mimeType: 'image/png', data: 'A'.repeat(14 * 1024 * 1024) },
    ], 'tool')).toEqual([])
  })

  it('keeps the newest pictures within its limit, and lets every one go when history is turned off', async () => {
    const directory = await folder()
    let now = 1
    const store = new ThreadMediaStore(directory, { now: () => now, keepBytes: 80 })
    await store.load()
    const first = store.capture([{ mimeType: 'image/png', data: b64(png(3, 2, 1)) }], 'tool'); now = 2
    const second = store.capture([{ mimeType: 'image/png', data: b64(png(3, 2, 2)) }], 'tool'); now = 3
    const third = store.capture([{ mimeType: 'image/png', data: b64(png(3, 2, 3)) }], 'tool')
    await store.idle(); await store.sweep()
    expect(await store.read({ media: first } as AgentActivity, 'm0')).toBeNull()
    expect(await store.read({ media: second } as AgentActivity, 'm0')).not.toBeNull()
    expect(await store.read({ media: third } as AgentActivity, 'm0')).not.toBeNull()
    // A restart reads what was kept.
    const reopened = new ThreadMediaStore(directory, { now: () => now, keepBytes: 80 })
    await reopened.load()
    expect(await reopened.read({ media: third } as AgentActivity, 'm0')).not.toBeNull()
    await reopened.clear()
    expect(await reopened.read({ media: third } as AgentActivity, 'm0')).toBeNull()
  })

  it('holds pictures in memory alone while history is off', async () => {
    const directory = await folder()
    const store = new ThreadMediaStore(directory, { historyEnabled: () => false })
    await store.load()
    const handle = store.capture([{ mimeType: 'image/png', data: b64(png()) }], 'tool')
    await store.idle()
    expect(await readdir(directory)).not.toContain('thread-media.json')
    expect(await store.read({ media: handle } as AgentActivity, 'm0')).not.toBeNull()
  })
})

describe('capture where the adapters read a tool result', () => {
  const picture = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(png()) } }
  const toolUse = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'shot', name: 'mcp__sotto_browser__screenshot', input: {} }] } }
  const toolResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shot', content: [{ type: 'text', text: 'Took a screenshot.' }, picture] }] } }

  it('puts Claude Code\'s tool result pictures on the row, and none without the feature', async () => {
    const store = new ThreadMediaStore(await folder())
    await store.load()
    const projector = new ClaudeActivity(undefined, store.capture)
    const rows = projector.apply(projector.apply([], toolUse, 'turn', undefined, '/repo', true), toolResult, 'turn', undefined, '/repo', true)
    const row = rows.find(record => record.id === 'claude-tool-shot')!
    expect(row.output).toBe('Took a screenshot.')
    expect(row.media).toEqual([expect.objectContaining({ id: 'm0', mimeType: 'image/png', width: 3, height: 2, source: 'tool' })])
    const off = new ClaudeActivity()
    expect(off.apply(off.apply([], toolUse, 'turn', undefined, '/repo', true), toolResult, 'turn', undefined, '/repo', true).find(record => record.id === 'claude-tool-shot')!.media).toBeUndefined()
  })

  it('keeps a row\'s pictures when the result is read again, without capturing again', async () => {
    const store = new ThreadMediaStore(await folder())
    await store.load()
    let captures = 0
    const projector = new ClaudeActivity(undefined, (pictures, source) => { captures += 1; return store.capture(pictures, source) })
    const once = projector.apply(projector.apply([], toolUse, 'turn', undefined, '/repo', true), toolResult, 'turn', undefined, '/repo', true)
    const twice = projector.apply(once, toolResult, 'turn', undefined, '/repo', true)
    expect(captures).toBe(1)
    expect(twice.find(record => record.id === 'claude-tool-shot')!.media).toEqual(once.find(record => record.id === 'claude-tool-shot')!.media)
  })

  it('puts a finished Codex MCP call\'s pictures on its row', async () => {
    const store = new ThreadMediaStore(await folder())
    await store.load()
    const thread: AgentThread = { id: 't', projectId: 'p', title: 'T', modelId: 'm', status: 'running', requests: [], messages: [] }
    const projection = new CodexActivityProjection(() => 1_000, store.capture)
    const item = { id: 'call', type: 'mcpToolCall', status: 'completed', server: 'sotto_browser', tool: 'screenshot', result: { content: [{ type: 'text', text: 'ok' }, { type: 'image', data: b64(png()), mimeType: 'image/png' }] } }
    projection.item(thread, codexItemSchema.parse(item), { turnId: 'turn', phase: 'completed' })
    expect(thread.activities?.[0]?.media).toEqual([expect.objectContaining({ id: 'm0', mimeType: 'image/png' })])
    // Running, it has no result to read.
    const running = new CodexActivityProjection(() => 1_000, store.capture)
    const other: AgentThread = { ...thread, activities: undefined }
    running.item(other, codexItemSchema.parse({ ...item, status: 'inProgress', result: null }), { turnId: 'turn', phase: 'started' })
    expect(other.activities?.[0]?.media).toBeUndefined()
  })
})

describe('a record\'s pictures on the detail stream and the phone', () => {
  const base: AgentActivity = { id: 'a', turnId: 't', sequence: 0, kind: 'tool', status: 'completed', title: 'Screenshot' }
  const media = [{ id: 'm0', digest: 'a'.repeat(64), kind: 'image' as const, mimeType: 'image/png' as const, sizeBytes: 40, name: 'picture-1.png', source: 'tool' as const }]
  it('changes the record\'s signature when it gains a picture', () => {
    expect(agentActivitySignature({ ...base, media })).not.toBe(agentActivitySignature(base))
  })
  it('keeps the handles, never bytes, in the summary the phone is sent', () => {
    expect(activitySummary({ ...base, output: 'words', media })).toEqual({ ...base, media })
  })
})
