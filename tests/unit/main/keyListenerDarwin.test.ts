// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) }
})

const sourcePath = join(__dirname, '../../../native/key-listener/darwin.swift')
const fileSource = readFileSync(sourcePath, 'utf8')

describe.each([
  ['LF', '\n'],
  ['CRLF', '\r\n'],
])('macOS native paste protocol (%s)', (_name, newline) => {
  vi.mocked(readFileSync).mockReturnValueOnce(fileSource.replace(/\r?\n/g, newline))
  const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n')
  const paste = source.slice(source.indexOf('func paste(_ id:'), source.indexOf('func command('))
  const layout = source.slice(source.indexOf('func pasteKeyCode()'), source.indexOf('func paste(_ id:'))

  it('advertises the version and acknowledges only validated request IDs', () => {
    expect(source).toContain('emit("capability paste-v1")')
    expect(source).toContain('if parts.count == 2, let id = UInt64(parts[1]), id > 0 { paste(String(id)) }')
    expect(paste).toContain('emit("paste \\(id) not-sent")')
    expect(paste).toContain('emit("paste \\(id) dispatched")')
  })

  it('resolves the current layout with Command and the keyboard type, without dead keys or a US keycode', () => {
    expect(layout).toContain('TISCopyCurrentKeyboardLayoutInputSource()')
    expect(layout).toContain('kTISPropertyUnicodeKeyLayoutData')
    expect(layout).toContain('UInt32(LMGetKbdType())')
    expect(layout).toContain('UInt32(cmdKey >> 8)')
    expect(layout).toContain('kUCKeyTranslateNoDeadKeysMask')
    expect(layout).not.toMatch(/return (?:9|0x0?9)\b/u)
    expect(paste).toContain('let code = pasteKeyCode()')
  })

  it('preflights without prompting and creates both private events before consecutive posts and ACK', () => {
    expect(paste).toContain('CGPreflightPostEventAccess()')
    expect(paste).not.toContain('CGRequestPostEventAccess')
    expect(paste).toContain('CGEventSource(stateID: .privateState)')
    const up = paste.indexOf('keyDown: false)')
    const post = paste.indexOf('down.post(')
    expect(up).toBeGreaterThan(0)
    expect(post).toBeGreaterThan(up)
    expect(paste).toContain('down.flags = .maskCommand\n  up.flags = .maskCommand')
    expect(paste).toContain('down.post(tap: .cghidEventTap)\n  up.post(tap: .cghidEventTap)')
    expect(paste.indexOf('emit("paste \\(id) dispatched")')).toBeGreaterThan(post)
    expect(paste).not.toMatch(/sleep|asyncAfter|usleep/u)
  })

  it('keeps the synthetic-source filter ahead of shortcut handling', () => {
    const handle = source.slice(source.indexOf('func handle('), source.indexOf('func pasteKeyCode()'))
    expect(handle).toContain('event.getIntegerValueField(.eventSourceStateID) != hidSystemState')
    expect(handle).toContain('event.getIntegerValueField(.eventSourceUnixProcessID) != 0')
    expect(handle.indexOf('.eventSourceStateID')).toBeLessThan(handle.indexOf('switch type'))
  })
})
