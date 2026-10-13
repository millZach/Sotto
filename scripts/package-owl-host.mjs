// npm run package:host:owl -- --version 0.1.38-owl.20261012.1 --source <full SHA>
import { lstat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { packageHost } from './package-host.mjs'
import { checkedOwlHostVersion, verifyOwlHostArtifact } from './owl-host-artifacts.mjs'
import { releaseCheckout } from './stable-promotion.mjs'

const root = resolve(import.meta.dirname, '..')
export function owlHostArguments(args) {
  if (args.length !== 4 || args[0] !== '--version' || args[2] !== '--source') throw new Error('Usage: npm run package:host:owl -- --version <full Owl version> --source <full SHA>')
  return { version: checkedOwlHostVersion(args[1]), sourceCommit: args[3] }
}
function checkedSource(version, sourceCommit, checkout) {
  checkedOwlHostVersion(version)
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit ?? '') || !checkout.clean || checkout.sourceCommit !== sourceCommit) throw new Error('Build the Owl host from the requested clean full source commit')
}
/** The explicit desktop version/source pair is checked both sides of native packaging. */
export async function packageOwlHost({ version, sourceCommit, checkout = () => releaseCheckout(root), packageArchive = packageHost, verifyArchive = verifyOwlHostArtifact,
  releaseDir = resolve(root, process.env.SOTTO_HOST_RELEASE_DIR || 'release'), writeReceipt = (path, receipt) => writeFile(path, JSON.stringify(receipt, null, 2) + '\n') } = {}) {
  checkedSource(version, sourceCommit, checkout())
  const filename = `Sotto-host-${version}-${process.platform}-${process.arch}.tar.gz`
  for (const path of [resolve(releaseDir, filename), resolve(releaseDir, `${filename}.sha256`)]) {
    if (await lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) throw new Error('The Owl host version already has an artifact here. Choose a new build number')
  }
  const archive = await packageArchive({ version, releaseDir })
  checkedSource(version, sourceCommit, checkout())
  if (basename(archive) !== filename) throw new Error('Owl host packaging must produce this machine\'s native archive')
  const artifact = await verifyArchive(archive, { version, sourceCommit })
  checkedSource(version, sourceCommit, checkout())
  const receipt = { version: 1, kind: 'sotto-owl-host', sottoVersion: version, sourceCommit, archive: basename(artifact.archive), sha256: artifact.sha256, platform: artifact.platform, arch: artifact.arch }
  await writeReceipt(`${archive}.owl-receipt.json`, receipt)
  return { archive, sidecar: `${archive}.sha256`, receipt }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await packageOwlHost(owlHostArguments(process.argv.slice(2))); process.stdout.write(JSON.stringify(result, null, 2) + '\n') }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
