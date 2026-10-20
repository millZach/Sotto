import { owlReleaseSource } from './stable-promotion.mjs'

/** The notes a prerelease carries when the release lead supplies none. They name only the platforms attached. */
export function defaultOwlNotes({ mac = false } = {}) {
  if (!mac) return 'Windows preview. Installs over Sotto and shares its data. Owl features are available in this build.'
  return [
    'A preview of the next Sotto for Windows and Apple silicon Macs. It installs over Sotto and shares its data. Owl features are on in this build.',
    'The Mac build runs on Apple silicon only. It is not signed by a registered Apple developer yet, so macOS stops it the first time you open it. Open System Settings, choose Privacy & Security, then Open Anyway beside the message about Sotto. Or run this in Terminal once Sotto is in Applications:',
    '    xattr -dr com.apple.quarantine /Applications/Sotto.app',
    'On a Mac, Owl does not update itself yet. Download the next one from its release page.',
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
