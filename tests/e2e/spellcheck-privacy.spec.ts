import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'

test('spellcheck stays enabled and missing Hunspell dictionaries cannot reach a host', async () => {
  test.skip(process.platform === 'darwin', 'macOS uses its OS spellchecker without Hunspell')
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<textarea autofocus>spellcheck</textarea>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local browser page unavailable')
  const url = `http://127.0.0.1:${address.port}/`
  const launched = await launchSotto().catch(error => { server.close(); throw error })
  const logPath = join(launched.userData, 'spellcheck-network.json')
  try {
    await launched.page.evaluate(async url => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'connect' })
      const listed = await window.sotto!.browser!.list({ threadId: 'workshop' })
      if (!listed.ok) throw new Error('Browser workspace unavailable')
      const result = await window.sotto!.browser!.create({ threadId: 'workshop', workspaceId: listed.value.workspace.workspaceId, url })
      if (!result.ok) throw new Error('Browser page did not open')
    }, url)
    await expect.poll(() => launched.app.evaluate(({ webContents }, url) =>
      webContents.getAllWebContents().some(contents => contents.getURL() === url), url,
    )).toBe(true)
    const results = await launched.app.evaluate(async ({ netLog, session, webContents }, { logPath, url }) => {
      await netLog.startLogging(logPath)
      const browser = webContents.getAllWebContents().find(contents => contents.getURL() === url)!.session
      const results: { outcome: string; attempts: number; enabled: boolean }[] = []
      try {
        for (const target of [session.defaultSession, browser]) {
          let attempts = 0
          target.on('spellcheck-dictionary-download-begin', (_event, language) => { if (language === 'af') attempts += 1 })
          const outcome = new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Dictionary attempt did not settle')), 15_000)
            target.on('spellcheck-dictionary-download-failure', (_event, language) => { if (language === 'af') { clearTimeout(timeout); resolve('blocked') } })
            target.on('spellcheck-dictionary-download-success', (_event, language) => { if (language === 'af') { clearTimeout(timeout); resolve('downloaded') } })
          })
          // A fresh profile supplies no cached dictionary for this language.
          // Exercise the actual default and BrowserService sessions, whose
          // production configuration must block the request before any host.
          target.setSpellCheckerLanguages(['af'])
          results.push({ outcome: await outcome, attempts, enabled: target.isSpellCheckerEnabled() })
        }
        return results
      } finally {
        await netLog.stopLogging()
      }
    }, { logPath, url })
    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result).toMatchObject({ outcome: 'blocked', enabled: true })
      expect(result.attempts).toBeGreaterThan(0)
    }
    const log = JSON.parse(await readFile(logPath, 'utf8')) as { events: { params?: { url?: string } }[] }
    const dictionaryUrls = log.events.flatMap(event => event.params?.url ? [event.params.url] : [])
      .filter(url => url.includes('.bdic'))
    // Unsupported data URLs can fail before the network service records a URL.
    // The begin/failure events above establish that the dictionary was attempted.
    expect(dictionaryUrls.filter(url => !url.startsWith('data:,'))).toEqual([])
  } finally {
    await closeSotto(launched)
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
