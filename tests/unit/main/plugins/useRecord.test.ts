// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginUseRecord, type PluginUseReport } from '../../../../src/main/plugins/useRecord'
import { PLUGIN_USE_KEPT } from '../../../../src/shared/plugins'

const folders: string[] = []
async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'sotto-plugin-use-'))
  folders.push(made)
  return made
}
afterEach(async () => { await Promise.all(folders.splice(0).map(made => rm(made, { recursive: true, force: true }))) })

const use = (threadId: string, kind: PluginUseReport['kind'] = 'issues', outcome: PluginUseReport['outcome'] = 'done'): PluginUseReport =>
  ({ threadId, plugin: 'github', tool: 'plugin_read', kind, outcome })

describe('the plugin use record (ADR-0205)', () => {
  it('keeps what was done, by which thread and when, newest first, and finds it again after a restart', async () => {
    const directory = await folder()
    let now = new Date('2026-11-12T08:00:00.000Z')
    const record = new PluginUseRecord(directory, { historyEnabled: () => true, now: () => now })
    await record.add(use('thread-one'))
    now = new Date('2026-11-12T09:00:00.000Z')
    await record.add(use('thread-two', 'pull-requests', 'failed'))
    const listed = await new PluginUseRecord(directory, { historyEnabled: () => true }).list()
    expect(listed).toEqual([
      { id: expect.any(String), at: '2026-11-12T09:00:00.000Z', threadId: 'thread-two', plugin: 'github', tool: 'plugin_read', kind: 'pull-requests', outcome: 'failed' },
      { id: expect.any(String), at: '2026-11-12T08:00:00.000Z', threadId: 'thread-one', plugin: 'github', tool: 'plugin_read', kind: 'issues', outcome: 'done' },
    ])
    // The file holds those fields and no others: nothing that was asked for by name, nothing that came back.
    const saved = JSON.parse(await readFile(join(directory, 'plugin-use.json'), 'utf8')) as { uses: Record<string, unknown>[] }
    expect(Object.keys(saved.uses[0]!).sort()).toEqual(['at', 'id', 'kind', 'outcome', 'plugin', 'threadId', 'tool'])
  })

  it('keeps only the newest uses', async () => {
    const record = new PluginUseRecord(await folder(), { historyEnabled: () => true })
    for (let index = 0; index < PLUGIN_USE_KEPT + 3; index++) await record.add(use(`thread-${index}`))
    const listed = await record.list()
    expect(listed).toHaveLength(PLUGIN_USE_KEPT)
    expect(listed[0]!.threadId).toBe(`thread-${PLUGIN_USE_KEPT + 2}`)
  })

  it('forgets a forgotten thread’s entries and leaves the rest', async () => {
    const record = new PluginUseRecord(await folder(), { historyEnabled: () => true })
    await record.add(use('kept'))
    await record.add(use('forgotten'))
    await record.forgetThreads(['forgotten'])
    expect((await record.list()).map(entry => entry.threadId)).toEqual(['kept'])
  })

  it('forgets every thread asked for at once, whether in one call or several started together', async () => {
    const directory = await folder()
    const record = new PluginUseRecord(directory, { historyEnabled: () => true })
    for (const thread of ['a', 'b', 'c', 'kept']) await record.add(use(thread))
    // Started together, before either has read what is kept: neither may put the other's thread back.
    await Promise.all([record.forgetThreads(['a']), record.forgetThreads(['b', 'c'])])
    expect((await record.list()).map(entry => entry.threadId)).toEqual(['kept'])
    expect((await new PluginUseRecord(directory, { historyEnabled: () => true }).list()).map(entry => entry.threadId)).toEqual(['kept'])
  })

  it('writes nothing for an addition that was waiting when Keep local history was turned off', async () => {
    const directory = await folder()
    let history = true
    const record = new PluginUseRecord(directory, { historyEnabled: () => history })
    await record.add(use('before'))
    // A second record over the same file has not read it yet, so its addition is still loading when history goes off.
    const late = new PluginUseRecord(directory, { historyEnabled: () => history })
    const adding = late.add(use('late'))
    history = false
    const clearing = late.clear()
    await Promise.all([adding, clearing])
    await expect(readFile(join(directory, 'plugin-use.json'), 'utf8')).rejects.toThrow()
    history = true
    expect(await late.list()).toEqual([])
  })

  it('says when what was kept could not be removed, rather than reporting it cleared', async () => {
    const directory = await folder()
    // A folder where the file should be cannot be removed as a file.
    await mkdir(join(directory, 'plugin-use.json', 'held'), { recursive: true })
    await expect(new PluginUseRecord(directory, { historyEnabled: () => false }).clear()).rejects.toThrow()
  })

  it('writes nothing and shows nothing with Keep local history off, and clears what was kept', async () => {
    const directory = await folder()
    let history = true
    const record = new PluginUseRecord(directory, { historyEnabled: () => history })
    await record.add(use('before'))
    history = false
    await record.add(use('while-off'))
    expect(await record.list()).toEqual([])
    await record.clear()
    await expect(readFile(join(directory, 'plugin-use.json'), 'utf8')).rejects.toThrow()
    history = true
    expect(await record.list()).toEqual([])
  })

  it('reads a damaged file as an empty record, and drops an entry it cannot read rather than the rest', async () => {
    const directory = await folder()
    await writeFile(join(directory, 'plugin-use.json'), 'not json', 'utf8')
    expect(await new PluginUseRecord(directory, { historyEnabled: () => true }).list()).toEqual([])
    const good = { id: '11111111-1111-4111-8111-111111111111', at: '2026-11-12T08:00:00.000Z', ...use('thread-one') }
    await writeFile(join(directory, 'plugin-use.json'), JSON.stringify({ version: 1, uses: [{ ...good, body: 'something read' }, good] }), 'utf8')
    expect(await new PluginUseRecord(directory, { historyEnabled: () => true }).list()).toEqual([good])
  })
})
