// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PiHost } from '../../src/main/agents/pi'
import { PiSignIn } from '../../src/main/agents/piSignIn'
import { PI_SOURCES } from '../../src/shared/piSignIn'

it.skipIf(process.env.SOTTO_PI_LIVE !== '1')('uses the installed Pi hidden terminal for key login, model discovery, logout and a cancelled device login', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-pi-sign-in-live-'))
  const host = new PiHost(root)
  const service = new PiSignIn(host.accounts, { changed: () => host.accountsChanged(), openExternal: async () => { throw new Error('The probe must not open a browser.') } })
  try {
    expect((await service.signInWithKey({ sourceId: 'openai', key: 'sotto-synthetic-probe-not-a-real-key' })).status).toBe('ok')
    const signed = await service.sources()
    expect(signed.status === 'ok' && signed.sources.find(source => source.id === 'openai')!.models > 0).toBe(true)
    expect((await service.signOut({ sourceId: 'openai' })).status).toBe('ok')
    const out = await service.sources()
    expect(out.status === 'ok' && out.sources.find(source => source.id === 'openai')!.signedIn).toBeUndefined()
    const started = await service.startBrowserSignIn({ sourceId: 'openai-codex', methodId: 'browser' })
    expect(started.status).toBe('waiting')
    if (started.status === 'waiting') {
      expect(started.attempt.mode).toBe('auto')
      expect(Boolean(started.attempt.code)).toBe(true)
      expect((await service.cancel({ attemptId: started.attempt.id })).status).toBe('ok')
    }
  } finally { await service.close(); host.disconnect(); await host.closed(); await rm(root, { recursive: true, force: true }) }
})

it.skipIf(process.env.SOTTO_PI_LIVE !== '1').each(PI_SOURCES.filter(source => source.oauthLabel))('reads and cancels the installed Pi $id account flow without opening a browser', { timeout: 45_000 }, async source => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-pi-account-flow-'))
  const host = new PiHost(root)
  const service = new PiSignIn(host.accounts, { changed: () => host.accountsChanged(), openExternal: async () => { throw new Error('The probe must not open a browser.') } })
  try {
    const started = await service.startBrowserSignIn({ sourceId: source.id, methodId: 'browser' })
    expect(started.status).toBe('waiting')
    if (started.status !== 'waiting') return
    expect(source.hosts).toContain(started.attempt.page)
    expect(started.attempt.mode).toBe(source.mode)
    if (!['anthropic', 'openai', 'openrouter'].includes(source.id)) expect(started.attempt.code).toBeTruthy()
    expect((await service.cancel({ attemptId: started.attempt.id })).status).toBe('ok')
  } finally { await service.close(); host.disconnect(); await host.closed(); await rm(root, { recursive: true, force: true }) }
})
