// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { HostCredentialEncryption, openHostCredentials } from '../../../src/host/credentials'
import { HostArgumentError, parseHostArguments, runHeadlessCommandLine } from '../../../src/host'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== tmpdir() || !root.includes('sotto-host-credentials-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe('headless host credentials', () => {
  it('uses random authenticated ciphertext and rejects another key or tampering', () => {
    const cipher = new HostCredentialEncryption('user-supplied-long-secret')
    const first = cipher.encryptString('private-provider-key')
    expect(first.includes(Buffer.from('private-provider-key'))).toBe(false)
    expect(cipher.encryptString('private-provider-key')).not.toEqual(first)
    expect(cipher.decryptString(first)).toBe('private-provider-key')
    expect(() => new HostCredentialEncryption('another-long-secret').decryptString(first)).toThrow('could not be unlocked')
    first[first.length - 1] = first[first.length - 1]! ^ 1
    expect(() => cipher.decryptString(first)).toThrow('could not be unlocked')
  })

  it('opens without a key only when no credentials exist, and never replaces an unreadable file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-host-credentials-')); roots.push(root)
    const keyFile = join(root, 'user-key')
    await writeFile(keyFile, 'user-supplied-long-secret')
    const empty = await openHostCredentials(root)
    expect(empty.available()).toBe(false)
    await expect(empty.set('formatting', 'private-provider-key')).rejects.toThrow('No key was saved')
    const credentials = await openHostCredentials(root, keyFile)
    await credentials.set('formatting', 'private-provider-key')
    expect((await openHostCredentials(root, keyFile)).get('formatting')).toBe('private-provider-key')
    const path = join(root, 'credentials.json'), original = await readFile(path, 'utf8')
    await expect(openHostCredentials(root)).rejects.toThrow('could not be unlocked')
    await writeFile(keyFile, 'another-user-supplied-secret')
    await expect(openHostCredentials(root, keyFile)).rejects.toThrow('could not be unlocked')
    expect(await readFile(path, 'utf8')).toBe(original)
    await writeFile(path, '{broken')
    await expect(openHostCredentials(root, keyFile)).rejects.toThrow('could not be unlocked')
    expect(await readFile(path, 'utf8')).toBe('{broken')
  })

  it('keeps an older plaintext key on repeated starts without a key file and prints the fix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-host-credentials-')); roots.push(root)
    const original = JSON.stringify({ llmApiKey: 'private-provider-key' })
    await writeFile(join(root, 'settings.json'), original)
    const argv = process.argv, exitCode = process.exitCode
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      process.argv = ['node', 'host', '--data', root]
      for (let attempt = 0; attempt < 2; attempt++) {
        await runHeadlessCommandLine()
        expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe(original)
        expect(process.exitCode).toBe(1)
      }
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Pass --key-file <file>'))
      expect(JSON.stringify(error.mock.calls)).not.toContain('private-provider-key')
    } finally { error.mockRestore(); process.argv = argv; process.exitCode = exitCode }
  })

  it('removes an older key after a failed secure write and prints only safe guidance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-host-credentials-')); roots.push(root)
    await writeFile(join(root, 'settings.json'), JSON.stringify({ llmApiKey: 'private-provider-key' }))
    const keyFile = join(root, 'user-key')
    await writeFile(keyFile, 'user-supplied-long-secret')
    const write = vi.spyOn(AgentCredentials.prototype, 'set').mockRejectedValue(new Error('private-provider-key storage detail'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const argv = process.argv, exitCode = process.exitCode
    try {
      process.argv = ['node', 'host', '--data', root, '--key-file', keyFile]
      await runHeadlessCommandLine()
      expect(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')).llmApiKey).toBe('')
      expect(error).toHaveBeenCalledWith('[Sotto] openrouter-key-migration-failed')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Enter it again'))
      expect(JSON.stringify(error.mock.calls)).not.toContain('private-provider-key')
      expect(process.exitCode).toBe(1)
    } finally { write.mockRestore(); error.mockRestore(); process.argv = argv; process.exitCode = exitCode }
  })

  it('requires an explicit data folder and accepts environment defaults with command-line overrides', () => {
    expect(() => parseHostArguments([], {})).toThrow('Choose a host data folder')
    expect(parseHostArguments(['--data', './chosen', '--key-file', './secret'], { SOTTO_HOST_DATA: './ignored' }))
      .toEqual({ dataDirectory: resolve('chosen'), port: 0, keyFile: resolve('secret') })
    expect(parseHostArguments([], { SOTTO_HOST_DATA: './saved' })).toEqual({ dataDirectory: resolve('saved'), port: 0 })
    expect(() => parseHostArguments(['--data', '--key-file'], {})).toThrow('needs a value')
    expect(() => parseHostArguments(['--unknown'], {})).toThrow('Use --data')
    expect(() => parseHostArguments(['--port', '70000'], {})).toThrow(HostArgumentError)
  })

  it('prints what was wrong with the command line instead of the key-file hint', async () => {
    const argv = process.argv, exitCode = process.exitCode
    const printed: string[] = []
    const error = vi.spyOn(console, 'error').mockImplementation((line: unknown) => { printed.push(String(line)) })
    try {
      process.argv = ['node', 'host', '--port', '70000', '--data', 'unused']
      await runHeadlessCommandLine()
      expect(printed).toEqual(['[Sotto] host-start-failed', 'Choose a port from 0 through 65535.'])
      printed.length = 0
      process.argv = ['node', 'host', '--revoke-client']
      await runHeadlessCommandLine()
      expect(printed).toEqual(['Choose a paired client by its client ID.'])
      expect(process.exitCode).toBe(1)
    } finally { error.mockRestore(); process.argv = argv; process.exitCode = exitCode }
  })
})
