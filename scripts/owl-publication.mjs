import { owlReleaseSource } from './stable-promotion.mjs'

/** The notes a prerelease carries when the release lead supplies none. They name only the platforms attached. */
export function defaultOwlNotes({ mac = false } = {}) {
  if (!mac) return 'Windows preview. Installs over Sotto and shares its data. Owl features are available in this build.'
  return [
    'A preview of the next Sotto for Windows and Apple silicon Macs. It installs over Sotto and shares its data. Owl features are on in this build.',
    "The Mac build runs on Apple silicon only. It is signed with Sotto's Developer ID and notarized by Apple, so macOS opens it like any other app, and it updates itself from the update control, as on Windows.",
    'If your Mac has an earlier Owl that you had to open with Open Anyway, that one cannot update itself to a signed build. Install this one by hand once: open the disk image and drag Sotto to Applications, replacing the old one. After that, Owl updates itself.',
  ].join('\n\n')
}

/** The packaged manifest names the build; provenance, never the release checkout, names its source. */
export function owlPublication(version, provenance, notes) {
  if (/^Source commit:/mu.test(notes)) throw new Error('Leave Source commit out of custom notes; publication adds the provenance source once.')
  const sourceCommit = provenance?.sourceCommit
  const release = owlReleaseSource({ tag_name: `v${version}`, body: `Source commit: ${sourceCommit}` })
  if (sourceCommit !== release.sourceCommit) throw new Error('Owl provenance must name a full lower-case source commit.')
  return { tag: `v${version}`, title: `Sotto Owl ${version} (${sourceCommit.slice(0, 12)})`,
    body: `${notes.trim()}\n\nSource commit: ${sourceCommit}\n` }
}
