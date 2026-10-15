// @vitest-environment node
// Opt-in only: creates one fresh native Muse session and resumes it on a second host. No turn is run and nothing is
// approved; the check is that Muse lists Sotto's tools from the servers a start and a cold resume carry.
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrowserAgentServer } from '../../src/main/agents/browserAgentServer'
import { MuseMspHost } from '../../src/main/agents/muse'
import { pullRequestToolDefinitions } from '../../src/main/agents/pullRequestTools'
import { ThreadToolServer, type ScopedThreadTools, type ThreadToolDefinition } from '../../src/main/agents/threadToolServer'
import { VISUAL_MCP_SERVER, visualizeDefinition } from '../../src/main/agents/visualTools'
import { browserToolDefinitions } from '../../src/main/tools/browserAgentTools'

describe('requires SOTTO_MUSE_LIVE=1', () => {
  it.skipIf(process.env.SOTTO_MUSE_LIVE !== '1')('native Muse lists Sotto’s tools from a new session and from a cold resume, before any turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-muse-tools-live-'))
    const listed: { server: string; threadId: string }[] = []
    const scoped = (name: string, definitions: readonly ThreadToolDefinition[]) => {
      const server = new ThreadToolServer({ name, serverName: name, instructions: 'A synthetic check.', unavailable: 'Unavailable.', failed: 'Failed.' },
        definitions, async () => ({ isError: true, content: [{ type: 'text', text: 'This synthetic check runs no tool.' }] }),
        threadId => { listed.push({ server: name, threadId }); return definitions })
      return { server, tools: { name, definitions, mcpServer: (id: string) => server.mcpServer(id) } satisfies ScopedThreadTools }
    }
    const visual = scoped(VISUAL_MCP_SERVER, [visualizeDefinition]), pullRequests = scoped('sotto_pull_requests', pullRequestToolDefinitions)
    const browser = new BrowserAgentServer(browserToolDefinitions, async () => ({ isError: true, content: [{ type: 'text', text: 'This synthetic check runs no tool.' }] }))
    const equip = (host: MuseMspHost) => {
      host.useBrowserTools({ definitions: browserToolDefinitions, call: browser.call.bind(browser), mcpServer: id => browser.mcpServer(id) })
      host.useThreadTools([visual.tools, pullRequests.tools])
    }
    let host = new MuseMspHost(root)
    try {
      equip(host)
      const initial = await host.connect()
      const threadId = randomUUID()
      await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'tools', title: 'Synthetic tools', path: root })
      await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: 'tools', title: 'Sotto synthetic tool check', modelId: initial.models[0]!.id })
      await expect.poll(() => listed.filter(item => item.threadId === threadId).map(item => item.server).sort(), { timeout: 30_000, interval: 250 })
        .toEqual([VISUAL_MCP_SERVER, 'sotto_pull_requests'].sort())
      const afterStart = listed.length
      host.disconnect(); await host.closed()
      host = new MuseMspHost(root)
      equip(host)
      await host.connect()
      host.observeThreads?.([threadId])
      await expect.poll(() => listed.slice(afterStart).filter(item => item.threadId === threadId).map(item => item.server).sort(), { timeout: 30_000, interval: 250 })
        .toEqual([VISUAL_MCP_SERVER, 'sotto_pull_requests'].sort())
      const thread = (await host.snapshot()).threads.find(candidate => candidate.id === threadId)!
      expect(thread.messages).toEqual([])
      expect(thread.status).toBe('idle')
      console.info(`Muse ${initial.version}: listed on start ${afterStart}, on cold resume ${listed.length - afterStart}`)
    } finally {
      host.disconnect(); await host.closed()
      await Promise.all([browser.close(), visual.server.close(), pullRequests.server.close()])
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
