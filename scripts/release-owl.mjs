// npm run release:owl [-- --notes-file release/notes.md --host-archive <path> ...]; prints publishing commands only.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readAsarText } from './asar-entries.mjs'
import { owlPublication } from './owl-publication.mjs'
import { verifyOwlHostArtifact } from './owl-host-artifacts.mjs'
import { readBuildInputsRevision } from './release-provenance.mjs'
import { releaseCheckout, RELEASE_REPOSITORY } from './stable-promotion.mjs'

const root = resolve(import.meta.dirname, '..')
export function owlPublicationArguments(args) {
  let notesFile
  const hostArchives = []
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error('Supply a path after each Owl publication option')
    if (flag === '--notes-file' && notesFile === undefined) notesFile = value
    else if (flag === '--host-archive') hostArchives.push(value)
    else throw new Error('Usage: npm run release:owl [-- --notes-file <path> --host-archive <path> ...]')
  }
  if (hostArchives.length > 20) throw new Error('Supply at most twenty native host archives')
  return { notesFile, hostArchives }
}
async function readDesktop(rootDirectory) {
  const provenance = JSON.parse(await readFile(resolve(rootDirectory, 'out/build-provenance.json'), 'utf8'))
  const asar = resolve(rootDirectory, 'release/win-unpacked/resources/app.asar')
  return { provenance, packagedProvenance: JSON.parse(readAsarText(asar, 'out/build-provenance.json')), version: JSON.parse(readAsarText(asar, 'package.json')).version }
}
/** Verify the desktop and every supplied native host's bytes; returning commands never executes gh. */
export async function prepareOwlRelease({ rootDirectory = root, args = [], desktop = readDesktop, checkout = releaseCheckout,
  inputsRevision = readBuildInputsRevision, verifyHost = verifyOwlHostArtifact } = {}) {
  const options = owlPublicationArguments(args)
  const { provenance, packagedProvenance, version } = await desktop(rootDirectory)
  const assertCheckout = async () => {
    const current = checkout(rootDirectory)
    if (!current.clean || current.sourceCommit !== provenance.sourceCommit ||
      provenance.buildInputsRevision !== await inputsRevision(rootDirectory) || JSON.stringify(provenance) !== JSON.stringify(packagedProvenance)) {
      throw new Error('The Owl package must be rebuilt from this clean source commit before publication commands can be prepared.')
    }
  }
  await assertCheckout()
  const notes = options.notesFile ? await readFile(resolve(rootDirectory, options.notesFile), 'utf8') : 'Windows preview. Installs over Sotto and shares its data. Owl features are available in this build.'
  const publication = owlPublication(version, provenance, notes)
  const files = [`release/Sotto-Owl-Setup-${version}.exe`, `release/Sotto-Owl-Setup-${version}.exe.blockmap`, 'release/owl.yml']
  const verifiedDigests = new Map()
  for (const archive of options.hostArchives) {
    const path = resolve(rootDirectory, archive)
    const artifact = await verifyHost(path, { version, sourceCommit: provenance.sourceCommit })
    verifiedDigests.set(path, artifact.sha256); verifiedDigests.set(`${path}.sha256`, artifact.sidecarSha256)
    files.push(path, `${path}.sha256`)
  }
  if (new Set(files.map(path => basename(path))).size !== files.length) throw new Error('Each Owl release asset must have a unique filename')
  // Host and desktop build-input inventories differ. Their full source and packaged version must agree instead.
  const sums = await Promise.all(files.map(async path => {
    const digest = createHash('sha256').update(await readFile(resolve(rootDirectory, path))).digest('hex')
    if (verifiedDigests.has(path) && verifiedDigests.get(path) !== digest) throw new Error('A host archive or sidecar changed after its release verification')
    return `${digest}  ${basename(path)}`
  }))
  await assertCheckout()
  await writeFile(resolve(rootDirectory, 'release/owl-notes.md'), publication.body)
  await writeFile(resolve(rootDirectory, 'release/SHA256SUMS.txt'), sums.join('\n') + '\n')
  const quote = value => `'${value.replaceAll("'", "''")}'`
  const commands = [
    `gh release create ${quote(publication.tag)} ${files.map(quote).join(' ')} --repo ${RELEASE_REPOSITORY} --title ${quote(publication.title)} --prerelease --latest=false --notes-file 'release/owl-notes.md'`,
    `gh release upload ${quote(publication.tag)} 'release/SHA256SUMS.txt' --repo ${RELEASE_REPOSITORY}`,
    `gh release view ${quote(publication.tag)} --repo ${RELEASE_REPOSITORY} --json tagName,name,body,isPrerelease,assets`,
    `gh api repos/${RELEASE_REPOSITORY}/releases/latest --jq .tag_name`,
  ]
  return { publication, files, sums, commands }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const prepared = await prepareOwlRelease({ args: process.argv.slice(2) })
    process.stdout.write('Prepared release/owl-notes.md and release/SHA256SUMS.txt. Review them; the following PowerShell commands publish:\n' + prepared.commands.join('\n') + '\n')
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
