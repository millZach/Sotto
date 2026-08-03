import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

export function releasePlatformProfile(platform = process.platform, arch = 'arm64') {
  if (platform === 'win32') return windowsProfile()
  if (platform === 'darwin') return macProfile(arch)
  throw new Error(`Sotto release verification supports win32 and darwin only, not ${platform}`)
}
