// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CouncilEvidenceLimit, CouncilEvidenceStore, clearTemporaryCouncilEvidence, compareCouncilEvidence, createCouncilJudgeWorkspace } from '../../../../src/main/council/councilEvidence'
import { CouncilStore } from '../../../../src/main/council/councilStore'
import { councilFileSchema, legacyCouncilFileSchema, migrateCouncilFile, savedRecord } from '../../../../src/main/council/councilRecord'
import { addRound } from '../../../../src/main/council/councilStages'
import { COUNCIL_EVIDENCE_LIMITS, councilEvidencePathSchema, type CouncilEvidenceSource } from '../../../../src/shared/councilEvidence'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-council-evidence-')); roots.push(root)
  const source = join(root, 'source'), data = join(root, 'data')
  await mkdir(source); await mkdir(data)
  return { root, source, data, store: new CouncilEvidenceStore(data, randomUUID(), true) }
}
const folder = (root: string, paths: string[] = []): CouncilEvidenceSource => ({ kind: 'folder', root, paths, exclude: [] })
const artifacts = (text: string): CouncilEvidenceSource => ({ kind: 'artifacts', items: [{ artifactId: 'draft', path: 'note.txt', content: { kind: 'text', text } }] })
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('frozen Council evidence', () => {
  it('captures a plain folder without Git, reports exclusions, and permits only explicit regular-file overrides', async () => {
    const f = await fixture()
    await writeFile(join(f.source, 'draft.txt'), 'First line\nSecond line\n')
    await writeFile(join(f.source, '.env'), 'private')
    await mkdir(join(f.source, 'node_modules')); await writeFile(join(f.source, 'node_modules', 'module.js'), 'dependency')
    await mkdir(join(f.source, '.git')); await writeFile(join(f.source, '.git', 'config'), 'private Git metadata')
    const path = process.env.PATH
    process.env.PATH = ''
    try {
      const preview = await f.store.preview(folder(f.source))
      expect(preview.files).toBe(1)
      expect(preview.excluded.map(item => item.path)).toEqual(['.env', '.git', 'node_modules'])
      const capture = await f.store.capture(folder(f.source), { approvedPreview: preview.fingerprint })
      expect((await f.store.manifest(capture)).entries.map(item => item.path)).toEqual(['draft.txt'])
      expect(await f.store.citation(capture, 'draft.txt', 1, 2, 'First line\nSecond line')).toBe('matches')
      expect(await f.store.citation(capture, 'draft.txt', 1, 2, 'First line')).toBe('differs')
      expect(await f.store.citation(capture, 'missing.txt', 1, 1, 'missing')).toBe('missing')
      const explicit = await f.store.capture(folder(f.source, ['.env', '.git/config', 'node_modules', 'node_modules/module.js']))
      expect((await f.store.manifest(explicit)).entries.map(item => item.path)).toEqual(['.env', 'node_modules/module.js'])
    } finally { process.env.PATH = path }
  })

  it('preserves Git provenance and explicit exclusion rules without asking Git to capture', async () => {
    const f = await fixture()
    await writeFile(join(f.source, 'keep.txt'), 'keep'); await writeFile(join(f.source, 'skip.txt'), 'skip')
    const source: CouncilEvidenceSource = { kind: 'git', root: f.source, paths: [], exclude: ['skip.*'], commit: 'abc', branch: 'draft', dirty: true }
    const captured = await f.store.capture(source), manifest = await f.store.manifest(captured)
    expect(manifest.source).toMatchObject({ ...source, root: expect.any(String) })
    expect(manifest.entries.map(entry => entry.path)).toEqual(['keep.txt'])
    expect(manifest.excluded).toEqual([{ path: 'skip.txt', reason: 'excluded' }])
  })

  it('rejects changed approved previews and preserves the published bytes after the source changes', async () => {
    const f = await fixture(), path = join(f.source, 'draft.txt')
    await writeFile(path, 'one')
    const preview = await f.store.preview(folder(f.source)), original = await f.store.capture(folder(f.source))
    await writeFile(path, 'two different words')
    await expect(f.store.capture(folder(f.source), { approvedPreview: preview.fingerprint })).rejects.toThrow('changed after its preview')
    expect((await f.store.read(original, 'draft.txt')).toString()).toBe('one')
    await expect(f.store.read(original, '../draft.txt')).rejects.toThrow()
    const disk = join(f.data, 'council-evidence', 'retained', f.store.councilId, 'snapshots', original.id, 'files', 'draft.txt')
    await chmod(disk, 0o600); await writeFile(disk, 'tampered')
    await expect(f.store.read(original, 'draft.txt')).rejects.toThrow('captured file changed')
  })

  it('never follows links or junctions into source material', async () => {
    const f = await fixture(), outside = join(f.root, 'outside')
    await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'outside')
    await symlink(outside, join(f.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const evidence = await f.store.capture(folder(f.source))
    expect((await f.store.manifest(evidence)).entries).toEqual([])
    expect((await f.store.manifest(evidence)).excluded).toEqual([{ path: 'linked', reason: 'link' }])
  })

  it('enforces file, byte, binary and retained limits without publishing partial evidence', async () => {
    const f = await fixture()
    await expect(f.store.capture(artifacts('long'), { limits: { ...COUNCIL_EVIDENCE_LIMITS, bytes: 3 } })).rejects.toBeInstanceOf(CouncilEvidenceLimit)
    await expect(f.store.capture({ kind: 'artifacts', items: [
      { artifactId: 'a', path: 'a.txt', content: { kind: 'text', text: '' } },
      { artifactId: 'b', path: 'b.txt', content: { kind: 'text', text: '' } },
    ] }, { limits: { ...COUNCIL_EVIDENCE_LIMITS, files: 1 } })).rejects.toBeInstanceOf(CouncilEvidenceLimit)
    await writeFile(join(f.source, 'image.png'), Buffer.from([0, 1, 2, 3]))
    await expect(f.store.capture(folder(f.source), { limits: { ...COUNCIL_EVIDENCE_LIMITS, binaryBytes: 3 } })).rejects.toBeInstanceOf(CouncilEvidenceLimit)
    const snapshots = join(f.data, 'council-evidence', 'retained', f.store.councilId, 'snapshots')
    expect(await readdir(snapshots)).toEqual([])
    await f.store.capture(artifacts('four'))
    await expect(f.store.capture(artifacts('next'), { limits: { ...COUNCIL_EVIDENCE_LIMITS, retainedBytes: 7 } })).rejects.toBeInstanceOf(CouncilEvidenceLimit)
    expect(await readdir(snapshots)).toHaveLength(1)
  })

  it('compares complete manifests, including added, removed and replaced binary files', async () => {
    const f = await fixture()
    await writeFile(join(f.source, 'old.txt'), 'old'); await writeFile(join(f.source, 'same.txt'), 'same')
    await writeFile(join(f.source, 'image.png'), Buffer.from([0, 1]))
    const before = await f.store.capture(folder(f.source))
    await rm(join(f.source, 'old.txt')); await writeFile(join(f.source, 'new.txt'), 'new')
    await writeFile(join(f.source, 'same.txt'), 'changed'); await writeFile(join(f.source, 'image.png'), Buffer.from([0, 2]))
    const after = await f.store.capture(folder(f.source))
    expect(await compareCouncilEvidence(f.store, before, after)).toEqual([
      { path: 'image.png', kind: 'changed', binary: true },
      { path: 'new.txt', kind: 'added', binary: false, after: 'new' },
      { path: 'old.txt', kind: 'removed', binary: false, before: 'old' },
      { path: 'same.txt', kind: 'changed', binary: false, before: 'same', after: 'changed' },
    ])
  })

  it('exports exact retained content into a new editable folder and never overwrites an existing destination', async () => {
    const f = await fixture(), evidence = await f.store.capture(artifacts('selected draft')), destination = join(f.root, 'export')
    await f.store.export(evidence, destination)
    expect(await readFile(join(destination, 'files', 'note.txt'), 'utf8')).toBe('selected draft')
    expect(JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8')).id).toBe(evidence.id)
    await writeFile(join(destination, 'keep.txt'), 'keep')
    await expect(f.store.export(evidence, destination)).rejects.toThrow()
    expect(await readFile(join(destination, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('gives each judge only its own neutral exhibit copies and clears disposable evidence at restart', async () => {
    const f = await fixture(), evidence = await f.store.capture(artifacts('selected draft'))
    const workspace = await createCouncilJudgeWorkspace(f.data, f.store.councilId, randomUUID(), f.store, [{ letter: 'A', evidence }])
    expect(await readdir(workspace.path)).toEqual(['A'])
    expect(await readFile(join(workspace.path, 'A', 'note.txt'), 'utf8')).toBe('selected draft')
    if (process.platform !== 'win32') {
      expect((await lstat(join(workspace.path, 'A', 'note.txt'))).mode & 0o222).toBe(0)
      expect((await lstat(workspace.path)).mode & 0o222).toBe(0)
    }
    await workspace.remove()
    const temporary = new CouncilEvidenceStore(f.data, randomUUID(), false), transient = await temporary.capture(artifacts('temporary'))
    const abandoned = join(f.data, 'council-evidence', 'retained', f.store.councilId, 'snapshots', `${randomUUID()}.pending`)
    await mkdir(abandoned)
    await clearTemporaryCouncilEvidence(f.data)
    await expect(temporary.manifest(transient)).rejects.toThrow()
    await expect(lstat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.store.read(evidence, 'note.txt')).toString()).toBe('selected draft')
  })

  it.each(['../outside', '/absolute', 'a\\b', 'CON', 'a/NUL.txt', 'a/.', 'a/trailing.', 'a//b'])('rejects unsafe portable path %s', path => {
    expect(councilEvidencePathSchema.safeParse(path).success).toBe(false)
  })
})

function legacy(snapshot: 'present' | 'removed' | 'absent') {
  const id = randomUUID(), at = '2026-11-04T12:00:00.000Z'
  return legacyCouncilFileSchema.parse({ version: 1, councils: [{
    id, createdAt: at, originThread: 'origin', originTitle: 'Draft', projectId: 'project',
    ...(snapshot === 'absent' ? {} : { snapshot: { path: '/old/snapshot', repositoryRoot: '/old', commit: 'a'.repeat(40), branch: 'main', untracked: 1, ...(snapshot === 'removed' ? { removedAt: at } : {}) } }),
    history: { messages: 0, words: 0, tools: 0, parts: 1 },
    seats: ['A', 'B', 'chair'].map(seat => ({ seat, role: seat === 'chair' ? 'chair' : 'panelist', modelId: 'm', modelName: 'm', effort: null, thread: `t-${seat}`, formerThreads: [], started: true, context: true })),
    rounds: [0, 1].map(index => ({ index, askedAt: at, stage: 'done', leftOut: [], objections: [], question: `Question ${index}` })),
    turns: [{ id: randomUUID(), draftId: randomUUID(), seat: 'A', thread: 't-A', round: 1, stage: 'answer', messageId: randomUUID(), delivery: 'unconfirmed', outcome: 'unknown', result: 'pending', queuedAt: at }],
    deadlineMinutes: 10,
  }] })
}

describe('Council history migration', () => {
  it.each(['present', 'removed', 'absent'] as const)('preserves %s snapshot provenance and every old turn through an idempotent migration', async snapshot => {
    const f = await fixture(), old = legacy(snapshot), file = join(f.data, 'councils.json'), bytes = JSON.stringify(old, null, 3)
    await writeFile(file, bytes)
    const store = new CouncilStore(f.data), migrated = await store.read(), record = migrated.councils[0]!
    expect(record.turns).toEqual(old.councils[0]!.turns)
    expect(record.evidence).toEqual(snapshot === 'absent' ? [{ kind: 'legacyLive', id: `${record.id}:legacy` }]
      : [{ kind: 'legacyGit', id: `${record.id}:legacy`, snapshot: old.councils[0]!.snapshot }])
    expect(record.rounds.map(round => round.evidence)).toEqual([{ source: `${record.id}:legacy` }, { source: `${record.id}:legacy` }])
    expect(await readFile(`${file}.v1-backup`, 'utf8')).toBe(bytes)
    expect(await store.read()).toEqual(migrated)
    addRound(record, 'Follow up', Date.now())
    expect(record.rounds[2]!.evidence).toEqual(record.rounds[0]!.evidence)
    expect(councilFileSchema.safeParse(migrated).success).toBe(true)
  })

  it('refuses invalid and future records without changing the original bytes or writing a backup', async () => {
    const f = await fixture(), file = join(f.data, 'councils.json')
    for (const bytes of ['{bad', '{"version":3,"councils":[]}', '{"version":1,"councils":[{}]}']) {
      await writeFile(file, bytes)
      await expect(new CouncilStore(f.data).read()).rejects.toThrow()
      expect(await readFile(file, 'utf8')).toBe(bytes)
      expect(await readdir(f.data)).toEqual(['councils.json'])
    }
  })

  it('removes the migration backup only after the history-off record is safely written', async () => {
    const f = await fixture(), file = join(f.data, 'councils.json')
    await writeFile(file, JSON.stringify(legacy('absent')))
    const store = new CouncilStore(f.data), migrated = await store.read()
    await expect(store.writeLatest(() => { throw new Error('Cannot save') }, false)).rejects.toThrow('Cannot save')
    expect(await readFile(`${file}.v1-backup`, 'utf8')).toContain('Question 0')
    await store.writeLatest(() => ({ version: 2, councils: migrated.councils.map(record => savedRecord(record, false)) }), false)
    await expect(readFile(`${file}.v1-backup`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(file, 'utf8')).not.toContain('Question 0')
  })

  it('refuses a mismatched migration backup and dangling round evidence', async () => {
    const f = await fixture(), old = legacy('absent'), file = join(f.data, 'councils.json'), bytes = JSON.stringify(old)
    await writeFile(file, bytes); await writeFile(`${file}.v1-backup`, 'another history')
    await expect(new CouncilStore(f.data).read()).rejects.toThrow('different Council migration backup')
    expect(await readFile(file, 'utf8')).toBe(bytes)
    const migrated = migrateCouncilFile(old)
    migrated.councils[0]!.rounds[0]!.evidence = { source: 'unrecorded' }
    expect(councilFileSchema.safeParse(migrated).success).toBe(false)
    migrated.councils[0]!.rounds[0]!.evidence = {}
    expect(councilFileSchema.safeParse(migrated).success).toBe(false)
  })
})
