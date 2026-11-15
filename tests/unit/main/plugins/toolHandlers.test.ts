// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { PluginSecretLocked } from '../../../../src/main/plugins/accounts'
import { pluginToolHandlers, type PluginToolWiring } from '../../../../src/main/plugins/toolHandlers'
import type { VercelFetch } from '../../../../src/main/plugins/vercel/read'
import { pluginAccountAdmits, type PluginAccount } from '../../../../src/shared/plugins'

/** Made-up accounts and a made-up token: nothing here is a real credential. */
const WORK: PluginAccount = { id: '22222222-2222-4222-8222-000000000001', plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: 'example-user', on: true, projects: null }
const SITE: PluginAccount = { ...WORK, id: '22222222-2222-4222-8222-000000000002', name: 'Site', projects: ['folder:site'] }
const OFF: PluginAccount = { ...WORK, id: '22222222-2222-4222-8222-000000000003', name: 'Off', on: false }
const TOKEN = 'made-up-vercel-token'

/** The handlers a computer builds, over three accounts, for threads in the project named by `projects`. */
function handlers(options: { secret?: () => string; projects?: Readonly<Record<string, string | null>> } = {}) {
  const sent: { method: string; url: string; authorization: string | undefined }[] = []
  const vercelFetch: VercelFetch = async (url, init) => {
    sent.push({ method: init.method, url, authorization: init.headers['Authorization'] })
    return new Response(JSON.stringify({ readyState: 'CANCELED' }), { status: 200 })
  }
  const held = [WORK, SITE, OFF]
  const wiring: PluginToolWiring = {
    admits: () => true,
    accounts: {
      list: async () => held,
      find: async (_plugin, name, admits = () => true) => held.filter(admits).find(account => account.name === name) ?? (held.some(account => account.name === name) ? 'withheld' : 'unknown'),
      secret: options.secret ?? (() => TOKEN),
    },
    projectOf: threadId => options.projects?.[threadId] ?? null,
    isWatcher: () => false, askChange: async () => 'denied', record: async () => undefined,
    gitHubSignIn: async () => ({ state: 'signed-in', login: 'example-user' }),
    gh: async () => '[]', vercelFetch, vercelOptions: { base: 'http://127.0.0.1:9', signal: new AbortController().signal },
  }
  return { tools: pluginToolHandlers(wiring), sent }
}

describe('the plugin tools’ handlers, as the desktop and a paired host both build them (ADR-0205)', () => {
  it('hands a thread the accounts that are on and for its project, and a thread in no project those for every project', async () => {
    const { tools } = handlers({ projects: { 'in-site': 'folder:site', 'in-other': 'folder:other' } })
    expect((await tools.accounts('in-site')).map(account => account.name)).toEqual(['Work', 'Site'])
    expect((await tools.accounts('in-other')).map(account => account.name)).toEqual(['Work'])
    // A host asks no thread for a project, as a thread in none: a copy that names projects is not its to use.
    expect((await tools.accounts('on-a-host')).map(account => account.name)).toEqual(['Work'])
    expect(await tools.findAccount('on-a-host', 'vercel', 'Site')).toBe('withheld')
    expect(await tools.findAccount('in-site', 'vercel', 'Site')).toEqual(SITE)
    expect(await tools.findAccount('in-site', 'vercel', 'Off')).toBe('withheld')
    // Whether an account is still there is asked of every account, whoever may use it.
    expect(await tools.holdsAccount(OFF.id)).toBe(true)
    expect(await tools.holdsAccount('22222222-2222-4222-8222-00000000000f')).toBe(false)
    // The rule is the one the page and the record use.
    expect(pluginAccountAdmits(SITE, null)).toBe(false)
  })

  it('sends an account’s token to Vercel for the call it is read for, and nothing where it cannot be read', async () => {
    const { tools, sent } = handlers()
    await expect(tools.cancelVercelDeployment(WORK.id, 'dpl_example1', undefined)).resolves.toEqual({ ok: true, state: 'CANCELED' })
    expect(sent).toEqual([{ method: 'PATCH', url: expect.stringContaining('/v12/deployments/dpl_example1/cancel'), authorization: `Bearer ${TOKEN}` }])

    // A locked credential store is said to be locked, and one that holds nothing for the account says so: neither sends.
    const locked = handlers({ secret: () => { throw new PluginSecretLocked() } })
    await expect(locked.tools.readVercel(WORK.id, 'v6/deployments', {})).resolves.toEqual({ ok: false, reason: 'locked' })
    await expect(locked.tools.describeVercelDeployment(WORK.id, 'dpl_example1', undefined)).resolves.toBe('locked')
    await expect(locked.tools.cancelVercelDeployment(WORK.id, 'dpl_example1', undefined)).resolves.toEqual({ ok: false, reason: 'locked' })
    await expect(locked.tools.moveVercelProduction(WORK.id, 'promote', 'prj_example1', 'dpl_example1', undefined)).resolves.toEqual({ ok: false, reason: 'locked' })
    expect(locked.sent).toEqual([])
    const gone = handlers({ secret: () => '' })
    await expect(gone.tools.readVercel(WORK.id, 'v6/deployments', {})).resolves.toEqual({ ok: false, reason: 'no-secret' })
    await expect(gone.tools.describeVercelDeployment(WORK.id, 'dpl_example1', undefined)).resolves.toBe('no-secret')
    await expect(gone.tools.cancelVercelDeployment(WORK.id, 'dpl_example1', undefined)).resolves.toEqual({ ok: false, reason: 'no-secret' })
    expect(gone.sent).toEqual([])
  })
})
