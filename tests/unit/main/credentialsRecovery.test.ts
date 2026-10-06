// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentCredentials } from '../../../src/main/agents/credentials'

const encryption = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() }

describe('credential recovery', () => {
  it.each(['private corrupt bytes', '{"formatting":42}'])('preserves unreadable keys and emits only a safe notice: %s', async bytes => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-credentials-'))
    try {
      await writeFile(join(root, 'credentials.json'), bytes)
      const notice = vi.fn()
      const credentials = new AgentCredentials(root, encryption, notice)
      await credentials.load()
      expect(credentials.has('formatting')).toBe(false)
      expect(notice.mock.calls).toEqual([[{ code: 'CREDENTIALS_RECOVERED' }]])
      const backup = (await readdir(root)).find(name => name.startsWith('credentials.json.corrupt-'))!
      expect(await readFile(join(root, backup), 'utf8')).toBe(bytes)
      await credentials.set('formatting', 'replacement')
      await credentials.load()
      expect(credentials.get('formatting')).toBe('replacement')
      expect(notice).toHaveBeenCalledOnce()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not announce a missing or valid store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-credentials-'))
    try {
      const notice = vi.fn()
      const credentials = new AgentCredentials(root, encryption, notice)
      await credentials.load()
      await credentials.set('formatting', 'key')
      await credentials.load()
      expect(notice).not.toHaveBeenCalled()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
