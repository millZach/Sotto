import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function findFile(root, name) {
  if (!root || !existsSync(root)) return null
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path
    if (entry.isDirectory()) {
      const nested = await findFile(path, name)
      if (nested !== null) return nested
    }
  }
  return null
}

async function resolveSevenZip() {
  if (process.env.SOTTO_7ZA_PATH && existsSync(process.env.SOTTO_7ZA_PATH)) {
    return process.env.SOTTO_7ZA_PATH
  }
  const cache = join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache')
  const sevenZip = await findFile(cache, '7za.exe')
  if (sevenZip === null) {
    throw new Error('electron-builder 7-Zip tool is unavailable for installer verification')
  }
  return sevenZip
}

function windowsProfile() {
  return Object.freeze({
    key: 'win32',
    packagedDirName: 'win-unpacked',
    executableLabel: 'Sotto.exe',
    distributableLabel: 'installer',
    applicationRoot: (target) => target,
    executablePath: (target) => join(target, 'Sotto.exe'),
    resourcesPath: (target) => join(target, 'resources'),
    licenseRoot: (target) => target,
    smokeEnvironment: async (profileRoot) => {
      const appData = join(profileRoot, 'AppData', 'Roaming')
      const localAppData = join(profileRoot, 'AppData', 'Local')
      await Promise.all([
        mkdir(appData, { recursive: true }),
        mkdir(localAppData, { recursive: true }),
      ])
      return { APPDATA: appData, LOCALAPPDATA: localAppData }
    },
    smokeArgs: [],
    openDistributable: async (distributablePath, open) => {
      const extractionRoot = await mkdtemp(join(tmpdir(), 'sotto-installer-asar-'))
      try {
        const sevenZip = await resolveSevenZip()
        await execFileAsync(sevenZip, [
          'x', '-y', `-o${extractionRoot}`, distributablePath, 'resources\\app.asar',
        ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
        return await open(join(extractionRoot, 'resources', 'app.asar'))
      } finally {
        await rm(extractionRoot, { recursive: true, force: true })
      }
    },
  })
}

function macProfile(arch) {
  const applicationRoot = (target) => join(target, 'Sotto.app')
  const resourcesPath = (target) => join(applicationRoot(target), 'Contents', 'Resources')
  return Object.freeze({
    key: 'darwin',
    packagedDirName: `mac-${arch}`,
    executableLabel: 'Sotto.app',
    distributableLabel: 'disk image',
    applicationRoot,
    executablePath: (target) => join(applicationRoot(target), 'Contents', 'MacOS', 'Sotto'),
    resourcesPath,
    // Electron's license files live inside the bundle on macOS, so licenses and
    // resources share one root here while Windows keeps them one level apart.
    licenseRoot: resourcesPath,
    smokeEnvironment: async (profileRoot) => {
      const home = join(profileRoot, 'Home')
      await Promise.all([
        mkdir(join(home, 'Library', 'Application Support'), { recursive: true }),
        mkdir(join(home, 'Library', 'Caches'), { recursive: true }),
      ])
      return { HOME: home }
    },
    // The smoke HOME has no login keychain, so a real Keychain write would stop on a native dialog.
    smokeArgs: ['--use-mock-keychain'],
    openDistributable: async (distributablePath, open) => {
      const mountPoint = await mkdtemp(join(tmpdir(), 'sotto-disk-image-'))
      try {
        await execFileAsync('/usr/bin/hdiutil', [
          'attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', mountPoint, distributablePath,
        ])
        try {
          return await open(join(resourcesPath(mountPoint), 'app.asar'))
        } finally {
          await execFileAsync('/usr/bin/hdiutil', ['detach', mountPoint]).catch(async () => {
            await execFileAsync('/usr/bin/hdiutil', ['detach', '-force', mountPoint])
          })
        }
      } finally {
        await rm(mountPoint, { recursive: true, force: true })
      }
    },
  })
}

function linuxProfile() {
  return Object.freeze({
    key: 'linux',
    packagedDirName: 'linux-unpacked',
    executableLabel: 'sotto',
    distributableLabel: 'tarball',
    applicationRoot: (target) => target,
    executablePath: (target) => join(target, 'sotto'),
    resourcesPath: (target) => join(target, 'resources'),
    licenseRoot: (target) => target,
    smokeEnvironment: async (profileRoot) => {
      const home = join(profileRoot, 'Home')
      const config = join(home, '.config')
      await mkdir(config, { recursive: true })
      return { HOME: home, XDG_CONFIG_HOME: config }
    },
    // Release checks must never use the machine's Secret Service.
    smokeArgs: ['--password-store=basic'],
    openDistributable: async (distributablePath, open) => {
      const extractionRoot = await mkdtemp(join(tmpdir(), 'sotto-tarball-'))
      try {
        // GNU tar treats a Windows drive prefix in the archive name as a remote host.
        // A local filename from its own folder works with both GNU tar and bsdtar.
        await execFileAsync('tar', ['-xzpf', basename(distributablePath), '-C', extractionRoot], {
          cwd: dirname(distributablePath), windowsHide: true, maxBuffer: 4 * 1024 * 1024,
        })
        // electron-builder prefixes tar archives with the artifact name, without .tar.gz.
        const root = join(extractionRoot, distributablePath.split(/[\\/]/u).at(-1).replace(/\.tar\.gz$/u, ''))
        return await open(join(root, 'resources', 'app.asar'), root)
      } finally {
        await rm(extractionRoot, { recursive: true, force: true })
      }
    },
  })
}

export function releasePlatformProfile(platform = process.platform, arch = 'arm64') {
  if (platform === 'win32') return windowsProfile()
  if (platform === 'darwin') return macProfile(arch)
  if (platform === 'linux') return linuxProfile()
  throw new Error(`Sotto release verification supports win32, darwin and linux only, not ${platform}`)
}
