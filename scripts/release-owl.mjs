// npm run release:owl [-- --notes-file release/notes.md]; prepares notes/sums and prints publishing commands only.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { readAsarText } from './asar-entries.mjs'
import { owlPublication } from './owl-publication.mjs'
import { readBuildInputsRevision } from './release-provenance.mjs'
import { releaseCheckout, RELEASE_REPOSITORY } from './stable-promotion.mjs'

const root = resolve(import.meta.dirname, '..')
try {
  const args = process.argv.slice(2)
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--notes-file')) throw new Error('Usage: npm run release:owl [-- --notes-file release/notes.md]')
  const provenance = JSON.parse(await readFile(resolve(root, 'out/build-provenance.json'), 'utf8'))
  const asar = resolve(root, 'release/win-unpacked/resources/app.asar')
  const packagedProvenance = JSON.parse(readAsarText(asar, 'out/build-provenance.json'))
  const version = JSON.parse(readAsarText(asar, 'package.json')).version
  const checkout = releaseCheckout(root)
  if (!checkout.clean || checkout.sourceCommit !== provenance.sourceCommit ||
    provenance.buildInputsRevision !== await readBuildInputsRevision(root) || JSON.stringify(provenance) !== JSON.stringify(packagedProvenance)) {
    throw new Error('The Owl package must be rebuilt from this clean source commit before publication commands can be prepared.')
  }
  const notes = args.length ? await readFile(resolve(root, args[1]), 'utf8') : 'Windows preview. Installs over Sotto and shares its data. Watcher is available only in Owl builds.'
  const publication = owlPublication(version, provenance, notes)
  const files = [`release/Sotto-Owl-Setup-${version}.exe`, `release/Sotto-Owl-Setup-${version}.exe.blockmap`, 'release/owl.yml']
  const sums = await Promise.all(files.map(async path => `${createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')}  ${basename(path)}`))
  await writeFile(resolve(root, 'release/owl-notes.md'), publication.body)
  await writeFile(resolve(root, 'release/SHA256SUMS.txt'), sums.join('\n') + '\n')
  const quote = value => `'${value.replaceAll("'", "''")}'`
  process.stdout.write('Prepared release/owl-notes.md and release/SHA256SUMS.txt. Review them; the following PowerShell commands publish:\n')
  process.stdout.write(`gh release create ${quote(publication.tag)} ${files.map(quote).join(' ')} --repo ${RELEASE_REPOSITORY} --title ${quote(publication.title)} --prerelease --latest=false --notes-file 'release/owl-notes.md'\n`)
  process.stdout.write(`gh release upload ${quote(publication.tag)} 'release/SHA256SUMS.txt' --repo ${RELEASE_REPOSITORY}\n`)
  process.stdout.write(`gh release view ${quote(publication.tag)} --repo ${RELEASE_REPOSITORY} --json tagName,name,body,isPrerelease,assets\n`)
  process.stdout.write(`gh api repos/${RELEASE_REPOSITORY}/releases/latest --jq .tag_name\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
