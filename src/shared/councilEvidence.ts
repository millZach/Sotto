import { z } from 'zod'

/** Portable names, including on Windows; never a native or parent-relative path. */
export const councilEvidencePathSchema = z.string().min(1).max(1_024).refine(path =>
  // eslint-disable-next-line no-control-regex -- Captured file names must reject NUL and control bytes.
  path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && !/[\\\x00-\x1f<>:"|?*]/u.test(part)
    && !/[. ]$/u.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)), 'Choose a relative file name.')
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const count = z.number().int().nonnegative()
const path = z.string().min(1).max(4_096)

export const councilEvidenceLimitsSchema = z.object({
  files: z.number().int().positive().max(100_000),
  bytes: z.number().int().positive().max(10 * 1_024 ** 3),
  binaryBytes: z.number().int().positive().max(1_024 ** 3),
  retainedBytes: z.number().int().positive().max(100 * 1_024 ** 3),
}).strict()
export const COUNCIL_EVIDENCE_LIMITS: CouncilEvidenceLimits = { files: 10_000, bytes: 100 * 1_024 ** 2, binaryBytes: 20 * 1_024 ** 2, retainedBytes: 1_024 ** 3 }
export type CouncilEvidenceLimits = z.infer<typeof councilEvidenceLimitsSchema>

const folderFields = {
  root: path,
  /** Empty selects the root; explicitly named files may override default exclusions. */
  paths: z.array(councilEvidencePathSchema).max(10_000),
  /** Simple path globs: * within a segment, ** across segments, ? for one character. */
  exclude: z.array(z.string().min(1).max(1_024)).max(100),
}
export const councilEvidenceSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('folder'), ...folderFields }).strict(),
  z.object({ kind: z.literal('git'), ...folderFields,
    /** Provenance supplied by the Git capture adapter; never needed for reading or exporting. */
    commit: z.string().max(64).optional(), branch: z.string().max(512).optional(), dirty: z.boolean().optional(),
  }).strict(),
  z.object({ kind: z.literal('artifacts'), items: z.array(z.object({
    path: councilEvidencePathSchema, artifactId: z.string().min(1).max(512),
    content: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('text'), text: z.string().max(4_000_000) }).strict(),
      z.object({ kind: z.literal('file'), path }).strict(),
    ]),
  }).strict()).max(10_000) }).strict(),
])
export type CouncilEvidenceSource = z.infer<typeof councilEvidenceSourceSchema>

export const councilEvidenceEntrySchema = z.object({
  path: councilEvidencePathSchema, bytes: count, hash: digest, mediaType: z.string().min(1).max(128),
  artifactId: z.string().max(512).optional(),
}).strict()
export type CouncilEvidenceEntry = z.infer<typeof councilEvidenceEntrySchema>
const exclusion = z.object({ path: z.string().max(4_096), reason: z.enum(['excluded', 'link', 'not-file']) }).strict()
export const councilEvidenceManifestSchema = z.object({
  version: z.literal(1), id: z.uuid(), capturedAt: z.iso.datetime(),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('folder'), ...folderFields }).strict(),
    z.object({ kind: z.literal('git'), ...folderFields, commit: z.string().max(64).optional(), branch: z.string().max(512).optional(), dirty: z.boolean().optional() }).strict(),
    z.object({ kind: z.literal('artifacts') }).strict(),
  ]),
  entries: z.array(councilEvidenceEntrySchema).max(100_000),
  excluded: z.array(exclusion).max(100_000), bytes: count, limits: councilEvidenceLimitsSchema,
}).strict().superRefine((manifest, ctx) => {
  const names = new Set<string>()
  for (const entry of manifest.entries) {
    const key = entry.path.toLowerCase()
    if (names.has(key)) ctx.addIssue({ code: 'custom', message: 'Evidence contains duplicate file names.' })
    names.add(key)
  }
  if (manifest.bytes !== manifest.entries.reduce((total, entry) => total + entry.bytes, 0)) ctx.addIssue({ code: 'custom', message: 'Evidence byte total differs.' })
})
export type CouncilEvidenceManifest = z.infer<typeof councilEvidenceManifestSchema>

/** Safe lifecycle metadata. The source paths and words live only in the retained manifest. */
export const councilFrozenEvidenceSchema = z.object({
  kind: z.literal('frozen'), id: z.uuid(), sourceKind: z.enum(['git', 'folder', 'artifacts']),
  manifestHash: digest, files: count, bytes: count, retained: z.boolean(), capturedAt: z.iso.datetime(), removedAt: z.iso.datetime().optional(),
}).strict()
export type CouncilFrozenEvidence = z.infer<typeof councilFrozenEvidenceSchema>
export const councilLegacySnapshotSchema = z.object({
  path: z.string().max(4_096), repositoryRoot: z.string().max(4_096), commit: z.string().max(64), branch: z.string().max(512),
  untracked: count, dirty: z.boolean().optional(), removedAt: z.iso.datetime().optional(),
}).strict()
export const councilEvidenceSchema = z.discriminatedUnion('kind', [
  councilFrozenEvidenceSchema,
  z.object({ kind: z.literal('legacyGit'), id: z.string().min(1).max(512), snapshot: councilLegacySnapshotSchema }).strict(),
  z.object({ kind: z.literal('legacyLive'), id: z.string().min(1).max(512) }).strict(),
])
export type CouncilEvidence = z.infer<typeof councilEvidenceSchema>

export const councilRoundEvidenceSchema = z.object({
  source: z.string().min(1).max(512).optional(), baseline: z.uuid().optional(), candidate: z.uuid().optional(),
  incumbent: z.uuid().optional(), reference: z.uuid().optional(),
}).strict()
