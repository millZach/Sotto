// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { COORDINATION_TOOL_DEFINITIONS } from '../../../src/main/agents/threadCoordinationTools'
import { delegationToolDefinitions } from '../../../src/main/agents/delegationTools'
import { showInThreadDefinition } from '../../../src/main/agents/mediaTools'
import { readyToMergeDefinition, tellWatcherDefinition } from '../../../src/main/agents/tellWatcherTools'
import { listedTool, ThreadToolServer, type ThreadToolDefinition } from '../../../src/main/agents/threadToolServer'
import { visualizeDefinition } from '../../../src/main/agents/visualTools'
import { makeSoundDefinition } from '../../../src/main/plugins/elevenlabs/tool'
import { makeModelDefinition } from '../../../src/main/plugins/meshy/tool'
import { gitHubCloseIssueDefinition, gitHubCommentDefinition, gitHubOpenIssueDefinition, gitHubReopenIssueDefinition, mailSendDefinition,
  pluginAccountsDefinition, pluginReadDefinition, vercelCancelDefinition, vercelPromoteDefinition, vercelRollbackDefinition } from '../../../src/main/plugins/pluginTools'
import { browserToolDefinitions } from '../../../src/main/tools/browserAgentTools'

/**
 * `agy` 1.5.17 leaves a session's largest tool out, silently, once its tool declarations pass a total of about 57 KB,
 * and `delegate` is Sotto's largest. Measured on forge, November 25, 2026: this set listed at 56,501 characters, and
 * `agy` kept every tool with a user tool of 2.5 KB beside it and dropped `delegate` with one of 4 KB. Untrimmed (60.8 KB)
 * it dropped `delegate` on its own. The budget only tightens; a raise needs its reason, and an `agy` check, in the PR.
 */
const SOTTO_TOOLS_BUDGET = 57_000

/** Everything an ordinary Antigravity thread on This computer can be offered with every feature on: seven servers. */
const everyOrdinaryThreadTool: readonly ThreadToolDefinition[] = [
  ...browserToolDefinitions,
  ...COORDINATION_TOOL_DEFINITIONS,
  ...delegationToolDefinitions(true, true, 'this-computer', false, true, true),
  showInThreadDefinition,
  pluginAccountsDefinition, pluginReadDefinition, gitHubCommentDefinition, gitHubOpenIssueDefinition, gitHubCloseIssueDefinition,
  gitHubReopenIssueDefinition, vercelCancelDefinition, vercelPromoteDefinition, vercelRollbackDefinition, mailSendDefinition,
  makeModelDefinition, makeSoundDefinition,
  visualizeDefinition,
  readyToMergeDefinition, tellWatcherDefinition,
]
const size = (tool: ThreadToolDefinition): number => JSON.stringify(listedTool(tool)).length

describe('the tools Sotto lists for a thread', () => {
  let server: ThreadToolServer | undefined
  afterEach(async () => { await server?.close(); server = undefined })

  it('keeps an ordinary thread\'s tools under what agy takes before it drops one', () => {
    const total = everyOrdinaryThreadTool.reduce((sum, tool) => sum + size(tool), 0)
    expect(total).toBeLessThan(SOTTO_TOOLS_BUDGET)
  })

  it('sends schemas without $schema lines or the UUID regex beside format uuid, and keeps every other pattern', () => {
    const listed = everyOrdinaryThreadTool.map(listedTool)
    const text = JSON.stringify(listed)
    expect(text).not.toContain('"$schema"')
    expect(text).not.toContain((z.toJSONSchema(z.uuid()) as { pattern: string }).pattern)
    // A GitHub owner still carries its own pattern, and a UUID still says it is one.
    expect(JSON.stringify(listedTool(gitHubCommentDefinition))).toContain('"pattern"')
    expect(JSON.stringify(listed.find(tool => tool.name === 'cancel_delegation'))).toContain('"format":"uuid"')
    // The definitions themselves are untouched, and listing again gives the same object.
    expect(JSON.stringify(delegationToolDefinitions(true, true, 'this-computer', false, true, true))).toContain('"$schema"')
    const delegate = everyOrdinaryThreadTool.find(tool => tool.name === 'delegate')!
    expect(listedTool(delegate)).toBe(listedTool(delegate))
  })

  it('answers tools/list with the compact schemas', async () => {
    const input = z.object({ delegation: z.uuid(), owner: z.string().regex(/^[a-z]+$/) }).strict()
    const tool: ThreadToolDefinition = { name: 'probe', description: 'A probe.', inputSchema: z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown> }
    server = new ThreadToolServer({ name: 'sotto_probe', serverName: 'sotto-probe', instructions: '', unavailable: 'Unavailable.', failed: 'Failed.' },
      [tool], async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const endpoint = await server.mcpServer('thread')
    const reply = await fetch(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(endpoint.headers.map(header => [header.name, header.value])) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    const listed = (await reply.json() as { result: { tools: ThreadToolDefinition[] } }).result.tools
    expect(listed).toEqual([{ name: 'probe', description: 'A probe.', inputSchema: { type: 'object', additionalProperties: false, required: ['delegation', 'owner'],
      properties: { delegation: { type: 'string', format: 'uuid' }, owner: { type: 'string', pattern: '^[a-z]+$' } } } }])
  })
})
