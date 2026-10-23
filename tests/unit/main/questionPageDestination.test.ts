// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { questionPageDestination } from '../../../src/main/hosts/questionPageDestination'

// Opening a page on the desktop follows Web links in threads (ADR-0108): the system browser opens a file as a file and an
// address as an address, as before; Sotto's browser opens an address as it is, and a file through the phone access
// listener's loopback address under its token, since it opens no file:// pages. With no listener, the file opens in the
// system browser.

const token = 't'.repeat(32)
const file = { kind: 'file' as const, file: 'C:\\repo\\docs\\greeting.html', token, start: 'greeting%20page.html' }
const url = { kind: 'url' as const, url: 'http://localhost:8075/variants/a.html?variant=A' }

describe('questionPageDestination', () => {
  it('opens every page in the system browser when links go there, as before', () => {
    expect(questionPageDestination(file, 'external', 8123)).toEqual({ browser: 'system', kind: 'file', file: file.file })
    expect(questionPageDestination(url, 'external', 8123)).toEqual({ browser: 'system', kind: 'url', url: url.url })
  })

  it('opens an address in Sotto’s browser as it is, and a file through the listener under its token', () => {
    expect(questionPageDestination(url, 'embedded', undefined)).toEqual({ browser: 'sotto', url: url.url })
    expect(questionPageDestination(file, 'embedded', 8123)).toEqual({ browser: 'sotto', url: `http://127.0.0.1:8123/page/${token}/greeting%20page.html` })
  })

  it('opens a file in the system browser when phone access is off and no listener runs', () => {
    expect(questionPageDestination(file, 'embedded', undefined)).toEqual({ browser: 'system', kind: 'file', file: file.file })
  })
})
