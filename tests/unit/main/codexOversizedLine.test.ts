// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { OversizedLine, PICTURE_CHARS } from '../../../src/main/agents/providers/codex/codexOversizedLine'
import { CodexProcess, Uncertain } from '../../../src/main/agents/providers/codex/codexProcess'

const picture = 'iVBORw0KGgo' + 'A'.repeat(PICTURE_CHARS * 2) + '=='
/** What `OversizedLine` keeps of `text` when it arrives in pieces `size` characters long. */
function kept(text: string, size: number): string {
  const line = new OversizedLine()
  for (let start = 0; start < text.length; start += size) line.push(text.slice(start, start + size))
  expect(line.bytes).toBe(Buffer.byteLength(line.line()))
  return line.line()
}

describe('a Codex line too long for one frame (#2268)', () => {
  it('keeps everything but the pictures, wherever the pieces split it', () => {
    const reply = JSON.stringify({ id: 7, result: { thread: { turns: [{ items: [
      { type: 'agentMessage', text: 'Said "this" \\ and that\n' + 'é'.repeat(PICTURE_CHARS) },
      { type: 'imageGeneration', result: picture, savedPath: '/tmp/frame.png' },
      { type: 'userMessage', content: [{ type: 'image', url: `data:image/png;base64,${picture}` }] },
      { type: 'commandExecution', aggregatedOutput: 'a line of output\n'.repeat(PICTURE_CHARS) },
    ] }] } } })
    const expected = JSON.parse(reply)
    expected.result.thread.turns[0].items[1].result = ''
    expected.result.thread.turns[0].items[2].content[0].url = ''
    for (const size of [1, 2, 3, 7, 4096, reply.length]) expect(JSON.parse(kept(reply, size))).toEqual(expected)
  })

  it('keeps a short picture and a string that only starts like one, however it is split', () => {
    const short = 'A'.repeat(PICTURE_CHARS)
    const mixed = 'A'.repeat(PICTURE_CHARS + 1000) + ' and then words'
    const reply = JSON.stringify({ id: 1, result: { short, mixed } })
    for (const size of [1000, 4096, reply.length]) expect(JSON.parse(kept(reply, size))).toEqual({ id: 1, result: { short, mixed } })
  })

  it('fails only the request a line still too long answered, whichever way round, and goes on reading the app-server', async () => {
    // An app-server that answers its first two requests with lines of words longer than the budget, the first with its
    // ID after the result and the second before it, and its third as usual.
    const script = `
      const readline = require('node:readline')
      const words = { text: 'word '.repeat(200000) }
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const { id } = JSON.parse(line)
        process.stdout.write(JSON.stringify(id === 1 ? { result: words, id } : id === 2 ? { id, result: words } : { id, result: { ok: true } }) + '\\n')
      })`
    const server = new CodexProcess({ executable: process.execPath, args: ['-e', script], cwd: process.cwd(), env: process.env,
      requestTimeoutMs: 10_000, maxFrameBytes: 64 * 1024, enqueue: task => task(), onFrame: async () => undefined,
      onLost: () => { throw new Error('The app-server was ended.') }, rejection: error => new Error(String(error)) })
    try {
      const first = server.rpc('thread/read', {}), second = server.rpc('thread/read', {})
      const third = new Promise<unknown>((resolve, reject) => { void server.rpc('thread/read', {}, value => { resolve(value) }).catch(reject) })
      await expect(first).rejects.toThrow(Uncertain)
      await expect(second).rejects.toThrow(Uncertain)
      await expect(third).resolves.toEqual({ ok: true })
      expect(server.alive).toBe(true)
      expect(server.owed).toBe(false)
    } finally { server.end(); await server.closed }
  })
})
