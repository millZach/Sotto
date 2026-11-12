// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { checkVercelToken, readVercel, REMOVED, VERCEL_READ_MAX_CHARS, vercelReadKind, vercelReadRefusal, withoutSecrets, type VercelFetch } from '../../../../src/main/plugins/vercel/read'

/** A made-up token: nothing here is a real credential. */
const TOKEN = 'made-up-vercel-token'

/** A stand-in for Vercel that answers every request the same way and keeps what it was asked. */
function vercel(answer: { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | Error) {
  const calls: { url: string; method: string; headers: Readonly<Record<string, string>>; redirect: string }[] = []
  const fetcher: VercelFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, redirect: init.redirect })
    if (answer instanceof Error) throw answer
    return new Response(answer.text ?? JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: answer.headers ?? {} })
  }
  return { fetcher, calls }
}

describe('reading Vercel with an account’s token (ADR-0205)', () => {
  it('makes a GET to api.vercel.com with the token in the header and nowhere else, and follows no redirect', async () => {
    const f = vercel({ body: { deployments: [{ uid: 'dpl_1', state: 'READY' }] } })
    await expect(readVercel(f.fetcher, TOKEN, 'v6/deployments', { limit: '5', teamId: 'team_example' })).resolves.toEqual({ ok: true, text: '{"deployments":[{"uid":"dpl_1","state":"READY"}]}', truncated: false })
    expect(f.calls).toEqual([{ url: 'https://api.vercel.com/v6/deployments?limit=5&teamId=team_example', method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }, redirect: 'manual' }])
    expect(f.calls[0]!.url).not.toContain(TOKEN)
  })

  it.each([
    ['/v6/deployments', 'a leading slash'],
    ['deployments', 'no version'],
    ['v6', 'a version and nothing after it'],
    ['v6/deployments?limit=1', 'a query in the path'],
    ['v6/../v2/user', 'a path that climbs'],
    ['v6/%2E%2E/v2/user', 'a path that climbs, spelled with percent signs'],
    ['v9/projects%2Fexample%2Fenv', 'a slash spelled with percent signs'],
    ['https://example.com/v6/deployments', 'another host'],
    ['v6//example.com/x', 'an empty part'],
    ['v6/deployments x', 'a space'],
  ])('refuses %j (%s) before anything is sent', async (path) => {
    const f = vercel({ body: {} })
    await expect(readVercel(f.fetcher, TOKEN, path)).resolves.toEqual({ ok: false, reason: 'path' })
    expect(f.calls).toEqual([])
  })

  it.each([
    'v10/projects/example/env',
    'v9/projects/example/env',
    'v1/projects/example/env/abc123',
    'v1/env',
    'v1/env/abc123',
    'v6/user/tokens',
    'v5/user/tokens/abc123',
    'v1/edge-config/ecfg_example/tokens',
    'v1/edge-config/ecfg_example/items',
    'v1/drains',
    'v1/webhooks',
    'v3/secrets',
    'v8/certs/cert_example',
    'v1/integrations/configuration/icfg_example',
    'v8/deployments/dpl_example/files/abc123',
    'v1/registrar/domains/example.com/auth-code',
    'v1/global-config/ecfg_example/items',
    'v1/global-config/ecfg_example/item/api_key',
    'v3/events',
    'v9/projects/example/ENV',
    'v9/projects/example/%65nv',
  ])('refuses %s, which can hand back other credentials, before anything is sent', async (path) => {
    const f = vercel({ body: {} })
    expect(vercelReadRefusal(path, {})).toBe('secrets')
    await expect(readVercel(f.fetcher, TOKEN, path)).resolves.toEqual({ ok: false, reason: 'secrets' })
    expect(f.calls).toEqual([])
  })

  it('refuses a query that asks for a secret in the clear, or for an answer that never ends', async () => {
    const f = vercel({ body: {} })
    await expect(readVercel(f.fetcher, TOKEN, 'v9/projects/example', { decrypt: 'true' })).resolves.toEqual({ ok: false, reason: 'secrets' })
    await expect(readVercel(f.fetcher, TOKEN, 'v9/projects/example', { Decrypt: '1' })).resolves.toEqual({ ok: false, reason: 'secrets' })
    await expect(readVercel(f.fetcher, TOKEN, 'v3/deployments/dpl_example/events', { follow: '1' })).resolves.toEqual({ ok: false, reason: 'secrets' })
    await expect(readVercel(f.fetcher, TOKEN, 'v6/deployments', { '-x': '1' })).resolves.toEqual({ ok: false, reason: 'query' })
    expect(f.calls).toEqual([])
  })

  it('takes every field that can hold another credential out of an allowed answer, and the user’s email address', async () => {
    const project = {
      id: 'prj_example', name: 'example',
      env: [{ key: 'DATABASE_URL', value: 'made-up-value', type: 'encrypted' }],
      protectionBypass: { 'made-up-bypass': { scope: 'automation-bypass' } },
      passwordProtection: { deploymentType: 'all' },
      link: { type: 'github', repo: 'example', deployHooks: [{ name: 'hook', url: 'https://example.com/made-up-hook' }], gitCredentialId: 'cred_example' },
      latestDeployments: [{ id: 'dpl_1', meta: { githubCommitMessage: 'Fix the build' }, oidcTokenClaims: { sub: 'example' } }],
      nested: [{ clientSecret: 'made-up', api_key: 'made-up', accessToken: 'made-up', authCode: 'made-up', inviteCode: 'made-up', newEnvVar: { key: 'A', value: 'made-up' }, statusCode: 200, ok: true }],
    }
    const f = vercel({ body: { project, user: { username: 'example-user', email: 'someone@example.com' } } })
    const result = await readVercel(f.fetcher, TOKEN, 'v9/projects/example')
    expect(result.ok && JSON.parse(result.text)).toEqual({
      project: {
        id: 'prj_example', name: 'example', env: REMOVED, protectionBypass: REMOVED, passwordProtection: REMOVED,
        link: { type: 'github', repo: 'example', deployHooks: REMOVED, gitCredentialId: REMOVED },
        latestDeployments: [{ id: 'dpl_1', meta: { githubCommitMessage: 'Fix the build' }, oidcTokenClaims: { sub: 'example' } }],
        nested: [{ clientSecret: REMOVED, api_key: REMOVED, accessToken: REMOVED, authCode: REMOVED, inviteCode: REMOVED, newEnvVar: REMOVED, statusCode: 200, ok: true }],
      },
      user: { username: 'example-user', email: REMOVED },
    })
    expect(result.ok && result.text).not.toMatch(/made-up|someone@example\.com/u)
    expect(withoutSecrets('plain')).toBe('plain')
  })

  it('refuses an answer it cannot check for credentials, and never follows Vercel to another address', async () => {
    await expect(readVercel(vercel({ text: 'plain text log with a made-up-value' }).fetcher, TOKEN, 'v3/deployments/dpl_example/events'))
      .resolves.toEqual({ ok: false, reason: 'failed', said: 'the answer was not JSON, so Sotto could not check it for credentials' })
    const moved = vercel({ status: 302, headers: { location: 'https://example.com/elsewhere' } })
    await expect(readVercel(moved.fetcher, TOKEN, 'v2/user')).resolves.toEqual({ ok: false, reason: 'failed', said: 'Vercel sent the read to another address, which Sotto does not follow' })
    expect(moved.calls).toHaveLength(1)
  })

  it('tells a token Vercel will not take from a read the token may not make, and from a Vercel that cannot be reached', async () => {
    await expect(readVercel(vercel({ status: 401, body: { error: { code: 'unauthorized', message: 'Not authorized' } } }).fetcher, TOKEN, 'v2/user')).resolves.toEqual({ ok: false, reason: 'refused' })
    await expect(readVercel(vercel({ status: 403, body: { error: { code: 'forbidden', message: 'Not authorized', invalidToken: true } } }).fetcher, TOKEN, 'v2/user')).resolves.toEqual({ ok: false, reason: 'refused' })
    await expect(readVercel(vercel({ status: 403, body: { error: { code: 'forbidden', message: 'You do not have permission to access this resource.' } } }).fetcher, TOKEN, 'v9/projects'))
      .resolves.toEqual({ ok: false, reason: 'failed', said: 'forbidden (HTTP 403)' })
    await expect(readVercel(vercel({ status: 429, text: 'slow down' }).fetcher, TOKEN, 'v6/deployments')).resolves.toEqual({ ok: false, reason: 'failed', said: 'HTTP 429' })
    await expect(readVercel(vercel(new Error('getaddrinfo ENOTFOUND api.vercel.com')).fetcher, TOKEN, 'v6/deployments')).resolves.toEqual({ ok: false, reason: 'unreachable' })
    // An account whose token is gone sends nothing.
    const none = vercel({ body: {} })
    await expect(readVercel(none.fetcher, '', 'v6/deployments')).resolves.toEqual({ ok: false, reason: 'no-secret' })
    expect(none.calls).toEqual([])
  })

  it('never hands back the token it read with, wherever a service puts it', async () => {
    // In an error's own words: only Vercel's short code is passed on, never its message.
    const echoed = await readVercel(vercel({ status: 400, body: { error: { code: 'bad_request', message: `Bearer ${TOKEN} is malformed` } } }).fetcher, TOKEN, 'v6/deployments')
    expect(echoed).toEqual({ ok: false, reason: 'failed', said: 'bad_request (HTTP 400)' })
    // As the code itself, or a code that is not a short plain word: the status alone.
    const asCode = await readVercel(vercel({ status: 400, body: { error: { code: TOKEN } } }).fetcher, TOKEN, 'v6/deployments')
    expect(JSON.stringify(asCode)).not.toContain(TOKEN)
    // In an ordinary field of a good answer.
    const inside = await readVercel(vercel({ body: { note: `seen ${TOKEN} here`, list: [TOKEN] } }).fetcher, TOKEN, 'v6/deployments')
    expect(inside).toEqual({ ok: true, text: `{"note":"seen ${REMOVED} here","list":["${REMOVED}"]}`, truncated: false })
  })

  it('cuts a long answer and says so', async () => {
    const result = await readVercel(vercel({ body: { log: 'x'.repeat(VERCEL_READ_MAX_CHARS) } }).fetcher, TOKEN, 'v6/deployments')
    expect(result).toMatchObject({ ok: true, truncated: true })
    expect(result.ok && result.text.length).toBe(VERCEL_READ_MAX_CHARS)
  })

  it('takes only the origin of a stand-in address a test gives it', async () => {
    const f = vercel({ body: {} })
    await readVercel(f.fetcher, TOKEN, 'v6/deployments', {}, { base: 'http://127.0.0.1:4010/ignored/path' })
    expect(f.calls[0]!.url).toBe('http://127.0.0.1:4010/v6/deployments')
  })

  it('names the kind of thing a path reads, never which one', () => {
    expect(vercelReadKind('v6/deployments')).toBe('deployments')
    expect(vercelReadKind('v13/deployments/dpl_example')).toBe('deployments')
    expect(vercelReadKind('v3/deployments/dpl_example/events')).toBe('logs')
    // A deployment's build log is still read; only the account's own activity log is refused.
    expect(vercelReadRefusal('v3/deployments/dpl_example/events', {})).toBeNull()
    expect(vercelReadKind('v9/projects/example')).toBe('projects')
    expect(vercelReadKind('v5/domains')).toBe('domains')
    expect(vercelReadKind('v2/user')).toBe('account')
    expect(vercelReadKind('v2/teams')).toBe('account')
    expect(vercelReadKind('v1/something-else')).toBe('other')
  })
})

describe('checking a Vercel token before it is kept', () => {
  it('asks Vercel who the token belongs to and keeps the username alone', async () => {
    const f = vercel({ body: { user: { id: 'u_1', username: 'example-user', email: 'someone@example.com', name: 'Someone' } } })
    await expect(checkVercelToken(f.fetcher, TOKEN)).resolves.toEqual({ ok: true, signedInAs: 'example-user' })
    expect(f.calls).toEqual([{ url: 'https://api.vercel.com/v2/user', method: 'GET', headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }, redirect: 'manual' }])
  })

  it('says refused for a token Vercel will not take, and unreachable when Vercel could not be asked', async () => {
    await expect(checkVercelToken(vercel({ status: 403, body: { error: { code: 'forbidden', invalidToken: true } } }).fetcher, TOKEN)).resolves.toEqual({ ok: false, problem: 'refused' })
    await expect(checkVercelToken(vercel({ status: 403, body: { error: { code: 'forbidden', missingToken: true } } }).fetcher, TOKEN)).resolves.toEqual({ ok: false, problem: 'refused' })
    // A token scoped to a team or a project may not read the account, and is good all the same.
    await expect(checkVercelToken(vercel({ status: 403, body: { error: { code: 'forbidden', message: 'Not authorized' } } }).fetcher, TOKEN)).resolves.toEqual({ ok: true, signedInAs: null })
    await expect(checkVercelToken(vercel({ status: 404, body: { error: { code: 'not_found' } } }).fetcher, TOKEN)).resolves.toEqual({ ok: true, signedInAs: null })
    // Vercel turning requests away for now is neither a bad token nor a lost connection.
    await expect(checkVercelToken(vercel({ status: 429, body: { error: { code: 'rate_limited' } } }).fetcher, TOKEN)).resolves.toEqual({ ok: false, problem: 'busy' })
    await expect(checkVercelToken(vercel({ status: 401, body: {} }).fetcher, TOKEN)).resolves.toEqual({ ok: false, problem: 'refused' })
    await expect(checkVercelToken(vercel({ status: 500, body: {} }).fetcher, TOKEN)).resolves.toEqual({ ok: false, problem: 'unreachable' })
    await expect(checkVercelToken(vercel({ status: 302, headers: { location: 'https://example.com' } }).fetcher, TOKEN)).resolves.toEqual({ ok: false, problem: 'unreachable' })
    await expect(checkVercelToken(vercel(new Error('offline')).fetcher, TOKEN)).resolves.toEqual({ ok: false, problem: 'unreachable' })
    // A good token whose answer names nobody is still good.
    await expect(checkVercelToken(vercel({ body: { user: { username: '<script>' } } }).fetcher, TOKEN)).resolves.toEqual({ ok: true, signedInAs: null })
  })
})
