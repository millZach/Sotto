// Builds Sotto's Core ML speech helper (native/coreml-asr) on Apple silicon Macs, copies it to
// native/coreml-asr/.build/sotto-coreml-asr (where packaging and a development run look; SwiftPM's
// own output folder differs between Xcode versions) and prints that path. Elsewhere it does nothing.
import { execFileSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  process.stdout.write('Skipping the Core ML speech helper: it only builds on Apple silicon Macs.\n')
  process.exit(0)
}

const packagePath = join(import.meta.dirname, '..', 'native', 'coreml-asr')
// Only the versions pinned in the committed Package.resolved (FluidAudio 0.17.7): a missing or
// stale file fails the build rather than letting SwiftPM pick other versions.
const args = ['build', '-c', 'release', '--arch', 'arm64', '--only-use-versions-from-resolved-file', '--package-path', packagePath]

try {
  execFileSync('swift', args, { stdio: 'inherit' })
  const binDir = execFileSync('swift', [...args, '--show-bin-path'], { encoding: 'utf8' }).trim()
  const output = join(packagePath, '.build', 'sotto-coreml-asr')
  copyFileSync(join(binDir, 'sotto-coreml-asr'), output)
  process.stdout.write(`${output}\n`)
} catch (error) {
  process.stderr.write(`Building the Core ML speech helper failed: ${error.message}\n`)
  process.exit(1)
}
