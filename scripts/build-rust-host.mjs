import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

export async function buildRustHost(
  outDir = resolve(root, process.env.SOTTO_RUST_HOST_OUT_DIR || 'out/rust-host'),
  { version, target } = {},
) {
  const cargoTargetDir = resolve(root, process.env.CARGO_TARGET_DIR || 'target')
  const rustTarget = (target ?? process.env.SOTTO_RUST_TARGET ?? '').trim()
  const exe = process.platform === 'win32' || rustTarget.includes('windows') ? 'sotto-host.exe' : 'sotto-host'
  const hostVersion = (version ?? process.env.SOTTO_HOST_VERSION ?? process.env.RELEASE_VERSION ?? '').trim()
  const muslEnv = rustTarget === 'x86_64-unknown-linux-musl'
    ? {
        CC_x86_64_unknown_linux_musl: process.env.CC_x86_64_unknown_linux_musl || 'musl-gcc',
        CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER: process.env.CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER || 'musl-gcc',
      }
    : {}
  const buildEnv = {
    ...process.env,
    ...muslEnv,
    CARGO_TARGET_DIR: cargoTargetDir,
    ...(hostVersion ? { SOTTO_HOST_VERSION: hostVersion } : {}),
  }
  const cargoArgs = [
    'build',
    '--release',
    '-p',
    'sotto-host',
    '--bin',
    'sotto-host',
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

  const bytes = await readFile(dest)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(outDir, `${exe}.sha256`), `${sha256}  ${exe}\n`, 'utf8')
  return { binary: dest, sha256, sizeBytes: bytes.byteLength }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildRustHost()
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
