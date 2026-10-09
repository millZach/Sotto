// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { TerminalShell } from '../../../src/main/terminals/shell'

it('shares replacement lookup when concurrent cached-shell validations disagree', async () => {
  const executableExists = vi.fn(async () => true)
  const shell = new TerminalShell({ platform: 'win32', env: { PATH: 'C:\\bin', SystemRoot: 'C:\\Windows' }, executableExists })
  expect(await shell.resolve()).toBe('C:\\bin\\pwsh.exe')
  const missing = Promise.withResolvers<boolean>(), present = Promise.withResolvers<boolean>()
  const replacement = Promise.withResolvers<boolean>(), entered = Promise.withResolvers<void>()
  executableExists.mockImplementationOnce(() => missing.promise)
    .mockImplementationOnce(() => present.promise)
    .mockImplementationOnce(() => { entered.resolve(); return replacement.promise })
  const resolutions = Promise.allSettled([shell.resolve(), shell.resolve()])
  try {
    missing.resolve(false)
    await entered.promise
    present.resolve(true)
  } finally { missing.resolve(false); present.resolve(true); replacement.resolve(false) }
  const fallback = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  expect(await resolutions).toEqual([{ status: 'fulfilled', value: fallback }, { status: 'fulfilled', value: fallback }])
  expect(executableExists).toHaveBeenCalledTimes(4)
  expect(await shell.resolve()).toBe(fallback)
  expect(executableExists).toHaveBeenCalledTimes(4)
})
