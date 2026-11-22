import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

function parseCliOptions(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--version' && argv[i + 1]) {
      options.version = argv[++i]
    } else if (arg === '--target' && argv[i + 1]) {
      options.target = argv[++i]
    } else if (arg === '--out-dir' && argv[i + 1]) {
      options.outDir = resolve(root, argv[++i])
    } else {
      throw new Error(`Unknown build-rust-engine argument: ${arg}`)
    }
  }
  return options
}

export async function buildRustEngine(options = {}) {
  const outDir = options.outDir ?? resolve(root, process.env.SOTTO_RUST_ENGINE_OUT_DIR || 'dist/rust-engine')
  const cargoTargetDir = resolve(root, process.env.CARGO_TARGET_DIR || 'target')
  const rustTarget = (options.target ?? process.env.SOTTO_RUST_TARGET ?? '').trim()
  const exe = process.platform === 'win32' || rustTarget.includes('windows') ? 'sotto-engine.exe' : 'sotto-engine'
  const engineVersion = (options.version ?? process.env.SOTTO_HOST_VERSION ?? process.env.RELEASE_VERSION ?? '').trim()
  const buildEnv = {
    ...process.env,
    CARGO_TARGET_DIR: cargoTargetDir,
    ...(engineVersion ? { SOTTO_HOST_VERSION: engineVersion } : {}),
  }
  const cargoArgs = [
    'build',
    '--release',
    '-p',
    'sotto-engine',
    '--bin',
    'sotto-engine',
    '--locked',
    ...(rustTarget ? ['--target', rustTarget] : []),
  ]

  execFileSync('cargo', cargoArgs, {
    cwd: root,
    stdio: 'inherit',
    env: buildEnv,
  })

  const built = join(cargoTargetDir, ...(rustTarget ? [rustTarget] : []), 'release', exe)
  await mkdir(outDir, { recursive: true })
  const dest = join(outDir, exe)
  await copyFile(built, dest)
  if (process.platform !== 'win32') await chmod(dest, 0o755)

  const bytes = await readFile(dest)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(outDir, `${exe}.sha256`), `${sha256}  ${exe}\n`, 'utf8')
  return { binary: dest, sha256, sizeBytes: bytes.byteLength }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildRustEngine(parseCliOptions(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
