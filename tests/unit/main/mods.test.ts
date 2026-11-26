// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { MOD_PARTS } from '../../../src/shared/modParts'
import { MOD_CSS_BYTES_MAX } from '../../../src/shared/mods'
import { MODS_PROJECT_TITLE, modsGuide, prepareModsFolder, readMods, startModThread } from '../../../src/main/mods/mods'

let folder: string
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'sotto-mods-')) })
afterEach(async () => { await rm(folder, { recursive: true, force: true }) })

async function mod(id: string, files: Record<string, string>): Promise<void> {
  await mkdir(join(folder, id), { recursive: true })
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(join(folder, id, name), text, 'utf8')))
}

describe('readMods (ADR-0217)', () => {
  it('lists each mod by its folder, with its name, description and look', async () => {
    await mod('oak-sidebar', { 'mod.json': '{ "name": "Oak sidebar", "description": "Warm wood." }', 'look.css': '[data-part="sidebar"] { color: red; }' })
    await mod('quiet', { 'mod.json': '\uFEFF{ "name": "Quiet" }' })
    expect(await readMods(folder)).toEqual({ mods: [
      { id: 'oak-sidebar', name: 'Oak sidebar', description: 'Warm wood.', look: '[data-part="sidebar"] { color: red; }' },
      { id: 'quiet', name: 'Quiet', look: '' },
    ] })
  })

  it('lists a mod it cannot use with why, and paints nothing of it', async () => {
    await mod('no-name', { 'look.css': 'a { color: red; }' })
    await mod('bad-json', { 'mod.json': '{ name: ', 'look.css': 'a { color: red; }' })
    await mod('outside', { 'mod.json': '{ "name": "Outside" }', 'look.css': 'a { background: url(https://example.com/x.png); }' })
    await mod('too-large', { 'mod.json': '{ "name": "Big" }', 'look.css': `a { color: red; }${' '.repeat(MOD_CSS_BYTES_MAX)}` })
    const { mods } = await readMods(folder)
    expect(mods.map(item => [item.id, item.problem])).toEqual([['bad-json', 'manifest'], ['no-name', 'manifest'], ['outside', 'outside'], ['too-large', 'too-large']])
    // A look too large is not sent at all; one that reaches outside is sent as written, for View its code.
    expect(mods.find(item => item.id === 'too-large')?.look).toBe('')
    expect(mods.find(item => item.id === 'outside')?.look).toContain('url(')
  })

  it('lists a mod whose mod.json is a folder as unreadable, and the others as they are', async () => {
    await mkdir(join(folder, 'odd', 'mod.json'), { recursive: true })
    await mod('fine', { 'mod.json': '{ "name": "Fine" }' })
    expect((await readMods(folder)).mods.map(item => [item.id, item.problem])).toEqual([['fine', undefined], ['odd', 'manifest']])
  })

  it('leaves out files and folders whose names are not mod ids, and has none when the folder is missing', async () => {
    await mod('Has Spaces', { 'mod.json': '{ "name": "x" }' })
    await mod('.hidden', { 'mod.json': '{ "name": "x" }' })
    await writeFile(join(folder, 'AGENTS.md'), 'guide', 'utf8')
    expect((await readMods(folder)).mods).toEqual([])
    expect(await readMods(join(folder, 'missing'))).toEqual({ mods: [] })
  })
})

describe('the mods guide', () => {
  it('names every part, and is written as both AGENTS.md and CLAUDE.md', async () => {
    const guide = modsGuide()
    for (const part of MOD_PARTS) expect(guide).toContain(`[data-part="${part.name}"]`)
    await prepareModsFolder(join(folder, 'mods'))
    expect(await readFile(join(folder, 'mods', 'AGENTS.md'), 'utf8')).toBe(guide)
    expect(await readFile(join(folder, 'mods', 'CLAUDE.md'), 'utf8')).toBe(guide)
  })
})

describe('startModThread', () => {
  function coordinator(projects: { id: string; path: string }[] = []) {
    const sent: AgentCommand[] = []
    const state = (): AgentState => ({
      host: { projects, threads: [], models: [{ id: 'claude/opus', providerId: 'claude', name: 'Opus', provider: 'Claude', ready: true }] },
      configuration: { defaultModelId: 'claude/opus' }, reasoningAccounts: [],
    }) as unknown as AgentState
    return {
      sent,
      shell: state,
      command: async (command: AgentCommand) => {
        sent.push(command)
        if (command.type === 'create-project') projects.push({ id: 'project-mods', path: command.path ?? '' })
        return null
      },
    }
  }

  it('makes the Mods project at the folder, starts a thread there and sends the words as written', async () => {
    const mods = join(folder, 'mods')
    const fake = coordinator()
    const threadId = await startModThread(fake, mods, 'Give the sidebar an oak look')
    expect(fake.sent.map(command => command.type)).toEqual(['create-project', 'create-thread', 'manual-send'])
    expect(fake.sent[0]).toMatchObject({ type: 'create-project', title: MODS_PROJECT_TITLE, path: mods, useExisting: true })
    expect(fake.sent[1]).toMatchObject({ type: 'create-thread', threadId, projectId: 'project-mods', modelId: 'claude/opus', workingCopy: 'shared' })
    expect(fake.sent[2]).toEqual({ type: 'manual-send', threadId, text: 'Give the sidebar an oak look' })
    expect(await readFile(join(mods, 'AGENTS.md'), 'utf8')).toBe(modsGuide())
  })

  it('reuses the Mods project once it exists', async () => {
    const mods = join(folder, 'mods')
    const fake = coordinator([{ id: 'existing', path: mods }])
    await startModThread(fake, mods, 'Hide the times')
    expect(fake.sent.map(command => command.type)).toEqual(['create-thread', 'manual-send'])
    expect(fake.sent[0]).toMatchObject({ projectId: 'existing' })
  })
})
