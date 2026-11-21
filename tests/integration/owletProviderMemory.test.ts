// @vitest-environment node
// ADR-0213, decision 4: a thread working in an owlet's folder starts its provider with the provider's own memory off, so
// nothing an owlet reads is kept where other threads would find it. Any other folder starts as before.
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inOwletFolder } from '../../src/main/agents/owlets'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

describe('inOwletFolder', () => {
  const data = join('/', 'data', 'sotto')
  it('holds for a folder inside owlets and nothing else', () => {
    expect(inOwletFolder(data, join(data, 'owlets', 'Tawny'))).toBe(true)
    expect(inOwletFolder(data, join(data, 'owlets', 'Tawny', 'notes'))).toBe(true)
    expect(inOwletFolder(data, join(data, 'owlets'))).toBe(false)
    expect(inOwletFolder(data, join(data, 'owlets-old', 'Tawny'))).toBe(false)
    expect(inOwletFolder(data, join(data, 'owlets', '..', 'watcher'))).toBe(false)
    expect(inOwletFolder(data, join('/', 'home', 'owlets', 'Tawny'))).toBe(false)
    expect(inOwletFolder(data, undefined)).toBe(false)
  })
})

async function claudeLaunch(owlet: boolean) {
  const f = await claudeFixture()
  cleanups.push(() => f.cleanup())
  const folder = owlet ? join(f.root, 'owlets', 'Tawny') : f.root
  await mkdir(folder, { recursive: true })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Tawny', path: folder })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(), projectId: f.projectId, title: 'Tawny', modelId: 'fixture-model' })
  const launch = (await f.driver.requests()).findLast(record => record.method === 'launch'
    && !(record.params?.frame as { args: string[] }).args.includes('--no-session-persistence'))
  const frame = launch?.params?.frame as { args: string[]; autoMemoryOff: string | null }
  const settings = JSON.parse(frame.args[frame.args.lastIndexOf('--settings') + 1]!) as Record<string, unknown>
  return { settings, environment: frame.autoMemoryOff }
}

async function codexStart(owlet: boolean) {
  const f = await codexFixture()
  cleanups.push(() => f.cleanup())
  const folder = owlet ? join(f.root, 'owlets', 'Tawny') : f.root
  await mkdir(folder, { recursive: true })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Tawny', path: folder })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(), projectId: f.projectId, modelId: f.modelId, title: 'Tawny' })
  return (await f.driver.requests()).find(record => record.method === 'thread/start')!.params?.config as Record<string, unknown>
}

it('starts Claude Code in an owlet\'s folder with auto memory off', async () => {
  const owlet = await claudeLaunch(true)
  expect(owlet.settings).toMatchObject({ autoMemoryEnabled: false })
  expect(owlet.environment).toBe('1')
  const other = await claudeLaunch(false)
  expect(other.settings).not.toHaveProperty('autoMemoryEnabled')
  expect(other.environment).toBeNull()
})

it('starts Codex in an owlet\'s folder with its memories off', async () => {
  expect(await codexStart(true)).toMatchObject({ 'features.memories': false })
  expect(await codexStart(false)).not.toHaveProperty('features.memories')
})
