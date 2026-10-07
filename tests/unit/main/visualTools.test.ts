// @vitest-environment node
/**
 * The visualize tool's answers (ADR-0055): what it says when a visual is shown, and a refusal for each reason that
 * says nothing was drawn. Calls go through the server's own dispatch, as a provider's would.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VISUAL_MCP_SERVER, VisualToolServer, visualizeDefinition, visualShownText, type VisualToolHandlers } from '../../../src/main/agents/visualTools'

const servers: VisualToolServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })

function server(overrides: Partial<VisualToolHandlers> = {}) {
  const add = vi.fn<VisualToolHandlers['add']>(async (_threadId, input) => ({ added: true, anchor: 'assistant',
    visual: { id: 'v1', title: input.title, kind: input.kind, source: input.source, ...(input.steps ? { steps: input.steps } : {}) } }))
  const created = new VisualToolServer({ enabled: () => true, admits: threadId => threadId === 'thread', add, ...overrides })
  servers.push(created)
  return { tools: created, add }
}
const FLOW = { title: 'How a send moves', kind: 'diagram', source: 'flowchart LR\n  A --> B\n  B --> C', steps: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }, { text: 'Four' }] }
const said = async (tools: VisualToolServer, args: unknown, threadId = 'thread') => {
  const result = await tools.call(threadId, 'visualize', args)
  return { text: result.content[0]?.type === 'text' ? result.content[0].text : '', isError: result.isError === true }
}

describe('the visualize tool', () => {
  it('describes itself, its limits and its highlight names to the agent', () => {
    expect(visualizeDefinition.name).toBe('visualize')
    for (const phrase of ['show how something works', 'state machine', 'up to 12 steps', 'flowchart node ids', 'A->B', 'arrow numbers counted from 1', 'up to 6 visuals', 'up to 100', '12,000 characters'])
      expect(visualizeDefinition.description).toContain(phrase)
    expect(server().tools.name).toBe(VISUAL_MCP_SERVER)
  })

  it('says what was shown and where, and asks the agent not to repeat the steps', async () => {
    const { tools, add } = server()
    expect(await said(tools, FLOW)).toEqual({ isError: false, text: 'Shown in the thread as "How a send moves": a flowchart with 4 steps, under your last message. Do not repeat the steps in your reply.' })
    expect(add).toHaveBeenCalledWith('thread', FLOW)
  })

  it('names the kind with its article and leaves out the steps line when there are none', () => {
    expect(visualShownText('Tables', 'Entity relationship diagram', 0, 'user')).toBe('Shown in the thread as "Tables": an entity relationship diagram, under the user\'s message.')
    expect(visualShownText('Calls', 'Sequence diagram', 1, 'none')).toBe('Shown in the thread as "Calls": a sequence diagram with 1 step, at the start of the thread. Do not repeat the steps in your reply.')
  })

  it('refuses while visuals are off, and gives no new launch a server', async () => {
    const { tools, add } = server({ enabled: () => false })
    expect(await said(tools, FLOW)).toEqual({ isError: true, text: 'Visuals are turned off in Sotto\'s settings. Nothing was drawn. Explain in text instead.' })
    expect(await tools.mcpServer('thread')).toBeUndefined()
    expect(add).not.toHaveBeenCalled()
  })

  it('gives a thread it does not admit no server, and refuses its calls', async () => {
    const { tools } = server()
    expect(await tools.mcpServer('elsewhere')).toBeUndefined()
    expect(await tools.mcpServer('thread')).toMatchObject({ name: VISUAL_MCP_SERVER, type: 'http' })
    expect(await said(tools, FLOW, 'elsewhere')).toEqual({ isError: true, text: 'This thread cannot show visuals. Nothing was drawn. Explain in text instead.' })
    const throwing = server({ admits: () => { throw new Error('closed') } }).tools
    expect(await throwing.mcpServer('thread')).toBeUndefined()
  })

  it('refuses a call that fails its checks with the reason, before anything is kept', async () => {
    const { tools, add } = server()
    expect(await said(tools, { ...FLOW, title: '' })).toEqual({ isError: true, text: 'The title is empty. Nothing was drawn. Fix it and call visualize again, or explain in text.' })
    expect((await said(tools, { ...FLOW, source: 'pie title Pets' })).text).toBe('The diagram cannot be drawn. Sotto doesn\'t draw “pie” diagrams. Sequence, flow, state, class and entity diagrams are drawn. Nothing was drawn. Fix it and call visualize again, or explain in text.')
    const large = `flowchart LR\n${Array.from({ length: 400 }, (_, index) => `  N${index} --> M${index}`).join('\n')}`
    expect(await said(tools, { ...FLOW, source: large })).toEqual({ isError: true, text: 'This diagram is too large for Sotto to draw: it has more parts than Sotto draws safely. Nothing was drawn. Split it into smaller diagrams, or explain in text.' })
    expect(add).not.toHaveBeenCalled()
  })

  it.each([
    ['history-unavailable', 'Sotto could not save this thread\'s history just now. Nothing was drawn. Explain in text instead.'],
    ['turn-limit', 'This turn already drew 6 visuals, the most one turn can draw. Nothing was drawn. Explain in text instead.'],
    ['thread-limit', 'This thread already holds 100 visuals, the most one thread can hold. Nothing was drawn. Explain in text instead.'],
    ['unknown-thread', 'This thread cannot show visuals. Nothing was drawn. Explain in text instead.'],
  ] as const)('says nothing was drawn when the thread refuses it: %s', async (reason, text) => {
    const { tools } = server({ add: async () => ({ added: false, reason }) })
    expect(await said(tools, FLOW)).toEqual({ isError: true, text })
  })

  it('answers a failure it did not expect without its details', async () => {
    const { tools } = server({ add: async () => { throw new Error('SQLITE_FULL C:\\Users\\private') } })
    expect(await said(tools, FLOW)).toEqual({ isError: true, text: 'The visual could not be drawn. Nothing was drawn. Explain in text instead.' })
  })
})
