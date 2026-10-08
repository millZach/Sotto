// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { BabysitStart, BabysitListing } from '../../../src/main/agents/babysitting'
import { BABYSITTING_SWITCHED_OFF, PULL_REQUEST_MCP_SERVER, PullRequestToolServer, pullRequestToolDefinitions, type PullRequestToolHandlers } from '../../../src/main/agents/pullRequestTools'
import { pullRequestKey } from '../../../src/main/agents/gitPullRequests'

/**
 * `sotto_pull_requests` (ADR-0061 decision 2): which pull request a call means, the words each answer is in, and what the
 * switch does to a running session's calls and to what agents started (decision 12).
 */
const servers: PullRequestToolServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })
const url = (number: number) => `https://github.com/o/r/pull/${number}`

function harness(options: { branch?: string; linked?: string[]; admits?: boolean; link?: (reference: string) => Promise<{ link: { url: string } }> } = {}) {
  let enabled = true
  const records: BabysitListing[] = []
  const linked = [...options.linked ?? []]
  const calls: string[] = []
  const babysitter: NonNullable<PullRequestToolHandlers['babysitter']> = {
    start: async (threadId, address, startedBy, admission): Promise<BabysitStart> => {
      calls.push(`start ${address} ${startedBy}`)
      if (admission?.allowed && !admission.allowed()) return { started: false, reason: 'switched-off' }
      if (![options.branch, ...linked].some(known => known && pullRequestKey(known) === pullRequestKey(address))) return { started: false, reason: 'unknown-pull-request' }
      const existing = records.find(item => pullRequestKey(item.url) === pullRequestKey(address))
      if (existing) return { started: false, reason: 'already', babysitting: existing }
      const record = { threadId, url: address, number: Number(/\d+$/u.exec(address)![0]), startedBy, startedAt: '2026-10-08T12:00:00.000Z' }
      records.push(record)
      return { started: true, babysitting: record }
    },
    stop: async (selector, reason) => {
      calls.push(`stop ${selector.url ?? 'all'} ${reason}${selector.startedBy ? ` ${selector.startedBy}` : ''}`)
      const matching = records.filter(item => (selector.url === undefined || pullRequestKey(item.url) === pullRequestKey(selector.url)) && (selector.startedBy === undefined || item.startedBy === selector.startedBy))
      for (const item of matching) records.splice(records.indexOf(item), 1)
      return matching.length
    },
    list: () => [...records],
  }
  const server = new PullRequestToolServer({ enabled: () => enabled, babysitter, host: {
    admitsBabysitting: () => options.admits ?? true,
    threadPullRequests: () => ({ branch: options.branch, linked }),
    linkThreadPullRequest: async (_threadId, reference) => {
      const linkedNow = await (options.link ?? (async (given: string) => ({ link: { url: url(Number(/(\d+)$/u.exec(given)![1])) } })))(reference)
      linked.push(linkedNow.link.url)
      return linkedNow
    },
  } })
  servers.push(server)
  const call = async (name: string, args: unknown = {}) => { const result = await server.call('thread', name, args); return { text: result.content.map(part => part.type === 'text' ? part.text : '').join(''), error: result.isError === true } }
  return { server, call, calls, records, setEnabled: (value: boolean) => { enabled = value } }
}

describe('the pull request tools', () => {
  it('tells the agent to use them instead of polling gh or sleeping, by their full names', () => {
    const babysit = pullRequestToolDefinitions.find(tool => tool.name === 'babysit_pull_request')!
    expect(babysit.description).toContain('instead of polling gh, sleeping')
    expect(babysit.description).toContain('then end your turn')
    expect(pullRequestToolDefinitions.map(tool => tool.name)).toEqual(['babysit_pull_request', 'stop_babysitting', 'list_babysitting'])
    expect(PULL_REQUEST_MCP_SERVER).toBe('sotto_pull_requests')
  })

  it('babysits the branch\'s own pull request when none is named, and says so when Sotto knows none', async () => {
    const h = harness({ branch: url(5) })
    expect(await h.call('babysit_pull_request')).toEqual({ error: false, text: expect.stringContaining('Sotto is babysitting pull request #5 for this thread.') })
    expect(h.calls).toEqual([`start ${url(5)} agent`])
    expect((await h.call('babysit_pull_request')).text).toContain('This thread already babysits pull request #5, since 2026-10-08T12:00:00.000Z. Nothing changed.')
    const none = harness()
    expect(await none.call('babysit_pull_request')).toEqual({ error: true, text: 'Sotto does not know a pull request for this thread\'s branch yet. Name it by its GitHub URL or its number, such as #42. Nothing was started.' })
  })

  it('uses a pull request the thread knows by number, and links one it does not know first', async () => {
    const h = harness({ linked: [url(3)] })
    await h.call('babysit_pull_request', { pull_request: '#3' })
    await h.call('babysit_pull_request', { pull_request: url(9) })
    expect(h.calls).toEqual([`start ${url(3)} agent`, `start ${url(9)} agent`])
    expect((await h.call('list_babysitting')).text).toBe(`This thread babysits:\n- #3 ${url(3)}: you started it at 2026-10-08T12:00:00.000Z.\n- #9 ${url(9)}: you started it at 2026-10-08T12:00:00.000Z.`)
    const refused = harness({ link: async () => { throw new Error('Could not read the pull request. GitHub has no pull request #4 in o/r that your gh sign-in can see.') } })
    expect(await refused.call('babysit_pull_request', { pull_request: '4' })).toEqual({ error: true, text: 'Could not read the pull request. GitHub has no pull request #4 in o/r that your gh sign-in can see. Nothing was started.' })
    expect(await refused.call('babysit_pull_request', { pull_request: 'the green one' })).toEqual({ error: true, text: 'Name the pull request by its GitHub URL or its number, such as #42. Nothing was started.' })
  })

  it('stops one by URL or number, or every one, and says when there is nothing to stop', async () => {
    const h = harness({ linked: [url(3), url(4), url(5)] })
    for (const number of [3, 4, 5]) await h.call('babysit_pull_request', { pull_request: `#${number}` })
    expect((await h.call('stop_babysitting', { pull_request: '#3' })).text).toBe('Sotto stopped babysitting pull request #3. It sends no more wake-ups about it.')
    expect((await h.call('stop_babysitting', { pull_request: '#3' })).text).toBe('This thread does not babysit that pull request. Nothing was stopped. Call list_babysitting to see what it babysits.')
    expect((await h.call('stop_babysitting')).text).toBe('Sotto stopped babysitting all 2 pull requests for this thread. It sends no more wake-ups about them.')
    expect((await h.call('stop_babysitting')).text).toBe('This thread babysits no pull requests. Nothing was stopped.')
    expect((await h.call('list_babysitting')).text).toBe('This thread babysits no pull requests.')
    expect(h.calls.filter(call => call.startsWith('stop'))).toEqual([`stop ${url(3)} agent`, 'stop all agent', 'stop all agent'])
  })

  it('refuses every call while the switch is off, offers new launches nothing, and ends only what agents started', async () => {
    const h = harness({ linked: [url(3)] })
    await h.call('babysit_pull_request', { pull_request: '#3' })
    h.records.push({ threadId: 'thread', url: url(4), number: 4, startedBy: 'user', startedAt: '2026-10-08T12:00:00.000Z' })
    await expect(h.server.settingChanged()).resolves.toBe(0)
    h.setEnabled(false)
    await expect(h.server.mcpServer('thread')).resolves.toBeUndefined()
    expect(await h.call('babysit_pull_request', { pull_request: '#3' })).toEqual({ error: true, text: BABYSITTING_SWITCHED_OFF })
    expect((await h.call('stop_babysitting')).text).toContain('Nothing was started or stopped.')
    await expect(h.server.settingChanged()).resolves.toBe(1)
    expect(h.records.map(item => [item.number, item.startedBy])).toEqual([[4, 'user']])
    expect(h.calls.at(-1)).toBe('stop all switch agent')
  })

  it('refuses a call whose link was still being made when the switch was turned off, and starts nothing', async () => {
    let linked!: () => void
    const h = harness({ link: async () => { await new Promise<void>(resolve => { linked = resolve }); return { link: { url: url(6) } } } })
    const call = h.call('babysit_pull_request', { pull_request: url(6) })
    await expect.poll(() => linked).toBeDefined()
    h.setEnabled(false)
    await expect(h.server.settingChanged()).resolves.toBe(0)
    linked()
    expect(await call).toEqual({ error: true, text: BABYSITTING_SWITCHED_OFF })
    expect(h.records).toEqual([])
    expect(h.calls.filter(call => call.startsWith('start'))).toEqual([])
  })

  it('offers nothing to a thread that cannot babysit, and refuses its calls', async () => {
    const h = harness({ admits: false })
    await expect(h.server.mcpServer('thread')).resolves.toBeUndefined()
    expect(await h.call('babysit_pull_request')).toEqual({ error: true, text: 'This thread cannot babysit pull requests with Sotto\'s tools. Nothing was started.' })
    const ready = harness()
    await expect(ready.server.mcpServer('thread')).resolves.toMatchObject({ name: 'sotto_pull_requests', type: 'http' })
  })
})
