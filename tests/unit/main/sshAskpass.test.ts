// @vitest-environment node
import { access } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createConnection } from 'node:net'
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

it('refuses a non-object request and still answers an authenticated helper', async () => {
  const handler = vi.fn(async () => 'accepted')
  const broker = await AskpassBroker.start(handler, { platform: 'linux', node: process.execPath })
  const environment = broker.environment('caller')
  const exchange = async (payload: unknown): Promise<string> => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(environment.SOTTO_ASKPASS_PORT) })
    let answer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => { answer += chunk })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject)
        socket.once('close', () => resolve())
        socket.write(JSON.stringify(payload) + '\n')
      })
      return answer
    } finally { socket.destroy() }
  }
  try {
    for (const value of [null, [], false, 17, 'request']) {
      expect(await exchange(value)).toBe('')
    }
    expect(handler).not.toHaveBeenCalled()
    expect(await exchange({ token: environment.SOTTO_ASKPASS_TOKEN, prompt: 'Passphrase?' })).toBe('{"answer":"accepted"}\n')
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith('caller', { prompt: 'Passphrase?', hint: '' }, expect.any(AbortSignal))
  } finally { await broker.close() }
})
