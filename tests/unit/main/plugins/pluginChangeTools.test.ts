// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commentOnGitHub } from '../../../../src/main/plugins/github/changes'
import type { GitCommandOptions, RunGitCommand } from '../../../../src/main/agents/git/gitStatus'
import { wordPluginChange } from '../../../../src/main/plugins/changeWords'
import { PluginChangeRequests, type PluginChangeAnswer, type PluginChangeWait } from '../../../../src/main/plugins/pendingChanges'
import { PluginToolServer } from '../../../../src/main/plugins/pluginTools'
import type { PluginUseReport } from '../../../../src/main/plugins/useRecord'
import { cancelVercelDeployment, describeVercelDeployment, type VercelChange, type VercelDescribed } from '../../../../src/main/plugins/vercel/changes'
import type { VercelFetch } from '../../../../src/main/plugins/vercel/read'
import { GITHUB_COMMENT_TOOL, PLUGIN_ACCOUNTS_TOOL, PLUGIN_READ_TOOL, VERCEL_CANCEL_TOOL, type GitHubSignIn, type PluginAccount, type PluginChange } from '../../../../src/shared/plugins'
import { deferred } from '../../../fixtures/deferred'

const servers: PluginToolServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })

/** A made-up account and a made-up token: nothing here is a real credential. */
const WORK: PluginAccount = { id: '22222222-2222-4222-8222-000000000001', plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: 'example-user' }
const TOKEN = 'made-up-vercel-token'
const comment = { owner: 'example-owner', repo: 'example-repo', number: 12, body: 'Looks good to me.' }

/** The tools over a gh and a Vercel that keep what they were asked, with the user's answer in the test's hands. */
function tools(options: { watcher?: boolean; answer?: PluginChangeAnswer; signIn?: GitHubSignIn; signIns?: GitHubSignIn[]; accounts?: readonly PluginAccount[]; gh?: string | Error; vercel?: (url: string, method: string) => { status?: number; body?: unknown }
  /** The real waiting asks, where a test answers or abandons a card as the app would. */
  requests?: PluginChangeRequests
  /** What main says of the account's token, where it cannot be read. */
  described?: VercelDescribed; cancelled?: VercelChange } = {}) {
  const ghCalls: { args: readonly string[]; stdin: string | undefined }[] = []
  const run: RunGitCommand = async (_cwd, _command, args, runOptions?: GitCommandOptions) => {
    ghCalls.push({ args, stdin: runOptions?.stdin })
    const answer = options.gh ?? '{"html_url":"https://github.com/example-owner/example-repo/issues/12#issuecomment-1"}'
    if (answer instanceof Error) throw answer
    return answer
  }
  const vercelCalls: { url: string; method: string; authorization: string | undefined }[] = []
  const fetcher: VercelFetch = async (url, init) => {
    vercelCalls.push({ url, method: init.method, authorization: init.headers.Authorization })
    const answer = options.vercel?.(url, init.method) ?? { body: {} }
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 })
  }
  const recorded: PluginUseReport[] = []
  const asked: PluginChange[] = []
  const waits: PluginChangeWait[] = []
  const asking = deferred<PluginChangeAnswer>()
  let gone = false
  const added = options.accounts ?? []
  const server = new PluginToolServer({
    admits: threadId => threadId === 'admitted' && !gone,
    // A list of answers is gh being asked more than once: the last one stands for every ask after it.
    gitHubSignIn: async () => (options.signIns && options.signIns.length > 1 ? options.signIns.shift() : options.signIns?.[0]) ?? options.signIn ?? { state: 'signed-in', login: 'example-user' },
    readGitHub: async () => ({ ok: true, text: '[]', truncated: false }),
    accounts: async () => added,
    findAccount: async (_plugin, name) => added.length === 0 ? 'none' : name === undefined ? (added.length === 1 ? added[0]! : 'ambiguous') : added.find(account => account.name === name) ?? 'unknown',
    readVercel: async () => ({ ok: true, text: '{}', truncated: false }),
    record: async report => { recorded.push(report) },
    isWatcher: () => options.watcher === true,
    askChange: async (threadId, change, wait) => {
      asked.push(change); waits.push(wait)
      return options.requests ? options.requests.ask(threadId, wordPluginChange(change), wait) : options.answer ?? asking.promise
    },
    commentOnGitHub: input => commentOnGitHub(run, input),
    describeVercelDeployment: async (_accountId, deploymentId, teamId) => options.described ?? describeVercelDeployment(fetcher, TOKEN, deploymentId, teamId),
    cancelVercelDeployment: async (_accountId, deploymentId, teamId) => options.cancelled ?? cancelVercelDeployment(fetcher, TOKEN, deploymentId, teamId),
  })
  servers.push(server)
  return { server, ghCalls, vercelCalls, recorded, asked, waits, answer: (value: PluginChangeAnswer) => { asking.resolve(value) }, forget: () => { gone = true } }
}
const said = (result: { content: { type: string; text?: string }[] }): string => result.content.map(part => part.text ?? '').join('\n')
/** Lets a held call run as far as it can before the user answers. */
const settle = async (): Promise<void> => { for (let turn = 0; turn < 20; turn++) await Promise.resolve() }

describe('a plugin change asks the user first (ADR-0205, decision 7)', () => {
  it('sends nothing to GitHub until the user allows it, then posts the comment on standard input and records that it was done', async () => {
    const { server, ghCalls, asked, recorded, answer } = tools()
    const call = server.call('admitted', GITHUB_COMMENT_TOOL, comment)
    await settle()
    // The card is up, with everything that will be sent, and nothing has left.
    expect(asked).toEqual([{ kind: 'github-comment', ...comment, account: 'example-user' }])
    expect(ghCalls).toEqual([])
    expect(recorded).toEqual([])
    answer('allowed')
    const result = await call
    expect(result.isError).toBeUndefined()
    expect(said(result)).toBe('The user allowed it, and the comment is posted: https://github.com/example-owner/example-repo/issues/12#issuecomment-1')
    expect(ghCalls).toEqual([{
      args: ['api', '--method', 'POST', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', 'repos/example-owner/example-repo/issues/12/comments', '--input', '-'],
      stdin: '{"body":"Looks good to me."}',
    }])
    // The record says a comment was posted, and nothing of where or what.
    expect(recorded).toEqual([{ threadId: 'admitted', plugin: 'github', tool: GITHUB_COMMENT_TOOL, kind: 'comment', outcome: 'done' }])
  })

  it.each([
    ['denied', 'The user said no. Nothing was changed. Do not ask again unless they tell you to.', 'denied'],
    ['lapsed', 'Nobody answered in time, so the request lapsed. Nothing was changed. Tell the user what you wanted to do and why, and ask again only if they tell you to.', 'lapsed'],
  ] as const)('changes nothing when the answer is %s, and tells the agent so', async (answer, words, outcome) => {
    const { server, ghCalls, recorded } = tools({ answer })
    const result = await server.call('admitted', GITHUB_COMMENT_TOOL, comment)
    expect(result.isError).toBe(true)
    expect(said(result)).toBe(words)
    expect(ghCalls).toEqual([])
    expect(recorded).toEqual([{ threadId: 'admitted', plugin: 'github', tool: GITHUB_COMMENT_TOOL, kind: 'comment', outcome }])
  })

  it('changes nothing when the ask is stopped, or when the thread was deleted while its card waited, even if it was allowed', async () => {
    const stopped = tools({ answer: 'stopped' })
    expect(said(await stopped.server.call('admitted', GITHUB_COMMENT_TOOL, comment))).toBe('The request was stopped before it was answered. Nothing was changed.')
    expect(stopped.ghCalls).toEqual([])
    expect(stopped.recorded).toEqual([])
    const deleted = tools()
    const call = deleted.server.call('admitted', GITHUB_COMMENT_TOOL, comment)
    await settle()
    deleted.forget()
    deleted.answer('allowed')
    expect((await call).isError).toBe(true)
    expect(deleted.ghCalls).toEqual([])
    expect(deleted.recorded).toEqual([])
  })

  it('gives Watcher the reading tools alone, and refuses a change from Watcher without asking anyone', async () => {
    const { server, asked, ghCalls } = tools({ watcher: true, answer: 'allowed' })
    const endpoint = (await server.mcpServer('admitted'))!
    const listed = await (await fetch(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(endpoint.headers.map(header => [header.name, header.value])) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json() as { result: { tools: { name: string }[] } }
    expect(listed.result.tools.map(tool => tool.name)).toEqual([PLUGIN_ACCOUNTS_TOOL, PLUGIN_READ_TOOL])
    const result = await server.call('admitted', GITHUB_COMMENT_TOOL, comment)
    expect(said(result)).toBe('Watcher reads from plugins and changes nothing through them. Start or steer a thread to make this change. Nothing was changed.')
    expect(asked).toEqual([])
    expect(ghCalls).toEqual([])
  })

  it('turns away a comment that names no real place, or none at all, before asking the user', async () => {
    const { server, asked, ghCalls } = tools({ answer: 'allowed' })
    for (const bad of [{ ...comment, owner: 'example-owner/../other' }, { ...comment, repo: '..' }, { ...comment, repo: 'a/b' }, { ...comment, number: 0 }, { ...comment, number: 1.5 },
      { ...comment, body: '   ' }, { ...comment, extra: true }, { ...comment, owner: '-X' }]) {
      expect((await server.call('admitted', GITHUB_COMMENT_TOOL, bad)).isError, JSON.stringify(bad)).toBe(true)
    }
    expect(asked).toEqual([])
    expect(ghCalls).toEqual([])
  })

  it('asks nobody when gh cannot post, and asks without a name when gh would not say who it is', async () => {
    for (const [signIn, words] of [
      [{ state: 'signed-out' }, 'gh is not signed in to GitHub on this computer, so a comment can\'t be posted. Ask the user to open Settings > Plugins. Nothing was changed.'],
      [{ state: 'not-installed' }, 'gh, GitHub\'s command line program, isn\'t installed on this computer, so a comment can\'t be posted. Ask the user to open Settings > Plugins. Nothing was changed.'],
    ] as const) {
      const { server, asked, ghCalls, recorded } = tools({ signIn, answer: 'allowed' })
      expect(said(await server.call('admitted', GITHUB_COMMENT_TOOL, comment))).toBe(words)
      expect([asked, ghCalls, recorded]).toEqual([[], [], []])
    }
    const unsure = tools({ signIn: { state: 'unknown' }, answer: 'denied' })
    await unsure.server.call('admitted', GITHUB_COMMENT_TOOL, comment)
    expect(unsure.asked).toEqual([{ kind: 'github-comment', ...comment }])
  })

  it('posts nothing when gh was switched to another account while the card waited', async () => {
    for (const [after, words] of [
      [{ state: 'signed-in', login: 'other-user' }, 'The user allowed a comment as example-user, but gh is now signed in to GitHub as other-user, so the comment was not posted. Call github_comment again if it should still be posted; the user will be asked again.'],
      [{ state: 'unknown' }, 'The user allowed a comment as example-user, but gh no longer says it is signed in to GitHub as that account, so the comment was not posted. Call github_comment again if it should still be posted; the user will be asked again.'],
    ] as const) {
      const { server, asked, ghCalls, recorded } = tools({ signIns: [{ state: 'signed-in', login: 'example-user' }, after], answer: 'allowed' })
      const result = await server.call('admitted', GITHUB_COMMENT_TOOL, comment)
      expect(result.isError).toBe(true)
      expect(said(result)).toBe(words)
      expect(asked).toHaveLength(1)
      expect(ghCalls).toEqual([])
      expect(recorded.map(use => use.outcome)).toEqual(['failed'])
    }
  })

  it('says the comment was not posted when GitHub will not take it, though the user allowed it', async () => {
    const { server, recorded } = tools({ answer: 'allowed', gh: new Error('gh: Validation Failed (HTTP 422)') })
    const result = await server.call('admitted', GITHUB_COMMENT_TOOL, comment)
    expect(said(result)).toBe('The user allowed it, but GitHub did not take the comment: gh: Validation Failed (HTTP 422). Nothing was posted.')
    expect(recorded).toEqual([{ threadId: 'admitted', plugin: 'github', tool: GITHUB_COMMENT_TOOL, kind: 'comment', outcome: 'failed' }])
  })

  it('reads the deployment for its card, then cancels it on Vercel only once the user allows it', async () => {
    const { server, vercelCalls, asked, recorded, answer } = tools({ accounts: [WORK], vercel: (url, method) => method === 'GET'
      ? { body: { name: 'example-project', target: null, url: 'example-project-abc.vercel.app', readyState: 'BUILDING' } } : { body: { readyState: 'CANCELED' } } })
    const call = server.call('admitted', VERCEL_CANCEL_TOOL, { deploymentId: 'dpl_example1', teamId: 'team_example1' })
    await settle()
    expect(asked).toEqual([{ kind: 'vercel-cancel', account: 'Work', deploymentId: 'dpl_example1', teamId: 'team_example1', project: 'example-project', target: 'preview', url: 'example-project-abc.vercel.app', state: 'BUILDING' }])
    // Only the read for the card has gone to Vercel.
    expect(vercelCalls).toEqual([{ url: 'https://api.vercel.com/v13/deployments/dpl_example1?teamId=team_example1', method: 'GET', authorization: `Bearer ${TOKEN}` }])
    answer('allowed')
    const result = await call
    expect(said(result)).toBe("The user allowed it, and the deployment's build is cancelled (CANCELED).")
    expect(vercelCalls[1]).toEqual({ url: 'https://api.vercel.com/v12/deployments/dpl_example1/cancel?teamId=team_example1', method: 'PATCH', authorization: `Bearer ${TOKEN}` })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(recorded).toEqual([{ threadId: 'admitted', plugin: 'vercel', accountId: WORK.id, tool: VERCEL_CANCEL_TOOL, kind: 'deployment-cancel', outcome: 'done' }])
  })

  it('cancels nothing on Vercel when the user says no, and says a finished deployment was too late to cancel', async () => {
    const denied = tools({ accounts: [WORK], answer: 'denied' })
    expect(said(await denied.server.call('admitted', VERCEL_CANCEL_TOOL, { deploymentId: 'dpl_example1' }))).toBe('The user said no. Nothing was changed. Do not ask again unless they tell you to.')
    expect(denied.vercelCalls.map(call => call.method)).toEqual(['GET'])
    expect(denied.recorded.map(use => use.outcome)).toEqual(['denied'])
    const late = tools({ accounts: [WORK], answer: 'allowed', vercel: (_url, method) => method === 'PATCH' ? { status: 400, body: { error: { code: 'bad_request' } } } : { body: {} } })
    expect(said(await late.server.call('admitted', VERCEL_CANCEL_TOOL, { deploymentId: 'dpl_example1' }))).toBe('The user allowed it, but Vercel would not cancel the build: bad_request (HTTP 400). A deployment whose build has already finished cannot be cancelled. Nothing was changed.')
    expect(late.recorded.map(use => use.outcome)).toEqual(['failed'])
  })

  it('turns away a deployment that is not named as Vercel names them, or an account that is not there, before asking', async () => {
    const { server, asked, vercelCalls } = tools({ accounts: [WORK], answer: 'allowed' })
    for (const bad of [{ deploymentId: 'example' }, { deploymentId: 'dpl_../v2/user' }, { deploymentId: 'dpl_example1', teamId: 'example' }, { deploymentId: 'dpl_example1', account: 'Other' }]) {
      expect((await server.call('admitted', VERCEL_CANCEL_TOOL, bad)).isError, JSON.stringify(bad)).toBe(true)
    }
    expect((await tools({ answer: 'allowed' }).server.call('admitted', VERCEL_CANCEL_TOOL, { deploymentId: 'dpl_example1' })).isError).toBe(true)
    expect(asked).toEqual([])
    expect(vercelCalls).toEqual([])
  })

  it('stops the card when the client gives up on the call, so a later Allow posts nothing', async () => {
    const requests = new PluginChangeRequests()
    const { server, ghCalls, recorded } = tools({ requests })
    const endpoint = (await server.mcpServer('admitted'))!
    const client = new AbortController()
    const call = fetch(endpoint.url, { method: 'POST', signal: client.signal,
      headers: { 'Content-Type': 'application/json', ...Object.fromEntries(endpoint.headers.map(header => [header.name, header.value])) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: GITHUB_COMMENT_TOOL, arguments: comment } }) }).catch(() => 'gone')
    await vi.waitFor(() => { expect(requests.requests().get('admitted')).toHaveLength(1) })
    const { id } = requests.requests().get('admitted')![0]!
    // The turn is stopped: the client drops the call while the card waits.
    client.abort()
    await expect(call).resolves.toBe('gone')
    await vi.waitFor(() => { expect(requests.requests().size).toBe(0) })
    expect(() => requests.answer('admitted', id, true)).toThrow('This request is no longer pending. Refresh the thread.')
    expect(ghCalls).toEqual([])
    expect(recorded).toEqual([])
  })

  it('posts nothing when the client went away as the user allowed it', async () => {
    const client = new AbortController()
    const { server, ghCalls, answer } = tools()
    const call = server.call('admitted', GITHUB_COMMENT_TOOL, comment, { signal: client.signal })
    await settle()
    client.abort()
    answer('allowed')
    const result = await call
    expect(said(result)).toBe('The request was stopped before it was answered. Nothing was changed.')
    expect(ghCalls).toEqual([])
  })

  it('ends the card before a client’s declared wait runs out, with room left to make the change, and asks nobody when there is no room', async () => {
    // Muse waits 300 seconds for a call: the card may wait four minutes of it at most, less what the call has used.
    const muse = tools({ answer: 'denied' })
    await muse.server.call('admitted', GITHUB_COMMENT_TOOL, comment, { waitMs: 300_000 })
    expect(muse.waits).toHaveLength(1)
    expect(muse.waits[0]!.waitMs).toBeLessThanOrEqual(240_000)
    expect(muse.waits[0]!.waitMs).toBeGreaterThan(200_000)
    // A client that says nothing of its wait gets the usual one.
    const plain = tools({ answer: 'denied' })
    await plain.server.call('admitted', GITHUB_COMMENT_TOOL, comment)
    expect(plain.waits).toEqual([{}])
    // A client that waits a minute cannot hold a card and the change after it.
    const short = tools({ answer: 'allowed' })
    const result = await short.server.call('admitted', GITHUB_COMMENT_TOOL, comment, { waitMs: 60_000 })
    expect(said(result)).toBe('This client does not wait long enough for a change that asks the user first, so the user was not asked. Nothing was changed.')
    expect([short.asked, short.ghCalls, short.recorded]).toEqual([[], [], []])
  })

  it('says a locked credential store before asking, and says unlock rather than replace when it locks after the answer', async () => {
    const locked = tools({ accounts: [WORK], answer: 'allowed', described: 'locked' })
    expect(said(await locked.server.call('admitted', VERCEL_CANCEL_TOOL, { deploymentId: 'dpl_example1' })))
      .toBe('Sotto could not read the token for the Vercel account "Work", because this computer’s credential store is locked. Ask the user to unlock it, then try again. Nothing was changed.'.replace('’', "'"))
    expect([locked.asked, locked.vercelCalls, locked.recorded]).toEqual([[], [], []])
    const missing = tools({ accounts: [WORK], answer: 'allowed', described: 'no-secret' })
    expect(said(await missing.server.call('admitted', VERCEL_CANCEL_TOOL, { deploymentId: 'dpl_example1' })))
      .toBe('Sotto no longer holds the token for the Vercel account "Work". Ask the user to replace it in Settings > Plugins. Nothing was changed.')
    expect(missing.asked).toEqual([])
    const after = tools({ accounts: [WORK], answer: 'allowed', cancelled: { ok: false, reason: 'locked' } })
    expect(said(await after.server.call('admitted', VERCEL_CANCEL_TOOL, { deploymentId: 'dpl_example1' })))
      .toBe('The user allowed it, but Sotto could not read the token for the Vercel account "Work", because this computer’s credential store is locked. Ask the user to unlock it, then try again. Nothing was changed.'.replace('’', "'"))
    expect(after.recorded.map(use => use.outcome)).toEqual(['failed'])
  })

  it('waits longer for a change than its card can stay up, so a client does not give up first', () => {
    expect(tools().server.timeoutMs).toBeGreaterThan(5 * 60_000)
  })
})

describe('a change’s card, in plain words (ADR-0185)', () => {
  it('shows where a comment goes and all of it, on buttons that say what a press does', () => {
    expect(wordPluginChange({ kind: 'github-comment', ...comment, account: 'example-user' })).toEqual({
      plugin: 'GitHub', text: 'Post this comment on example-owner/example-repo #12 on GitHub, as example-user?', action: 'Comment on GitHub as example-user',
      target: 'example-owner/example-repo #12', details: 'Looks good to me.', allow: 'Post the comment', deny: 'Don’t post it',
    })
  })

  it('says so when gh would not name the account that posts', () => {
    expect(wordPluginChange({ kind: 'github-comment', ...comment })).toMatchObject({ text: 'Post this comment on example-owner/example-repo #12 on GitHub, as the account gh is signed in to?', action: 'Comment on GitHub' })
  })

  it('names a deployment by what Vercel says of it, and never offers a button called Cancel on a card that cancels', () => {
    const card = wordPluginChange({ kind: 'vercel-cancel', account: 'Work', deploymentId: 'dpl_example1', project: 'example-project', target: 'preview', url: 'example-project-abc.vercel.app', state: 'BUILDING' })
    expect(card).toMatchObject({ plugin: 'Vercel', text: 'Cancel the build of example-project on Vercel?', action: 'Cancel a deployment on Vercel', target: 'example-project', allow: 'Cancel the build', deny: 'Leave it running' })
    expect(card.details.split('\n')).toEqual(['Project: example-project', 'Kind: preview', 'Address: example-project-abc.vercel.app', 'Its build now: BUILDING', 'Deployment: dpl_example1', 'Vercel account: Work',
      'A cancelled build cannot be picked up again. It has to be deployed again.'])
    // With nothing readable from Vercel, the card shows the ID alone rather than a guess.
    const bare = wordPluginChange({ kind: 'vercel-cancel', account: 'Work', deploymentId: 'dpl_example1' })
    expect(bare.target).toBe('dpl_example1')
    expect(bare.details.split('\n')[0]).toBe('Deployment: dpl_example1')
    // A team the agent named is sent with the call, so the card shows it.
    expect(wordPluginChange({ kind: 'vercel-cancel', account: 'Work', deploymentId: 'dpl_example1', teamId: 'team_example1' }).details.split('\n').slice(0, 2)).toEqual(['Deployment: dpl_example1', 'Team: team_example1'])
  })
})

describe('the changes themselves', () => {
  it('keeps a comment’s words out of gh’s arguments, and hands back only an address on github.com', async () => {
    const calls: { args: readonly string[]; stdin: string | undefined }[] = []
    const run = (answer: string): RunGitCommand => async (_cwd, _command, args, options?: GitCommandOptions) => { calls.push({ args, stdin: options?.stdin }); return answer }
    const body = '--method DELETE\n@/etc/passwd\n-F x=@secret'
    await expect(commentOnGitHub(run('{"html_url":"https://example.com/phish"}'), { ...comment, body })).resolves.toEqual({ ok: true, url: null })
    expect(calls[0]!.args.join(' ')).not.toContain('DELETE')
    expect(calls[0]!.args.join(' ')).not.toContain('passwd')
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({ body })
    await expect(commentOnGitHub(run('not json'), comment)).resolves.toEqual({ ok: true, url: null })
  })

  it('keeps Vercel’s token in the header alone, and takes it out of anything Vercel says back', async () => {
    const seen: string[] = []
    const fetcher = (status: number, body: unknown): VercelFetch => async (url, init) => { seen.push(url); expect(init.redirect).toBe('manual'); return new Response(JSON.stringify(body), { status }) }
    await expect(cancelVercelDeployment(fetcher(200, { readyState: `CANCELED ${TOKEN}` }), TOKEN, 'dpl_example1', undefined)).resolves.toEqual({ ok: true, state: 'CANCELED [removed by Sotto]' })
    await expect(cancelVercelDeployment(fetcher(500, { error: { code: 'internal_error', message: `Bearer ${TOKEN}` } }), TOKEN, 'dpl_example1', undefined)).resolves.toEqual({ ok: false, reason: 'failed', said: 'internal_error (HTTP 500)' })
    await expect(cancelVercelDeployment(fetcher(403, { error: { invalidToken: true } }), TOKEN, 'dpl_example1', undefined)).resolves.toEqual({ ok: false, reason: 'refused' })
    await expect(cancelVercelDeployment(vi.fn(), '', 'dpl_example1', undefined)).resolves.toEqual({ ok: false, reason: 'no-secret' })
    expect(seen.every(url => url.startsWith('https://api.vercel.com/v12/deployments/dpl_example1/cancel') && !url.includes(TOKEN))).toBe(true)
    // What Vercel says of a deployment is shown as one short plain line, whatever it holds.
    const odd = await describeVercelDeployment(fetcher(200, { name: 'line one\nline two' + 'x'.repeat(300), target: 'production', url: 7 }), TOKEN, 'dpl_example1', undefined)
    expect(odd).toEqual({ project: ('line oneline two' + 'x'.repeat(300)).slice(0, 120), target: 'production' })
    // A token Vercel echoes in a deployment's own words never reaches the card, even where the line is cut short.
    const echoed = await describeVercelDeployment(fetcher(200, { name: `${'y'.repeat(110)}${TOKEN}`, url: `${TOKEN}.vercel.app`, readyState: TOKEN, target: TOKEN }), TOKEN, 'dpl_example1', undefined)
    expect(JSON.stringify(echoed)).not.toContain(TOKEN.slice(0, 8))
    expect(echoed.url).toBe('[removed by Sotto].vercel.app')
  })
})
