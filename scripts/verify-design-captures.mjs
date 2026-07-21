import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import process from 'node:process'

import sharp from 'sharp'

import { DESIGN_CAPTURE_REQUIREMENTS, designCaptureTupleKey } from './design-capture-matrix.mjs'

const root = process.cwd()
const manifestPath = resolve(root, 'artifacts/design/app-review/manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const expectedBoundary = {
  mode: 'non-packaged-only',
  environmentGate: 'TALKTYPE_E2E=1',
  packagedRejectionProof: 'tests/unit/main/e2eBoundary.test.ts and scripts/verify-packaged-resources.mjs',
}

if (manifest.version !== 2 || !Array.isArray(manifest.entries) || manifest.count !== manifest.entries.length) {
  throw new Error('Design capture manifest shape or count is invalid')
}
if (JSON.stringify(manifest.captureBoundary) !== JSON.stringify(expectedBoundary)) {
  throw new Error('Design capture boundary proof is missing or unexpected')
}
if (manifest.count !== DESIGN_CAPTURE_REQUIREMENTS.length) {
  throw new Error(`Expected ${DESIGN_CAPTURE_REQUIREMENTS.length} review captures, found ${manifest.count}`)
}

const allowedKeys = new Set([
  'id', 'category', 'state', 'theme', 'scalePercent', 'motion', 'focusTarget', 'source',
  'relativePath', 'width', 'height', 'sha256',
])
const requirementsById = new Map(DESIGN_CAPTURE_REQUIREMENTS.map((requirement) => [requirement.id, requirement]))
const seenIds = new Set()
const seenTuples = new Set()

function isContained(path, approvedRoot) {
  const relation = relative(approvedRoot, path)
  return relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !resolve(relation).startsWith(`${sep}${sep}`)
}

for (const entry of manifest.entries) {
  const keys = Object.keys(entry)
  if (keys.some((key) => !allowedKeys.has(key)) || keys.length !== allowedKeys.size) {
    throw new Error(`Capture entry has missing or unexpected keys: ${entry.id ?? '<unknown>'}`)
  }
  if (typeof entry.id !== 'string' || seenIds.has(entry.id)) throw new Error(`Duplicate or invalid capture id: ${entry.id}`)
  seenIds.add(entry.id)
  const requirement = requirementsById.get(entry.id)
  if (requirement === undefined) throw new Error(`Unexpected capture tuple: ${entry.id}`)
  for (const field of ['category', 'state', 'theme', 'scalePercent', 'motion', 'focusTarget', 'source']) {
    if (entry[field] !== requirement[field]) throw new Error(`Capture ${entry.id} has incorrect ${field}`)
  }
  const tuple = designCaptureTupleKey(entry)
  if (seenTuples.has(tuple)) throw new Error(`Duplicate capture tuple: ${tuple}`)
  seenTuples.add(tuple)
  if (!Number.isInteger(entry.width) || !Number.isInteger(entry.height) || entry.width < 1 || entry.height < 1) {
    throw new Error(`Capture geometry is invalid: ${entry.id}`)
  }
  if (!/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error(`Capture hash is invalid: ${entry.id}`)
  if (typeof entry.relativePath !== 'string' || entry.relativePath.includes('\\') || entry.relativePath.startsWith('/') || entry.relativePath.includes('..')) {
    throw new Error(`Capture path is not canonical: ${entry.id}`)
  }
  const path = resolve(root, entry.relativePath)
  const approvedRoot = resolve(root, entry.source === 'widget-baseline'
    ? 'artifacts/design/baseline'
    : 'artifacts/design/app-review/baseline')
  if (!isContained(path, approvedRoot)) throw new Error(`Capture path escapes its approved root: ${entry.id}`)
  const expectedPrefix = entry.source === 'widget-baseline'
    ? 'artifacts/design/baseline/'
    : 'artifacts/design/app-review/baseline/'
  if (!entry.relativePath.startsWith(expectedPrefix)) throw new Error(`Capture path/source mismatch: ${entry.id}`)

  const image = await readFile(path)
  const hash = createHash('sha256').update(image).digest('hex')
  const decoded = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (hash !== entry.sha256) throw new Error(`Capture hash mismatch: ${entry.relativePath}`)
  if (decoded.info.width !== entry.width || decoded.info.height !== entry.height) throw new Error(`Capture geometry mismatch: ${entry.relativePath}`)

  if (entry.category === 'widget' || entry.state === 'widget-listening') {
    if (entry.source === 'widget-baseline' && (decoded.info.width !== 248 || decoded.info.height !== 88)) throw new Error(`Widget geometry mismatch: ${entry.id}`)
    if (entry.source === 'app-review' && (decoded.info.width < 248 || decoded.info.height < 88)) throw new Error(`Live widget raster is smaller than its 248x88 logical window: ${entry.id}`)
    const alphaAt = (x, y) => decoded.data[(y * decoded.info.width + x) * 4 + 3] ?? 255
    for (let x = 0; x < decoded.info.width; x += 1) {
      if (alphaAt(x, 0) !== 0 || alphaAt(x, decoded.info.height - 1) !== 0) throw new Error(`Widget edge is not transparent: ${entry.id}`)
    }
    for (let y = 0; y < decoded.info.height; y += 1) {
      if (alphaAt(0, y) !== 0 || alphaAt(decoded.info.width - 1, y) !== 0) throw new Error(`Widget edge is not transparent: ${entry.id}`)
    }
  }
}

const expectedIds = [...requirementsById.keys()].sort()
const actualIds = [...seenIds].sort()
if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) throw new Error('Design capture manifest is missing required tuples')

process.stdout.write(`Verified ${manifest.entries.length} exact deterministic design-review tuples.\n`)
