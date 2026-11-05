import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { COUNCIL_EVIDENCE_LIMITS, councilEvidenceLimitsSchema, councilEvidenceManifestSchema, councilEvidencePathSchema,
  councilEvidenceSourceSchema, type CouncilEvidenceEntry, type CouncilEvidenceLimits, type CouncilEvidenceManifest,
  type CouncilEvidenceSource, type CouncilFrozenEvidence } from '../../shared/councilEvidence'
import { hasErrorCode } from '../storage/atomicJsonStore'

const uuid = z.uuid()
const captureRequest = z.object({ source: councilEvidenceSourceSchema, limits: councilEvidenceLimitsSchema }).strict()
const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.next', '.nuxt', 'dist', 'build', 'coverage', 'target', '.DS_Store'])
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const key = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
const inside = (root: string, path: string): boolean => { const child = relative(key(root), key(path)); return child === '' || !child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child) }
const textOf = (bytes: Uint8Array): string | undefined => {
  if (bytes.includes(0)) return undefined
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return undefined }
}
const mediaType = (path: string, bytes: Uint8Array): string => {
  const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.svg': 'image/svg+xml' }
  return types[extname(path).toLowerCase()] ?? (textOf(bytes) === undefined ? 'application/octet-stream' : 'text/plain')
}
const defaultsExclude = (path: string): boolean => path.split('/').some(part => ignored.has(part) || /^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/iu.test(part))
function glob(pattern: string): RegExp {
  let expression = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!
    if (char === '*' && pattern[index + 1] === '*') {
      index++
      if (pattern[index + 1] === '/') { index++; expression += '(?:.*/)?' } else expression += '.*'
    } else if (char === '*') expression += '[^/]*'
    else if (char === '?') expression += '[^/]'
    else expression += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  }
  return new RegExp(`^(?:${expression})(?:/.*)?$`, 'u')
}

type InventoryFile = { path: string; absolute?: string; root?: string; text?: string; artifactId?: string; bytes: number; stamp: string }
type Inventory = { files: InventoryFile[]; excluded: CouncilEvidenceManifest['excluded']; source: CouncilEvidenceManifest['source'] }
const stampOf = (stat: Awaited<ReturnType<typeof lstat>>): string => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
class EvidenceChanged extends Error { constructor() { super('Selected evidence changed during capture. Wait for writes to finish, then capture again.') } }
export class CouncilEvidenceLimit extends Error {
  constructor(readonly actual: { files: number; bytes: number; largest: { path: string; bytes: number }[] }, readonly limits: CouncilEvidenceLimits) {
    super('The selected evidence exceeds its approved limits. Narrow the selection or approve larger limits. No snapshot was published.')
  }
}
export interface CouncilCapturePreview {
  readonly fingerprint: string
  readonly files: number
  readonly bytes: number
  readonly excluded: CouncilEvidenceManifest['excluded']
  readonly largest: readonly { path: string; bytes: number }[]
}
const totals = (inventory: Inventory) => ({ files: inventory.files.length, bytes: inventory.files.reduce((sum, file) => sum + file.bytes, 0),
  largest: inventory.files.map(({ path, bytes }) => ({ path, bytes })).sort((a, b) => b.bytes - a.bytes).slice(0, 10) })
const fingerprint = (inventory: Inventory): string => hash(JSON.stringify(inventory))

/** Inventory without invoking Git, following links or reading a selected file's contents. */
async function inventory(source: CouncilEvidenceSource): Promise<Inventory> {
  const result: Inventory = { files: [], excluded: [], source: source.kind === 'artifacts' ? { kind: 'artifacts' } : { kind: source.kind, root: source.root,
    paths: source.paths, exclude: source.exclude,
    ...source.kind === 'git' ? { commit: source.commit, branch: source.branch, dirty: source.dirty } : {} } }
  const names = new Set<string>()
  const add = (file: InventoryFile): void => {
    councilEvidencePathSchema.parse(file.path)
    if (names.has(file.path.toLowerCase())) throw new Error('Selected evidence has overlapping or duplicate file names. Choose each file once.')
    names.add(file.path.toLowerCase()); result.files.push(file)
    if (result.files.length > 100_000) throw new Error('Select fewer than 100,000 evidence files.')
  }
  if (source.kind === 'artifacts') {
    for (const item of source.items) {
      if (item.content.kind === 'text') add({ path: item.path, text: item.content.text, artifactId: item.artifactId, bytes: Buffer.byteLength(item.content.text), stamp: hash(item.content.text) })
      else {
        if (!isAbsolute(item.content.path)) throw new Error('Select an absolute artifact file path.')
        const absolute = resolve(item.content.path), root = await realpath(dirname(absolute)), stat = await lstat(absolute)
        if (stat.isSymbolicLink() || !stat.isFile()) { result.excluded.push({ path: item.path, reason: stat.isSymbolicLink() ? 'link' : 'not-file' }); continue }
        add({ path: item.path, absolute, root, artifactId: item.artifactId, bytes: stat.size, stamp: stampOf(stat) })
      }
    }
  } else {
    if (!isAbsolute(source.root)) throw new Error('Select an absolute evidence folder.')
    const root = await realpath(source.root), excludes = source.exclude.map(glob), visited = new Set<string>()
    if (!(await lstat(root)).isDirectory()) throw new Error('The evidence root is not a folder.')
    result.source = source.kind === 'folder' ? { kind: 'folder', root, paths: source.paths, exclude: source.exclude }
      : { kind: 'git', root, paths: source.paths, exclude: source.exclude, commit: source.commit, branch: source.branch, dirty: source.dirty }
    const walk = async (name: string, explicit: boolean): Promise<void> => {
      if (visited.has(name)) return
      visited.add(name)
      if (visited.size > 100_000) throw new Error('Narrow the evidence selection to fewer than 100,000 entries.')
      const absolute = resolve(root, name), stat = await lstat(absolute)
      if (stat.isSymbolicLink()) { result.excluded.push({ path: name, reason: 'link' }); return }
      if (!inside(root, await realpath(absolute))) throw new EvidenceChanged()
      if (name && (name.split('/').includes('.git') || (!explicit || !stat.isFile()) && defaultsExclude(name) || excludes.some(pattern => pattern.test(name)))) {
        result.excluded.push({ path: name, reason: 'excluded' }); return
      }
      if (stat.isDirectory()) {
        for (const child of (await readdir(absolute)).sort()) await walk(name ? `${name}/${child}` : child, false)
      } else if (stat.isFile()) add({ path: name, absolute, root, bytes: stat.size, stamp: stampOf(stat) })
      else result.excluded.push({ path: name, reason: 'not-file' })
    }
    // Explicit descendants go first, so a selected file can override its parent's default exclusion.
    for (const selected of source.paths.length ? [...source.paths].sort((a, b) => b.length - a.length) : ['']) await walk(selected, true)
  }
  result.files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  result.excluded.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  return result
}

async function readSelected(file: InventoryFile): Promise<Buffer> {
  if (file.text !== undefined) return Buffer.from(file.text)
  const absolute = file.absolute!, root = file.root!
  if (!inside(root, await realpath(absolute))) throw new EvidenceChanged()
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || stampOf(before) !== file.stamp) throw new EvidenceChanged()
    // Bound the read even if a writer grows the source after its size was checked.
    const buffer = Buffer.alloc(file.bytes + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length !== file.bytes) throw new EvidenceChanged()
    const bytes = buffer.subarray(0, length)
    if (stampOf(await handle.stat()) !== file.stamp || stampOf(await lstat(absolute)) !== file.stamp || !inside(root, await realpath(absolute))) throw new EvidenceChanged()
    return bytes
  } finally { await handle.close() }
}

/** Canonical bytes never become a provider's working directory. Only owned IDs can address this store. */
export class CouncilEvidenceStore {
  private readonly root: string
  constructor(directory: string, readonly councilId: string, readonly retained: boolean) {
    uuid.parse(councilId)
    this.root = join(directory, 'council-evidence', retained ? 'retained' : 'temporary', councilId)
  }
  private path(id: string): string { uuid.parse(id); return join(this.root, 'snapshots', id) }

  async preview(source: CouncilEvidenceSource, limits = COUNCIL_EVIDENCE_LIMITS): Promise<CouncilCapturePreview> {
    const request = captureRequest.parse({ source, limits }), selected = await inventory(request.source), actual = totals(selected)
    if (actual.files > request.limits.files || actual.bytes > request.limits.bytes) throw new CouncilEvidenceLimit(actual, request.limits)
    return { ...actual, fingerprint: fingerprint(selected), excluded: selected.excluded }
  }

  async capture(source: CouncilEvidenceSource, options: { limits?: CouncilEvidenceLimits; approvedPreview?: string } = {}): Promise<CouncilFrozenEvidence> {
    const request = captureRequest.parse({ source, limits: options.limits ?? COUNCIL_EVIDENCE_LIMITS })
    // One retry catches ordinary concurrent writes, never publishing an incomplete candidate.
    for (let attempt = 0; ; attempt++) {
      try { return await this.captureOnce(request.source, request.limits, options.approvedPreview) }
      catch (error) { if (!(error instanceof EvidenceChanged) || attempt === 1) throw error }
    }
  }
  private async captureOnce(source: CouncilEvidenceSource, limits: CouncilEvidenceLimits, approvedPreview?: string): Promise<CouncilFrozenEvidence> {
    const selected = await inventory(source), actual = totals(selected)
    if (actual.files > limits.files || actual.bytes > limits.bytes) throw new CouncilEvidenceLimit(actual, limits)
    if (approvedPreview !== undefined && fingerprint(selected) !== approvedPreview) throw new Error('The selected evidence changed after its preview. Review and approve it again.')
    let retainedBytes = 0
    for (const name of await readdir(join(this.root, 'snapshots')).catch((error: unknown) => { if (hasErrorCode(error, 'ENOENT')) return []; throw error })) {
      if (uuid.safeParse(name).success) {
        const manifest = councilEvidenceManifestSchema.parse(JSON.parse(await readFile(join(this.path(name), 'manifest.json'), 'utf8')))
        retainedBytes += manifest.bytes
      }
    }
    if (retainedBytes + actual.bytes > limits.retainedBytes) throw new CouncilEvidenceLimit({ ...actual, bytes: retainedBytes + actual.bytes }, limits)
    const id = randomUUID(), finalPath = this.path(id), temporary = `${finalPath}.pending`
    await mkdir(join(temporary, 'files'), { recursive: true, mode: 0o700 })
    try {
      const entries: CouncilEvidenceEntry[] = []
      for (const file of selected.files) {
        const bytes = await readSelected(file)
        if (textOf(bytes) === undefined && bytes.length > limits.binaryBytes) throw new CouncilEvidenceLimit(actual, limits)
        const path = join(temporary, 'files', file.path)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(path, bytes, { flag: 'wx', mode: 0o400 })
        entries.push({ path: file.path, bytes: bytes.length, hash: hash(bytes), mediaType: mediaType(file.path, bytes), ...file.artifactId ? { artifactId: file.artifactId } : {} })
      }
      if (fingerprint(await inventory(source)) !== fingerprint(selected)) throw new EvidenceChanged()
      const capturedAt = new Date().toISOString()
      const manifest: CouncilEvidenceManifest = { version: 1, id, capturedAt, source: selected.source, entries, excluded: selected.excluded, bytes: actual.bytes, limits }
      const json = JSON.stringify(manifest)
      await writeFile(join(temporary, 'manifest.json'), json, { flag: 'wx', mode: 0o400 })
      await rename(temporary, finalPath)
      return { kind: 'frozen', id, sourceKind: source.kind, manifestHash: hash(json), files: entries.length, bytes: actual.bytes, retained: this.retained, capturedAt }
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
  }

  async manifest(evidence: CouncilFrozenEvidence): Promise<CouncilEvidenceManifest> {
    if (evidence.removedAt || evidence.retained !== this.retained) throw new Error('That evidence is no longer available.')
    const bytes = await readFile(join(this.path(evidence.id), 'manifest.json'))
    if (hash(bytes) !== evidence.manifestHash) throw new Error('The evidence manifest changed. It cannot be judged or exported.')
    const manifest = councilEvidenceManifestSchema.parse(JSON.parse(bytes.toString('utf8')))
    if (manifest.id !== evidence.id || manifest.source.kind !== evidence.sourceKind || manifest.entries.length !== evidence.files || manifest.bytes !== evidence.bytes) {
      throw new Error('The evidence identity differs from its record.')
    }
    return manifest
  }
  async read(evidence: CouncilFrozenEvidence, path: string, maxBytes = 4_000_000): Promise<Buffer> {
    councilEvidencePathSchema.parse(path)
    const manifest = await this.manifest(evidence), entry = manifest.entries.find(item => item.path === path)
    if (!entry) throw new Error('That file is outside the captured evidence.')
    if (entry.bytes > maxBytes) throw new Error('That file exceeds the read limit. Narrow the evidence or read it as an artifact.')
    return this.readEntry(evidence, entry)
  }
  /** Internal readers pass an entry from manifest(), already validated once at the disk boundary. */
  async readEntry(evidence: CouncilFrozenEvidence, entry: CouncilEvidenceEntry): Promise<Buffer> {
    const root = join(this.path(evidence.id), 'files'), absolute = join(root, entry.path)
    const stat = await lstat(absolute)
    if (stat.isSymbolicLink() || !stat.isFile() || !inside(root, await realpath(absolute))) throw new Error('The evidence file is no longer a regular captured file.')
    const bytes = await readFile(absolute)
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.hash) throw new Error('The captured file changed. It cannot be judged or exported.')
    return bytes
  }
  async citation(evidence: CouncilFrozenEvidence, path: string, start: number, end: number, quote: string): Promise<'matches' | 'differs' | 'missing' | 'unchecked'> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return 'unchecked'
    try {
      const text = textOf(await this.read(evidence, path))
      if (text === undefined) return 'unchecked'
      const lines = text.split(/\r?\n/u)
      if (end > lines.length) return 'missing'
      const words = lines.slice(start - 1, end).map(line => line.trim()).filter(Boolean)
      return words.length && words.every(line => quote.includes(line)) ? 'matches' : 'differs'
    } catch (error) { return hasErrorCode(error, 'ENOENT') || error instanceof Error && error.message === 'That file is outside the captured evidence.' ? 'missing' : 'unchecked' }
  }
  async export(evidence: CouncilFrozenEvidence, destination: string): Promise<void> {
    if (!isAbsolute(destination)) throw new Error('Choose an absolute path for the new export folder.')
    const manifest = await this.manifest(evidence)
    // Fails if anything already occupies this path. Cleanup owns it only after this succeeds.
    await mkdir(destination, { mode: 0o700 })
    try {
      for (const entry of manifest.entries) {
        const bytes = await this.readEntry(evidence, entry), path = join(destination, 'files', entry.path)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
      }
      await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 })
    } catch (error) { await rm(destination, { recursive: true, force: true }); throw error }
  }
  async remove(evidence: CouncilFrozenEvidence): Promise<void> {
    await rm(this.path(evidence.id), { recursive: true, force: true })
  }
  async clear(): Promise<void> { await rm(this.root, { recursive: true, force: true }) }
  /** A crash can leave provisional bytes; those can never be resumed as published evidence. */
  async discardPending(): Promise<void> {
    for (const name of await readdir(join(this.root, 'snapshots')).catch((error: unknown) => { if (hasErrorCode(error, 'ENOENT')) return []; throw error })) {
      if (name.endsWith('.pending') && uuid.safeParse(name.slice(0, -8)).success) await rm(join(this.root, 'snapshots', name), { recursive: true, force: true })
    }
  }
}

export interface CouncilEvidenceChange { readonly path: string; readonly kind: 'added' | 'removed' | 'changed'; readonly binary: boolean; readonly before?: string; readonly after?: string; readonly truncated?: boolean }
/** Manifest comparison, not a live-source or Git diff. Bounded paired text keeps binary evidence honest. */
export async function compareCouncilEvidence(store: CouncilEvidenceStore, before: CouncilFrozenEvidence, after: CouncilFrozenEvidence): Promise<CouncilEvidenceChange[]> {
  const old = await store.manifest(before), next = await store.manifest(after), previous = new Map(old.entries.map(entry => [entry.path, entry])), current = new Map(next.entries.map(entry => [entry.path, entry]))
  const changes: CouncilEvidenceChange[] = []
  let textBudget = 64_000
  for (const path of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
    const left = previous.get(path), right = current.get(path)
    if (left?.hash === right?.hash) continue
    const binary = [left, right].some(entry => entry && !entry.mediaType.startsWith('text/') && entry.mediaType !== 'image/svg+xml')
    const change: CouncilEvidenceChange = { path, kind: !left ? 'added' : !right ? 'removed' : 'changed', binary }
    if (!binary && textBudget > 0) {
      const texts: { before?: string; after?: string; truncated?: boolean } = {}
      for (const [name, evidence, entry] of [['before', before, left], ['after', after, right]] as const) {
        if (!entry) continue
        if (entry.bytes > 4_000_000) { texts.truncated = true; continue }
        const text = textOf(await store.readEntry(evidence, entry))
        if (text === undefined) { texts.truncated = true; continue }
        texts[name] = text.slice(0, Math.min(4_000, textBudget)); textBudget -= texts[name]!.length
        if (texts[name]!.length < text.length) texts.truncated = true
      }
      changes.push({ ...change, ...texts })
    } else changes.push(binary ? change : { ...change, truncated: true })
  }
  return changes
}

/** Remove only the history-off working store on restart, never selected source files. */
export async function clearTemporaryCouncilEvidence(directory: string): Promise<void> {
  await rm(join(directory, 'council-evidence', 'temporary'), { recursive: true, force: true })
  await removeJudgeFiles(join(directory, 'council-evidence', 'judges'))
  const retained = join(directory, 'council-evidence', 'retained')
  for (const id of await readdir(retained).catch((error: unknown) => { if (hasErrorCode(error, 'ENOENT')) return []; throw error })) {
    if (uuid.safeParse(id).success) await new CouncilEvidenceStore(directory, id, true).discardPending()
  }
}

async function removeJudgeFiles(path: string): Promise<void> {
  // Windows marks read-only files separately; make only owned files removable before disposal.
  const writable = async (folder: string): Promise<void> => {
    await chmod(folder, 0o700)
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const child = join(folder, item.name)
      if (item.isDirectory()) await writable(child)
      else if (item.isFile()) await chmod(child, 0o600)
    }
  }
  await writable(path).catch((error: unknown) => { if (!hasErrorCode(error, 'ENOENT')) throw error })
  await rm(path, { recursive: true, force: true })
}

/** A judge gets an owned, disposable copy. Provider restrictions are still required; chmod is not a sandbox. */
export async function createCouncilJudgeWorkspace(directory: string, councilId: string, threadId: string,
  store: CouncilEvidenceStore, exhibits: readonly { letter: string; evidence: CouncilFrozenEvidence }[]): Promise<{ path: string; remove(): Promise<void> }> {
  uuid.parse(councilId); uuid.parse(threadId)
  const path = join(directory, 'council-evidence', 'judges', councilId, threadId)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await mkdir(path, { mode: 0o700 })
  const remove = (): Promise<void> => removeJudgeFiles(path)
  try {
    const letters = new Set<string>()
    for (const { letter, evidence } of exhibits) {
      if (!/^[A-Z]$/u.test(letter) || letters.has(letter)) throw new Error('Each exhibit needs a unique letter.')
      letters.add(letter)
      const manifest = await store.manifest(evidence)
      for (const entry of manifest.entries) {
        const target = join(path, letter, entry.path)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await writeFile(target, await store.readEntry(evidence, entry), { flag: 'wx', mode: 0o400 })
      }
    }
    const readOnly = async (folder: string): Promise<void> => {
      for (const item of await readdir(folder, { withFileTypes: true })) if (item.isDirectory()) await readOnly(join(folder, item.name))
      await chmod(folder, 0o500)
    }
    await readOnly(path)
    return { path, remove }
  } catch (error) { await remove(); throw error }
}
