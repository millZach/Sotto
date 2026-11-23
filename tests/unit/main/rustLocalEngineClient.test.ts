// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveRustLocalEngineBinary,
  rustLocalEngineBinaryName,
  startRustLocalEngine,
} from '../../../src/main/engine/rustLocalEngineClient'

describe('Rust local desktop engine client (ADR-0215)', () => {
  it('picks the platform-appropriate binary filename', () => {
    expect(rustLocalEngineBinaryName('win32')).toBe('sotto-engine.exe')
    expect(rustLocalEngineBinaryName('darwin')).toBe('sotto-engine')
    expect(rustLocalEngineBinaryName('linux')).toBe('sotto-engine')
  })

  it('returns undefined cleanly when the binary does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sotto-rust-client-missing-'))
    try {
      const missing = join(dir, rustLocalEngineBinaryName())
      expect(await resolveRustLocalEngineBinary({ isPackaged: false, binaryPath: missing })).toBeUndefined()
      const logs: string[] = []
      const client = await startRustLocalEngine({
        userDataPath: dir,
        isPackaged: false,
        binaryPath: missing,
        log: code => { logs.push(code) },
      })
      expect(client).toBeUndefined()
      expect(logs).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resolves an explicit existing binary path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sotto-rust-client-present-'))
    try {
      const fakeBin = join(dir, rustLocalEngineBinaryName())
      await writeFile(fakeBin, 'stub', 'utf8')
      expect(await resolveRustLocalEngineBinary({ isPackaged: false, binaryPath: fakeBin })).toBe(fakeBin)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('aborts startup immediately instead of waiting for handshake timeout when the binary fails to launch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sotto-rust-client-badbin-'))
    try {
      const badBin = join(dir, rustLocalEngineBinaryName())
      await writeFile(badBin, 'not-an-executable-binary', 'utf8')
      const logs: string[] = []
      const started = Date.now()
      const client = await startRustLocalEngine({
        userDataPath: dir,
        isPackaged: false,
        binaryPath: badBin,
        log: code => { logs.push(code) },
      })
      const elapsed = Date.now() - started
      expect(client).toBeUndefined()
      expect(logs).toContain('rust-engine-exited')
      expect(logs).toContain('rust-engine-start-failed')
      if (process.env.SOTTO_PERF_ASSERT === '1') {
        expect(elapsed).toBeLessThan(3_000)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
