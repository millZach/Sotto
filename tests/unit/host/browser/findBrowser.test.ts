// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { browserCandidates, findBrowser } from '../../../../src/host/browser/findBrowser'

describe('where a host looks for its browser (ADR-0198)', () => {
  it('tries the usual Linux installs first, then each PATH folder', () => {
    const candidates = browserCandidates({ platform: 'linux', home: '/home/zach', environment: { PATH: '/usr/local/bin:/home/zach/bin' } })
    expect(candidates.slice(0, 3)).toEqual(['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'])
    expect(candidates).toContain('/usr/local/bin/chromium')
    expect(candidates).toContain('/home/zach/bin/microsoft-edge')
    expect(new Set(candidates).size).toBe(candidates.length)
  })

  it('looks in Program Files and the account\'s own install on Windows, with Windows paths', () => {
    const candidates = browserCandidates({ platform: 'win32', home: 'C:\\Users\\zach', environment: { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\zach\\AppData\\Local', Path: 'C:\\Tools' } })
    expect(candidates[0]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    expect(candidates).toContain('C:\\Users\\zach\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe')
    expect(candidates).toContain('C:\\Tools\\chrome.exe')
  })

  it('looks in both Applications folders on a Mac', () => {
    const candidates = browserCandidates({ platform: 'darwin', home: '/Users/zach', environment: {} })
    expect(candidates[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(candidates).toContain('/Users/zach/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  })

  it('takes the first candidate that may be started, and finds none on a host without one', async () => {
    const tried: string[] = []
    const found = await findBrowser({ platform: 'linux', home: '/home/zach', environment: { PATH: '/usr/bin' }, accept: async candidate => { tried.push(candidate); return candidate === '/usr/bin/chromium' ? candidate : undefined } })
    expect(found).toBe('/usr/bin/chromium')
    expect(tried.slice(0, 3)).toEqual(['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'])
    await expect(findBrowser({ platform: 'linux', home: '/home/zach', environment: {}, accept: async () => undefined })).resolves.toBeUndefined()
  })
})
