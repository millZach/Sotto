// @vitest-environment node
// Explicit native compatibility probe: initializes clients and discovers tools; never sends a model turn.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { BrowserAgentServer } from '../../src/main/agents/browserAgentServer'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'
import { GrokAcpHost } from '../../src/main/agents/grok'

const providers = ['codex', 'claude', 'grok'] as const
async function removeProbe(root: string): Promise<void> {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-browser-native-')) throw new Error('Unexpected native browser test folder')
  await rm(root, { recursive: true, force: true })
}
it.skipIf(process.env.SOTTO_BROWSER_LIVE !== '1').each(providers)('%s discovers Sotto browser tools without a model turn', async provider => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-browser-native-')); const cwd = join(root, 'project'); const data = join(root, 'data')
  await mkdir(cwd); await mkdir(data)
  execFileSync('git', ['init', '--quiet', cwd], { windowsHide: true, stdio: 'ignore' })
  const host = provider === 'codex' ? new CodexAppServerHost({ userDataPath: data })
    : provider === 'claude' ? new ClaudeStreamJsonHost({ userDataPath: data })
      : new GrokAcpHost(data)
  let calls = 0; const methods: string[] = []
  const server = new BrowserAgentServer([{ name: 'browser_probe', description: 'Synthetic browser compatibility test.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }], async () => { calls++; return { content: [] } })
  try {
    await server.mcpServer('synthetic')
    // Record protocol method names alone: no admission credential, arguments, or page content.
    const transport = (server as unknown as { server: Server }).server
    transport.on('request', request => {
      let body = ''
      request.on('data', chunk => { if (body.length < 4096) body += String(chunk) })
      request.on('end', () => { try { const frame = JSON.parse(body) as { method?: string }; if (frame.method) methods.push(frame.method) } catch { /* Ignore non-RPC traffic. */ } })
    })
    host.useBrowserTools(server)
    const snapshot = await host.connect(); const model = snapshot.models.find(model => model.ready)
    expect(Boolean(model)).toBe(true)
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'browser-native', title: 'Browser compatibility', path: cwd })
    const threadId = randomUUID()
    const result = await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: 'browser-native', title: 'Browser compatibility', modelId: model!.id })
    expect(result.accepted).toBe(true)
    await expect.poll(() => methods, { timeout: 20_000 }).toContain('tools/list')
    expect(calls).toBe(0)
  } finally {
    host.disconnect(); await host.closed(); await server.close()
    await removeProbe(root)
  }
}, 60_000)
