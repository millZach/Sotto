// @vitest-environment node
/**
 * Watcher's shape on Cursor's own CLI (ADR-0123). Never in CI: it needs Cursor's CLI installed and signed in, and it spends
 * one short turn on the user's Cursor plan. Run with
 *
 *   SOTTO_CURSOR_LIVE=1 npx vitest run tests/integration/watcherOnCursorLive.test.ts
 *
 * A thread with Watcher's launch profile is given a `sotto_threads` server of the test's own, a loopback server that
 * answers one tool, so no Watcher service runs. The check is what only Cursor can show: Sotto's rule in its Cursor folder
 * lets the tool run without a request, the server sees the thread's bearer token, and the message Cursor replays after a
 * restart is shown as typed. Sotto's Cursor folder is a scratch folder inside the test's root.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { CursorAcpHost } from '../../src/main/agents/cursor'
import type { ThreadLaunchProfiles } from '../../src/main/agents/host'
import { watcherRequestNote } from '../../src/main/agents/watcherRequestNote'

const live = process.env.SOTTO_CURSOR_LIVE === '1'
const MODEL = process.env.SOTTO_CURSOR_MODEL ?? 'gpt-5.4-nano'
const TOKEN = `Bearer ${randomUUID()}`
const userConfig = (): Promise<string> => readFile(join(process.env.CURSOR_CONFIG_DIR ?? join(homedir(), '.cursor'), 'cli-config.json'), 'utf8').catch(() => '')

/** A streamable HTTP MCP server with one tool, `list_threads`, recording each call and whether it carried the token. */
async function threadsServer(): Promise<{ server: Server; url: string; calls: { tool: string; authorized: boolean }[] }> {
  const calls: { tool: string; authorized: boolean }[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      const message = JSON.parse(body) as { id?: number | string; method: string; params?: { name?: string; protocolVersion?: string } }
      if (message.id === undefined) { response.writeHead(202).end(); return }
      const result = message.method === 'initialize' ? { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'sotto_threads', version: '1' } }
        : message.method === 'tools/list' ? { tools: [{ name: 'list_threads', description: 'Lists the threads Sotto knows.', inputSchema: { type: 'object', properties: {} } }] }
        : message.method === 'tools/call' ? (calls.push({ tool: String(message.params?.name), authorized: request.headers.authorization === TOKEN }),
          { content: [{ type: 'text', text: 'There are 3 threads: alpha, beta and gamma.' }], structuredContent: { status: 'ok', count: 3 } })
        : undefined
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(result ? { jsonrpc: '2.0', id: message.id, result } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { server, url: `http://127.0.0.1:${address.port}/mcp`, calls }
}

it.skipIf(!live)('runs a Watcher-shaped turn on Cursor: its own tool runs without a request, and its message reads as typed after a restart', { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-cursor-watcher-live-'))
  const project = join(root, 'project')
  const before = await userConfig()
  const tools = await threadsServer()
  const id = randomUUID()
  const revoke = vi.fn()
  const profiles: ThreadLaunchProfiles = { profileFor: async thread => thread !== id ? undefined : {
    kind: 'watcher', server: { name: 'sotto_threads', type: 'http', url: tools.url, headers: [{ name: 'Authorization', value: TOKEN }] }, toolNames: ['list_threads'], revoke } }
  const options = { configDirectory: join(root, 'cursor-config'), requestTimeoutMs: 90_000 }
  let host = new CursorAcpHost(join(root, 'sotto'), options)
  host.useLaunchProfiles(profiles)
  try {
    execFileSync('git', ['init', '-q', project]); await writeFile(join(project, 'README.md'), 'Live probe\n')
    await host.connect()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'live', title: 'Live', path: project })
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'live', modelId: MODEL, title: 'Watcher', reasoningEffort: 'low' })
    host.observeThreads([id])
    const thread = async () => (await host.snapshot()).threads.find(candidate => candidate.id === id)!
    const typed = 'Call the list_threads tool once, then reply with only the number of threads it listed.'
    expect(await host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'watcher-live', text: typed,
      watcherRequestNote: watcherRequestNote(randomUUID(), randomUUID()) })).toEqual({ accepted: true })
    await expect.poll(async () => (await thread()).status, { timeout: 180_000, interval: 500 }).toBe('idle')
    // Sotto's rule let Watcher's own tool run: the server was called with the thread's token, and nothing waited on the user.
    expect(tools.calls).toEqual(expect.arrayContaining([{ tool: 'list_threads', authorized: true }]))
    expect((await thread()).requests).toEqual([])
    expect((await thread()).messages.filter(message => message.role === 'assistant').map(message => message.text).join(' ')).toMatch(/3/u)
    expect((await thread()).messages.find(message => message.role === 'user')?.text).toBe(typed)
    // Cursor replays the message with Watcher's instructions and note; Sotto shows the words as typed.
    host.disconnect(); await host.closed()
    host = new CursorAcpHost(join(root, 'sotto'), options)
    host.useLaunchProfiles(profiles)
    host.observeThreads([id])
    await host.connect()
    await expect.poll(async () => (await thread()).messages.some(message => message.role === 'assistant'), { timeout: 60_000, interval: 500 }).toBe(true)
    expect((await thread()).messages.find(message => message.role === 'user')).toMatchObject({ id: 'watcher-live', text: typed })
    expect(revoke).not.toHaveBeenCalled()
    expect(await userConfig()).toBe(before)
  } finally {
    host.disconnect(); await host.closed()
    await new Promise(resolve => tools.server.close(resolve))
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})
