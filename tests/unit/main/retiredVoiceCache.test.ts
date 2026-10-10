// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeRetiredVoiceCache } from '../../../src/main/agents/retiredVoiceCache'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-retired-cache-')); roots.push(root)
  const parent = join(root, 'models', 'onnx-community')
  await mkdir(parent, { recursive: true })
  await writeFile(join(root, 'agents.json'), JSON.stringify({ configuration: { wakeModelDirectory: '', wakeRuntimeDirectory: '' } }), 'utf8')
  return { root, parent }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})
describe('retired voice cache cleanup', () => {
  it('removes only the named cache and matching partials and backups, leaving other models and wake assets', async () => {
    const f = await fixture()
    const owned = ['Supertonic-TTS-ONNX', `.Supertonic-TTS-ONNX.partial-${randomUUID()}`, `Supertonic-TTS-ONNX.backup-${randomUUID()}`]
    for (const name of owned) {
      await mkdir(join(f.parent, name, 'onnx'), { recursive: true })
      await writeFile(join(f.parent, name, 'onnx', 'text_encoder.onnx'), 'Synthetic cache', 'utf8')
    }
    const unknown = ['Another-model', '.Supertonic-TTS-ONNX.partial-not-a-uuid', 'Supertonic-TTS-ONNX.backup-unknown']
    for (const name of unknown) await mkdir(join(f.parent, name))
    const wake = join(f.root, 'wake-assets'); await mkdir(wake); await writeFile(join(wake, 'user.onnx'), 'User file', 'utf8')
    expect(await removeRetiredVoiceCache(f.root)).toEqual({ removed: 3, retained: 0, failed: 0 })
    expect((await readdir(f.parent)).sort()).toEqual(unknown.sort())
    expect(await readFile(join(wake, 'user.onnx'), 'utf8')).toBe('User file')
    expect(await removeRetiredVoiceCache(f.root)).toEqual({ removed: 0, retained: 0, failed: 0 })
  })
  it('leaves the entire candidate when an unknown file or nested junction makes ownership unsafe', async () => {
    const f = await fixture(), cache = join(f.parent, 'Supertonic-TTS-ONNX'), backup = join(f.parent, `Supertonic-TTS-ONNX.backup-${randomUUID()}`)
    await mkdir(cache); await writeFile(join(cache, 'config.json'), 'Known file', 'utf8'); await writeFile(join(cache, 'keep.txt'), 'User file', 'utf8')
    const outside = await mkdtemp(join(tmpdir(), 'sotto-user-wake-')); roots.push(outside)
    await writeFile(join(outside, 'F1.bin'), 'User voice', 'utf8'); await mkdir(backup)
    await symlink(outside, join(backup, 'voices'), 'junction')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await removeRetiredVoiceCache(f.root)).toEqual({ removed: 0, retained: 2, failed: 0 })
    expect(await readFile(join(cache, 'config.json'), 'utf8')).toBe('Known file')
    expect(await readFile(join(outside, 'F1.bin'), 'utf8')).toBe('User voice')
    expect(warn).toHaveBeenCalledWith('retired-voice-cache-retained')
  })
  it('refuses a redirected models root and leaves its target untouched', async () => {
    const f = await fixture(), outside = await mkdtemp(join(tmpdir(), 'sotto-user-models-')); roots.push(outside)
    await rm(join(f.root, 'models'), { recursive: true })
    const cache = join(outside, 'onnx-community', 'Supertonic-TTS-ONNX'); await mkdir(cache, { recursive: true })
    await writeFile(join(cache, 'config.json'), 'User file', 'utf8')
    await symlink(outside, join(f.root, 'models'), 'junction')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await removeRetiredVoiceCache(f.root)).toEqual({ removed: 0, retained: 0, failed: 1 })
    expect(await readFile(join(cache, 'config.json'), 'utf8')).toBe('User file')
  })
  it('preserves a user-selected wake directory even when it overlaps a named cache', async () => {
    const f = await fixture(), cache = join(f.parent, 'Supertonic-TTS-ONNX')
    await mkdir(cache); await writeFile(join(cache, 'config.json'), 'Selected file', 'utf8')
    await writeFile(join(f.root, 'agents.json'), JSON.stringify({ configuration: { wakeModelDirectory: cache } }), 'utf8')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await removeRetiredVoiceCache(f.root)).toEqual({ removed: 0, retained: 1, failed: 0 })
    await writeFile(join(f.root, 'agents.json'), JSON.stringify({ configuration: {} }), 'utf8')
    expect(await removeRetiredVoiceCache(f.root)).toEqual({ removed: 0, retained: 0, failed: 0 })
    expect(await readFile(join(cache, 'config.json'), 'utf8')).toBe('Selected file')
  })
  it('preserves the target of a user-selected wake junction into a named cache', async () => {
    const f = await fixture(), cache = join(f.parent, 'Supertonic-TTS-ONNX'), wake = join(f.root, 'selected-wake')
    await mkdir(cache); await writeFile(join(cache, 'config.json'), 'Selected target', 'utf8')
    await symlink(cache, wake, 'junction')
    await writeFile(join(f.root, 'agents.json'), JSON.stringify({ configuration: { wakeRuntimeDirectory: wake } }), 'utf8')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await removeRetiredVoiceCache(f.root)).toEqual({ removed: 0, retained: 1, failed: 0 })
    expect(await readFile(join(wake, 'config.json'), 'utf8')).toBe('Selected target')
  })
})
