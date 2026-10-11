import { owlReleaseSource } from './stable-promotion.mjs'

/** The packaged manifest names the build; provenance, never the release checkout, names its source. */
export function owlPublication(version, provenance, notes) {
  if (/^Source commit:/mu.test(notes)) throw new Error('Leave Source commit out of custom notes; publication adds the provenance source once.')
  const sourceCommit = provenance?.sourceCommit
  const release = owlReleaseSource({ tag_name: `v${version}`, body: `Source commit: ${sourceCommit}` })
  if (sourceCommit !== release.sourceCommit) throw new Error('Owl provenance must name a full lower-case source commit.')
  return { tag: `v${version}`, title: `Sotto Owl ${version} (${sourceCommit.slice(0, 12)})`,
    body: `${notes.trim()}\n\nSource commit: ${sourceCommit}\n` }
}
