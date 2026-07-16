import { resolve } from 'node:path'
import process from 'node:process'

import { readSourceCommit, writeBuildProvenance } from './release-provenance.mjs'

const repositoryRoot = resolve(import.meta.dirname, '..')
const provenance = await writeBuildProvenance({
  outRoot: resolve(repositoryRoot, 'out'),
  repositoryRoot,
  sourceCommit: readSourceCommit(repositoryRoot),
})
process.stdout.write(`${JSON.stringify({
  sourceCommit: provenance.sourceCommit,
  buildInputsRevision: provenance.buildInputsRevision,
  buildSha256: provenance.buildSha256,
  artifactCount: provenance.artifacts.length,
}, null, 2)}\n`)
