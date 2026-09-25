// @vitest-environment node
// Explicit native compatibility probes. SOTTO_BROWSER_LIVE initializes clients and discovers tools without a model
// turn; SOTTO_BROWSER_TURN_LIVE sends one paid turn per case to see whether the client asks before the tool.
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

// Opt-in and paid: one model turn per case. It answers the question discovery cannot: does the client ask its own
// permission before reaching Sotto's browser tool? Every native request is denied. Only the request's kind, method
// or tool name and the kinds of choice offered are reported; no prompt, argument or reply text.
const turnCases = [
  ['claude', undefined], ['claude', 'auto-accept-edits'],
  ['codex', undefined], ['codex', 'approval-required'],
  ['grok', undefined], ['grok', 'auto'],
] as const
it.skipIf(process.env.SOTTO_BROWSER_TURN_LIVE !== '1').each(turnCases)('%s (%s) calls a Sotto browser tool in a real turn', async (provider, runtimeMode) => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-browser-native-')); const cwd = join(root, 'project'); const data = join(root, 'data')
  await mkdir(cwd); await mkdir(data)
  execFileSync('git', ['init', '--quiet', cwd], { windowsHide: true, stdio: 'ignore' })
  const host = provider === 'codex' ? new CodexAppServerHost({ userDataPath: data })
    : provider === 'claude' ? new ClaudeStreamJsonHost({ userDataPath: data })
      // SOTTO_GROK_ARGS (a JSON array) launches Grok differently, to test how its own allow rules apply.
      : new GrokAcpHost(data, process.env.SOTTO_GROK_ARGS ? { args: JSON.parse(process.env.SOTTO_GROK_ARGS) as string[] } : {})
  let calls = 0
  // A real tool name, so Claude's allowance is exercised by name rather than by a synthetic one.
  const server = new BrowserAgentServer([{ name: 'browser_status', description: 'Reports whether Sotto\'s browser is available. Takes no arguments.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    async () => { calls++; return { content: [{ type: 'text', text: 'Sotto browser is available.' }] } })
  const seen: { kind: string; tool?: string | undefined; choices: string[]; shape?: unknown }[] = []
  try {
    await server.mcpServer('synthetic')
    // SOTTO_BROWSER_NO_ADMISSION hides the tool names from the adapter, so only the client's own rules can let a call through.
    host.useBrowserTools(process.env.SOTTO_BROWSER_NO_ADMISSION === '1' ? { definitions: [], call: server.call.bind(server), mcpServer: server.mcpServer.bind(server) } : server)
    const snapshot = await host.connect(); const model = snapshot.models.find(model => model.ready)
    expect(Boolean(model)).toBe(true)
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'browser-turn', title: 'Browser turn', path: cwd })
    const threadId = randomUUID()
    expect((await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: 'browser-turn', title: 'Browser turn', modelId: model!.id, ...(runtimeMode ? { runtimeMode } : {}) })).accepted).toBe(true)
    // Claude and Codex are asked for the tool by name. Grok is asked the way work asks for the browser: told the
    // tool's name, it called it by its bare name, which does not say which server it is on, and Sotto rightly
    // leaves that prompt for the user. Found through search_tool, the name is qualified (`sotto_browser__…`).
    const prompt = process.env.SOTTO_BROWSER_TURN_PROMPT ?? (provider === 'grok'
      ? "Check whether Sotto's in-app browser is available, using the browser tools you have. Then reply with exactly SOTTO_BROWSER_TURN_DONE. Do not read files or run commands."
      : 'Call the browser_status tool from the sotto_browser MCP server exactly once, with no arguments. Then reply with exactly SOTTO_BROWSER_TURN_DONE. Do not use any other tool, read files or run commands.')
    await host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: 'browser-turn', text: prompt })
    const thread = async () => (await host.snapshot()).threads.find(thread => thread.id === threadId)!
    const answered = new Set<string>()
    const deadline = Date.now() + 150_000
    while (Date.now() < deadline) {
      const current = await thread()
      for (const request of current.requests) {
        if (answered.has(request.id)) continue
        answered.add(request.id)
        // The native request's shape (key names and the tool name alone), so a mismatch with what an adapter expects can be seen.
        let shape: unknown
        try { const details = JSON.parse(request.context?.details ?? 'null') as unknown; shape = details && typeof details === 'object' ? { keys: Object.keys(details), tool_name: (details as { tool_name?: unknown }).tool_name, variant: (details as { variant?: unknown }).variant } : details === null ? 'no details' : typeof details } catch { shape = 'unreadable' }
        seen.push({ kind: request.kind, tool: request.context?.toolName, choices: (request.permissionChoices ?? []).map(choice => choice.kind), shape })
        const deny = request.permissionChoices?.find(choice => choice.kind === 'deny')
        await host.execute({ type: 'answer', commandId: randomUUID(), threadId, requestId: request.id, answer: 'deny', approved: false, ...(deny ? { permissionChoice: deny.id } : {}) }).catch(() => undefined)
      }
      if (current.status !== 'running' && (calls > 0 || seen.length > 0 || current.messages.some(message => message.role === 'assistant'))) break
      await new Promise(done => setTimeout(done, 1000))
    }
    const outcome = seen.length ? 'native prompt before the tool' : calls > 0 ? 'reached the tool without a native prompt' : 'never called the tool'
    console.log(JSON.stringify({ provider, runtimeMode: runtimeMode ?? 'default', version: (await host.snapshot()).version, outcome, calls, requests: seen }))
    expect(seen.length > 0 || calls > 0).toBe(true)
  } finally {
    host.disconnect(); await host.closed(); await server.close()
    await removeProbe(root)
  }
}, 200_000)
