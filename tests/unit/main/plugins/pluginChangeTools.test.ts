// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commentOnGitHub, describeGitHubIssue, openGitHubIssue, setGitHubIssueState } from '../../../../src/main/plugins/github/changes'
import type { GitCommandOptions, RunGitCommand } from '../../../../src/main/agents/git/gitStatus'
import { wordPluginChange } from '../../../../src/main/plugins/changeWords'
import { PluginChangeRequests, type PluginChangeAnswer, type PluginChangeWait } from '../../../../src/main/plugins/pendingChanges'
import { PluginToolServer } from '../../../../src/main/plugins/pluginTools'
import type { PluginUseReport } from '../../../../src/main/plugins/useRecord'
import { cancelVercelDeployment, describeVercelDeployment, moveVercelProduction, type VercelChange, type VercelDescribed } from '../../../../src/main/plugins/vercel/changes'
import type { VercelFetch } from '../../../../src/main/plugins/vercel/read'
import { GITHUB_CLOSE_ISSUE_TOOL, GITHUB_COMMENT_TOOL, GITHUB_OPEN_ISSUE_TOOL, GITHUB_REOPEN_ISSUE_TOOL, PLUGIN_ACCOUNTS_TOOL, PLUGIN_READ_TOOL, VERCEL_CANCEL_TOOL, VERCEL_PROMOTE_TOOL, VERCEL_ROLLBACK_TOOL, type GitHubSignIn, type PluginAccount, type PluginChange } from '../../../../src/shared/plugins'
import { deferred } from '../../../fixtures/deferred'

const servers: PluginToolServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })

/** A made-up account and a made-up token: nothing here is a real credential. */
const WORK: PluginAccount = { id: '22222222-2222-4222-8222-000000000001', plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: 'example-user' }
const TOKEN = 'made-up-vercel-token'
const comment = { owner: 'example-owner', repo: 'example-repo', number: 12, body: 'Looks good to me.' }

/** The tools over a gh and a Vercel that keep what they were asked, with the user's answer in the test's hands. */
function tools(options: { watcher?: boolean; answer?: PluginChangeAnswer; signIn?: GitHubSignIn; signIns?: GitHubSignIn[]; accounts?: readonly PluginAccount[]; gh?: string | Error; vercel?: (url: string, method: string) => { status?: number; body?: unknown }
  /** What gh answers when it is asked about one issue before a change to it: GitHub's title, state and whether it is a pull request. */
  issue?: string | Error
  /** The real waiting asks, where a test answers or abandons a card as the app would. */
  requests?: PluginChangeRequests
  /** What main says of the account's token, where it cannot be read. */
  described?: VercelDescribed; cancelled?: VercelChange } = {}) {
  const ghCalls: { args: readonly string[]; stdin: string | undefined }[] = []
  const run: RunGitCommand = async (_cwd, _command, args, runOptions?: GitCommandOptions) => {
    ghCalls.push({ args, stdin: runOptions?.stdin })
    const answer = args.includes('--jq') ? options.issue ?? '{"title":"The preview build fails","state":"open","pullRequest":false}'
      : options.gh ?? '{"html_url":"https://github.com/example-owner/example-repo/issues/12#issuecomment-1"}'
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
    openGitHubIssue: input => openGitHubIssue(run, input),
    describeGitHubIssue: input => describeGitHubIssue(run, input),
    setGitHubIssueState: input => setGitHubIssueState(run, input),
    moveVercelProduction: async (_accountId, action, projectId, deploymentId, teamId) => options.cancelled ?? moveVercelProduction(fetcher, TOKEN, action, projectId, deploymentId, teamId),
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
      [{ state: 'signed-in', login: 'other-user' }, 'The user allowed it as example-user, but gh is now signed in to GitHub as other-user, so the comment was not posted. Call github_comment again if it should still be done; the user will be asked again.'],
      [{ state: 'unknown' }, 'The user allowed it as example-user, but gh no longer says it is signed in to GitHub as that account, so the comment was not posted. Call github_comment again if it should still be done; the user will be asked again.'],
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
    expect(said(result)).toBe('The user allowed it, but GitHub did not take the comment: gh: Validation Failed (HTTP 422). Nothing was changed.')
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

describe('the rest of the first plugin changes: issues on GitHub, production on Vercel (#2489)', () => {
  const place = { owner: 'example-owner', repo: 'example-repo' }
  /** The calls that changed something, apart from the reads gh was asked for before a card. */
  const writes = (calls: readonly { args: readonly string[]; stdin: string | undefined }[]) => calls.filter(call => !call.args.includes('--jq'))
  const DEPLOYMENT = { name: 'example-project', projectId: 'prj_example1', target: null, url: 'example-project-abc.vercel.app', readyState: 'READY' }

  it('opens an issue only once the user allows it, with its title and body on standard input', async () => {
    const { server, ghCalls, asked, recorded, answer } = tools({ gh: '{"html_url":"https://github.com/example-owner/example-repo/issues/13"}' })
    const issue = { ...place, title: 'The preview build fails', body: 'It stops at the install step.\nSee the log.' }
    const call = server.call('admitted', GITHUB_OPEN_ISSUE_TOOL, issue)
    await settle()
    expect(asked).toEqual([{ kind: 'github-open-issue', ...issue, account: 'example-user' }])
    expect(ghCalls).toEqual([])
    answer('allowed')
    expect(said(await call)).toBe('The user allowed it, and the issue is open: https://github.com/example-owner/example-repo/issues/13')
    expect(ghCalls).toEqual([{
      args: ['api', '--method', 'POST', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', 'repos/example-owner/example-repo/issues', '--input', '-'],
      stdin: JSON.stringify({ title: issue.title, body: issue.body }),
    }])
    expect(recorded).toEqual([{ threadId: 'admitted', plugin: 'github', tool: GITHUB_OPEN_ISSUE_TOOL, kind: 'issue-open', outcome: 'done' }])
    // An issue with no body sends a title alone, and one with no title asks nobody.
    const bare = tools({ answer: 'allowed' })
    await bare.server.call('admitted', GITHUB_OPEN_ISSUE_TOOL, { ...place, title: 'A title alone' })
    expect(bare.ghCalls[0]!.stdin).toBe('{"title":"A title alone"}')
    const untitled = tools({ answer: 'allowed' })
    expect((await untitled.server.call('admitted', GITHUB_OPEN_ISSUE_TOOL, { ...place, title: '   ', body: 'Words' })).isError).toBe(true)
    expect([untitled.asked, untitled.ghCalls]).toEqual([[], []])
  })

  it('reads an issue for its card, then closes it only once the user allows it, as completed unless told otherwise', async () => {
    const { server, ghCalls, asked, recorded, answer } = tools({ gh: '{"html_url":"https://github.com/example-owner/example-repo/issues/12"}' })
    const call = server.call('admitted', GITHUB_CLOSE_ISSUE_TOOL, { ...place, number: 12 })
    await settle()
    // The card names the issue by GitHub's own title for it, and only a read has gone to gh.
    expect(asked).toEqual([{ kind: 'github-close-issue', ...place, number: 12, title: 'The preview build fails', reason: 'completed', account: 'example-user' }])
    expect(ghCalls.map(entry => entry.args.slice(0, 3))).toEqual([['api', '--method', 'GET']])
    expect(ghCalls[0]!.args).toContain('repos/example-owner/example-repo/issues/12')
    answer('allowed')
    expect(said(await call)).toBe('The user allowed it, and the issue is closed: https://github.com/example-owner/example-repo/issues/12')
    expect(writes(ghCalls)).toEqual([{
      args: ['api', '--method', 'PATCH', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', 'repos/example-owner/example-repo/issues/12', '--input', '-'],
      stdin: '{"state":"closed","state_reason":"completed"}',
    }])
    expect(recorded).toEqual([{ threadId: 'admitted', plugin: 'github', tool: GITHUB_CLOSE_ISSUE_TOOL, kind: 'issue-close', outcome: 'done' }])
    const unplanned = tools({ answer: 'allowed' })
    await unplanned.server.call('admitted', GITHUB_CLOSE_ISSUE_TOOL, { ...place, number: 12, reason: 'not_planned' })
    expect(unplanned.asked[0]).toMatchObject({ reason: 'not_planned' })
    expect(writes(unplanned.ghCalls)[0]!.stdin).toBe('{"state":"closed","state_reason":"not_planned"}')
  })

  it('reopens a closed issue once the user allows it, and changes nothing when they say no', async () => {
    const closed = '{"title":"The preview build fails","state":"closed","pullRequest":false}'
    const allowed = tools({ answer: 'allowed', issue: closed })
    expect(said(await allowed.server.call('admitted', GITHUB_REOPEN_ISSUE_TOOL, { ...place, number: 12 }))).toContain('The user allowed it, and the issue is open again')
    expect(allowed.asked).toEqual([{ kind: 'github-reopen-issue', ...place, number: 12, title: 'The preview build fails', account: 'example-user' }])
    expect(writes(allowed.ghCalls).map(entry => entry.stdin)).toEqual(['{"state":"open"}'])
    expect(allowed.recorded.map(use => [use.kind, use.outcome])).toEqual([['issue-reopen', 'done']])
    const denied = tools({ answer: 'denied', issue: closed })
    expect(said(await denied.server.call('admitted', GITHUB_REOPEN_ISSUE_TOOL, { ...place, number: 12 }))).toBe('The user said no. Nothing was changed. Do not ask again unless they tell you to.')
    expect(writes(denied.ghCalls)).toEqual([])
    expect(denied.recorded.map(use => [use.kind, use.outcome])).toEqual([['issue-reopen', 'denied']])
    // A reason is for closing: reopening takes none.
    expect((await tools({ answer: 'allowed', issue: closed }).server.call('admitted', GITHUB_REOPEN_ISSUE_TOOL, { ...place, number: 12, reason: 'completed' })).isError).toBe(true)
  })

  it('never closes or reopens a pull request, an issue already in that state, or one GitHub will not show, and asks nobody', async () => {
    const pull = tools({ answer: 'allowed', issue: '{"title":"Fix the build","state":"open","pullRequest":true}' })
    const refused = await pull.server.call('admitted', GITHUB_CLOSE_ISSUE_TOOL, { ...place, number: 12 })
    expect(said(refused)).toBe('example-owner/example-repo #12 is a pull request, and this tool closes issues only. Nothing was changed.')
    expect(refused.isError).toBe(true)
    const already = tools({ answer: 'allowed', issue: '{"title":"Done","state":"closed","pullRequest":false}' })
    const same = await already.server.call('admitted', GITHUB_CLOSE_ISSUE_TOOL, { ...place, number: 12 })
    expect(said(same)).toBe('Issue example-owner/example-repo #12 is already closed, so the user was not asked. Nothing was changed.')
    expect(same.isError).toBeUndefined()
    const missing = tools({ answer: 'allowed', issue: new Error('gh: Not Found (HTTP 404)') })
    expect(said(await missing.server.call('admitted', GITHUB_REOPEN_ISSUE_TOOL, { ...place, number: 12 }))).toBe('GitHub would not show example-owner/example-repo #12: gh: Not Found (HTTP 404), so the user was not asked. Nothing was changed.')
    for (const each of [pull, already, missing]) {
      expect(each.asked).toEqual([])
      expect(writes(each.ghCalls)).toEqual([])
      expect(each.recorded).toEqual([])
    }
  })

  it('makes no issue change as an account the card did not name, or from Watcher', async () => {
    const switched = tools({ signIns: [{ state: 'signed-in', login: 'example-user' }, { state: 'signed-in', login: 'other-user' }], answer: 'allowed' })
    expect(said(await switched.server.call('admitted', GITHUB_CLOSE_ISSUE_TOOL, { ...place, number: 12 })))
      .toBe('The user allowed it as example-user, but gh is now signed in to GitHub as other-user, so the issue was not closed. Call github_close_issue again if it should still be done; the user will be asked again.')
    expect(writes(switched.ghCalls)).toEqual([])
    for (const tool of [GITHUB_OPEN_ISSUE_TOOL, GITHUB_CLOSE_ISSUE_TOOL, GITHUB_REOPEN_ISSUE_TOOL, VERCEL_PROMOTE_TOOL, VERCEL_ROLLBACK_TOOL]) {
      const watcher = tools({ watcher: true, answer: 'allowed', accounts: [WORK] })
      expect(said(await watcher.server.call('admitted', tool, tool.startsWith('vercel') ? { deploymentId: 'dpl_example1' } : { ...place, number: 12, title: 'A title' })))
        .toBe('Watcher reads from plugins and changes nothing through them. Start or steer a thread to make this change. Nothing was changed.')
      expect([watcher.asked, watcher.ghCalls, watcher.vercelCalls]).toEqual([[], [], []])
    }
  })

  it('reads a deployment for its card, then promotes it to production on Vercel only once the user allows it', async () => {
    const { server, vercelCalls, asked, recorded, answer } = tools({ accounts: [WORK], vercel: (_url, method) => method === 'GET' ? { body: DEPLOYMENT } : { status: 201, body: {} } })
    const call = server.call('admitted', VERCEL_PROMOTE_TOOL, { deploymentId: 'dpl_example1', teamId: 'team_example1' })
    await settle()
    expect(asked).toEqual([{ kind: 'vercel-promote', account: 'Work', deploymentId: 'dpl_example1', teamId: 'team_example1', project: 'example-project', projectId: 'prj_example1',
      target: 'preview', url: 'example-project-abc.vercel.app', state: 'READY' }])
    // Only the read for the card has gone to Vercel.
    expect(vercelCalls.map(entry => entry.method)).toEqual(['GET'])
    answer('allowed')
    const result = await call
    expect(said(result)).toBe('The user allowed it, and Vercel has taken the promotion: the project\'s production addresses move to the deployment within moments. Read the project to confirm.')
    expect(vercelCalls[1]).toEqual({ url: 'https://api.vercel.com/v10/projects/prj_example1/promote/dpl_example1?teamId=team_example1', method: 'POST', authorization: `Bearer ${TOKEN}` })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(recorded).toEqual([{ threadId: 'admitted', plugin: 'vercel', accountId: WORK.id, tool: VERCEL_PROMOTE_TOOL, kind: 'deployment-promote', outcome: 'done' }])
  })

  it('rolls production back on Vercel only once the user allows it, and says what Vercel does with new pushes afterwards', async () => {
    const { server, vercelCalls, asked, recorded } = tools({ accounts: [WORK], answer: 'allowed', vercel: (_url, method) => method === 'GET' ? { body: { ...DEPLOYMENT, target: 'production' } } : { status: 201, body: {} } })
    const result = await server.call('admitted', VERCEL_ROLLBACK_TOOL, { deploymentId: 'dpl_example1' })
    expect(asked[0]).toMatchObject({ kind: 'vercel-rollback', projectId: 'prj_example1', target: 'production' })
    expect(said(result)).toBe('The user allowed it, and Vercel has taken the rollback: the project\'s production addresses go back to the deployment within moments. Vercel now keeps new pushes to the production branch out of production until a deployment is promoted.')
    expect(vercelCalls.map(entry => [entry.method, entry.url])).toEqual([
      ['GET', 'https://api.vercel.com/v13/deployments/dpl_example1'], ['POST', 'https://api.vercel.com/v1/projects/prj_example1/rollback/dpl_example1']])
    expect(recorded.map(use => [use.tool, use.kind, use.outcome])).toEqual([[VERCEL_ROLLBACK_TOOL, 'deployment-rollback', 'done']])
  })

  it('moves production nowhere when the user says no, when the deployment cannot be read, or while Vercel is busy with another move', async () => {
    const denied = tools({ accounts: [WORK], answer: 'denied', vercel: () => ({ body: DEPLOYMENT }) })
    expect(said(await denied.server.call('admitted', VERCEL_PROMOTE_TOOL, { deploymentId: 'dpl_example1' }))).toBe('The user said no. Nothing was changed. Do not ask again unless they tell you to.')
    expect(denied.vercelCalls.map(entry => entry.method)).toEqual(['GET'])
    expect(denied.recorded.map(use => [use.kind, use.outcome])).toEqual([['deployment-promote', 'denied']])
    // With no project to name, there is nothing honest to put on a card that moves production.
    for (const unreadable of [{ status: 404, body: {} }, { body: { name: 'example-project' } }, { body: { ...DEPLOYMENT, projectId: 'prj_../../v2/user' } }]) {
      const blind = tools({ accounts: [WORK], answer: 'allowed', vercel: () => unreadable })
      expect(said(await blind.server.call('admitted', VERCEL_ROLLBACK_TOOL, { deploymentId: 'dpl_example1' })))
        .toBe('Sotto could not read that deployment from Vercel with the account "Work", so it cannot say which project\'s production would change, and the user was not asked. Check the deployment\'s ID, and give the "teamId" when it belongs to a team. Nothing was changed.')
      expect(blind.asked).toEqual([])
      expect(blind.vercelCalls.map(entry => entry.method)).toEqual(['GET'])
    }
    const busy = tools({ accounts: [WORK], answer: 'allowed', vercel: (_url, method) => method === 'GET' ? { body: DEPLOYMENT } : { status: 409, body: {} } })
    expect(said(await busy.server.call('admitted', VERCEL_PROMOTE_TOOL, { deploymentId: 'dpl_example1' })))
      .toBe('The user allowed it, but Vercel is still finishing another promotion or rollback for this project and refused this one. Nothing was changed. Call vercel_promote_deployment again shortly if it should still be done; the user will be asked again.')
    expect(busy.recorded.map(use => use.outcome)).toEqual(['failed'])
    const failed = tools({ accounts: [WORK], answer: 'allowed', vercel: (_url, method) => method === 'GET' ? { body: DEPLOYMENT } : { status: 402, body: { error: { code: 'payment_required', message: `Bearer ${TOKEN}` } } } })
    expect(said(await failed.server.call('admitted', VERCEL_ROLLBACK_TOOL, { deploymentId: 'dpl_example1' }))).toBe('The user allowed it, but Vercel did not roll production back: payment_required (HTTP 402). Nothing was changed.')
  })

  it('words each new card with what it does, what it acts on and buttons that say what a press does', () => {
    expect(wordPluginChange({ kind: 'github-open-issue', ...place, title: 'The preview build fails', body: 'It stops at the install step.', account: 'example-user' })).toEqual({
      plugin: 'GitHub', text: 'Open this issue in example-owner/example-repo on GitHub, as example-user?', action: 'Open an issue on GitHub as example-user',
      target: 'example-owner/example-repo', details: 'Title: The preview build fails\n\nIt stops at the install step.', allow: 'Open the issue', deny: 'Don’t open it',
    })
    expect(wordPluginChange({ kind: 'github-open-issue', ...place, title: 'A title alone', body: '' }).details).toBe('Title: A title alone')
    expect(wordPluginChange({ kind: 'github-close-issue', ...place, number: 12, title: 'The preview build fails', reason: 'not_planned', account: 'example-user' })).toEqual({
      plugin: 'GitHub', text: 'Close issue example-owner/example-repo #12 on GitHub, as example-user?', action: 'Close an issue on GitHub as example-user',
      target: 'example-owner/example-repo #12', details: 'Issue: The preview build fails\nClosed as: not planned', allow: 'Close the issue', deny: 'Leave it open',
    })
    expect(wordPluginChange({ kind: 'github-reopen-issue', ...place, number: 12, title: 'The preview build fails' })).toMatchObject({
      text: 'Reopen issue example-owner/example-repo #12 on GitHub, as the account gh is signed in to?', action: 'Reopen an issue on GitHub',
      details: 'Issue: The preview build fails', allow: 'Reopen the issue', deny: 'Leave it closed',
    })
    const moved = { account: 'Work', deploymentId: 'dpl_example1', teamId: 'team_example1', project: 'example-project', projectId: 'prj_example1', target: 'preview', url: 'example-project-abc.vercel.app', state: 'READY' }
    const promote = wordPluginChange({ kind: 'vercel-promote', ...moved })
    expect(promote).toMatchObject({ plugin: 'Vercel', text: 'Promote this deployment of example-project to production on Vercel?', action: 'Promote a deployment to production on Vercel',
      target: 'example-project', allow: 'Promote to production', deny: 'Leave production as it is' })
    expect(promote.details.split('\n')).toEqual(['Project: example-project (prj_example1)', 'Kind: preview', 'Address: example-project-abc.vercel.app', 'Its build now: READY', 'Deployment: dpl_example1',
      'Team: team_example1', 'Vercel account: Work', 'The project’s production addresses will serve this deployment. It is not built again.'])
    const rollback = wordPluginChange({ kind: 'vercel-rollback', ...moved, target: 'production' })
    expect(rollback).toMatchObject({ text: 'Roll production of example-project back to this deployment on Vercel?', action: 'Roll production back on Vercel', allow: 'Roll production back', deny: 'Leave production as it is' })
    expect(rollback.details.split('\n').slice(-2)).toEqual(['The project’s production addresses will serve this deployment again, at once.',
      'After a rollback, Vercel keeps new pushes to the production branch out of production until a deployment is promoted.'])
  })

  it('keeps what is sent to GitHub out of gh’s arguments, and shows an issue’s title as one plain line', async () => {
    const calls: { args: readonly string[]; stdin: string | undefined }[] = []
    const run = (answer: string): RunGitCommand => async (_cwd, _command, args, options?: GitCommandOptions) => { calls.push({ args, stdin: options?.stdin }); return answer }
    const title = '--method DELETE @/etc/passwd'
    await expect(openGitHubIssue(run('{"html_url":"https://example.com/phish"}'), { ...place, title, body: '-F x=@secret' })).resolves.toEqual({ ok: true, url: null })
    await expect(setGitHubIssueState(run('{}'), { ...place, number: 12, state: 'closed', reason: 'not_planned' })).resolves.toEqual({ ok: true, url: null })
    expect(calls.map(call => call.args.join(' ')).join(' ')).not.toMatch(/DELETE|passwd|secret|not_planned/u)
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({ title, body: '-F x=@secret' })
    // A place that is not a repository's, or a number that is not an issue's, never reaches gh.
    calls.length = 0
    await expect(openGitHubIssue(run('{}'), { owner: 'example-owner/..', repo: 'example-repo', title: 'A title', body: '' })).resolves.toEqual({ ok: false, reason: 'failed' })
    await expect(setGitHubIssueState(run('{}'), { ...place, number: 0, state: 'open' })).resolves.toEqual({ ok: false, reason: 'failed' })
    await expect(describeGitHubIssue(run('{}'), { ...place, number: 1.5 })).resolves.toEqual({ ok: false, reason: 'failed' })
    expect(calls).toEqual([])
    await expect(describeGitHubIssue(run(JSON.stringify({ title: `Line one\nline two ${'x'.repeat(300)}`, state: 'open', pullRequest: false })), { ...place, number: 12 }))
      .resolves.toEqual({ ok: true, title: `Line oneline two ${'x'.repeat(300)}`.slice(0, 200), state: 'open', pullRequest: false })
    // An answer that is not what was asked for is no description at all.
    for (const odd of ['not json', '{"title":"A title","state":"merged","pullRequest":false}', '{"title":7,"state":"open","pullRequest":false}', '{"title":"A title","state":"open"}']) {
      await expect(describeGitHubIssue(run(odd), { ...place, number: 12 }), odd).resolves.toEqual({ ok: false, reason: 'failed' })
    }
  })

  it('moves production on Vercel’s two documented paths, with the token in the header alone', async () => {
    const seen: { url: string; method: string }[] = []
    const fetcher = (status: number, body: unknown): VercelFetch => async (url, init) => { seen.push({ url, method: init.method }); expect(init.redirect).toBe('manual'); return new Response(JSON.stringify(body), { status }) }
    await expect(moveVercelProduction(fetcher(202, {}), TOKEN, 'promote', 'prj_example1', 'dpl_example1', undefined)).resolves.toEqual({ ok: true, state: null })
    await expect(moveVercelProduction(fetcher(201, {}), TOKEN, 'rollback', 'prj_example1', 'dpl_example1', 'team_example1')).resolves.toEqual({ ok: true, state: null })
    expect(seen).toEqual([{ url: 'https://api.vercel.com/v10/projects/prj_example1/promote/dpl_example1', method: 'POST' },
      { url: 'https://api.vercel.com/v1/projects/prj_example1/rollback/dpl_example1?teamId=team_example1', method: 'POST' }])
    await expect(moveVercelProduction(fetcher(409, {}), TOKEN, 'promote', 'prj_example1', 'dpl_example1', undefined)).resolves.toEqual({ ok: false, reason: 'busy' })
    await expect(moveVercelProduction(fetcher(403, { error: { invalidToken: true } }), TOKEN, 'rollback', 'prj_example1', 'dpl_example1', undefined)).resolves.toEqual({ ok: false, reason: 'refused' })
    await expect(moveVercelProduction(fetcher(500, { error: { code: 'internal_error', message: TOKEN } }), TOKEN, 'promote', 'prj_example1', 'dpl_example1', undefined)).resolves.toEqual({ ok: false, reason: 'failed', said: 'internal_error (HTTP 500)' })
    // A project that is not named as Vercel names them, or no token, sends nothing.
    seen.length = 0
    await expect(moveVercelProduction(fetcher(201, {}), TOKEN, 'promote', 'prj_../v2/user', 'dpl_example1', undefined)).resolves.toEqual({ ok: false, reason: 'failed' })
    await expect(moveVercelProduction(fetcher(201, {}), '', 'promote', 'prj_example1', 'dpl_example1', undefined)).resolves.toEqual({ ok: false, reason: 'no-secret' })
    expect(seen).toEqual([])
  })
})
