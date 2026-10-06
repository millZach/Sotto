// @vitest-environment node
import { access } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, it, vi } from 'vitest'

const { compile } = vi.hoisted(() => ({ compile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: compile }))
import { AskpassBroker } from '../../../src/main/hosts/sshAskpass'

it('explains when the Windows helper cannot be prepared and removes its folder', async () => {
  compile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error) => void) => callback(new Error('Compiler did not start')))
  const result = await AskpassBroker.start(async () => null, { platform: 'win32', node: process.execPath }).then(async broker => { await broker.close(); return undefined }, error => error as Error)
  expect(result?.message).toBe('Sotto could not start its SSH helper. Nothing was saved. Check Windows .NET Framework 4, then reconnect.')
  const source = compile.mock.calls[0]![1].at(-1) as string
  await expect(access(dirname(source))).rejects.toMatchObject({ code: 'ENOENT' })
})
