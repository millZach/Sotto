import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = process.cwd()
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

interface PackageManifest {
  version: string
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  scripts: Record<string, string>
}

interface BuilderTarget {
  target: string
  arch: string[]
}

interface BuilderResource {
  from: string
  to: string
}

interface BuilderConfig {
  win: { target: BuilderTarget[] }
  mac: {
    identity: string | null
    target: BuilderTarget[]
    entitlements: string
    entitlementsInherit: string
    extendInfo: Record<string, string>
    extraResources: BuilderResource[]
  }
  dmg: { artifactName: string; title: string }
  publish: { provider: string; owner: string; repo: string }[]
}

const packageManifest = JSON.parse(read('package.json')) as PackageManifest
const builderConfig = parse(read('electron-builder.yml')) as BuilderConfig

const releaseContracts = [
  {
    platform: 'Windows',
    scripts: ['package:dir', 'package:win'],
    distributableScript: 'package:win',
    outDir: 'release/win-unpacked',
    installer: `release/Sotto Setup ${packageManifest.version}.exe`,
  },
  {
    platform: 'macOS',
    scripts: ['package:dir:mac', 'package:mac'],
    distributableScript: 'package:mac',
    outDir: 'release/mac-arm64',
    installer: `release/Sotto-${packageManifest.version}-arm64.dmg`,
  },
]

describe.each(releaseContracts)(
  '$platform release contract',
  ({ scripts, distributableScript, outDir, installer }) => {
    it('verifies the model, builds, records provenance, and verifies the packaged output', () => {
      for (const script of scripts) {
        const command = packageManifest.scripts[script]
        expect(command).toMatch(/^npm run model:verify && npm run build && /)
        expect(command).toContain('node scripts/write-build-provenance.mjs')
        expect(command).toContain(`node scripts/verify-packaged-resources.mjs ${outDir}`)
      }
    })

    it('points the distributable verification at the artifact name electron-builder emits', () => {
      expect(packageManifest.scripts[distributableScript]).toContain(`--installer "${installer}"`)
    })
  },
)

describe('release contract', () => {
  it('packages only runtime-external dependencies and verifies source and packaged resources', () => {
    expect(Object.keys(packageManifest.dependencies)).toEqual(['zod'])
    expect(packageManifest.devDependencies['@electron/asar']).toBe('3.4.1')
    for (const bundled of ['@huggingface/transformers', 'lucide-react', 'react', 'react-dom']) {
      expect(packageManifest.devDependencies[bundled]).toBeTypeOf('string')
    }
    expect(packageManifest.devDependencies['yaml']).toBeTypeOf('string')

    const viteConfig = read('electron.vite.config.ts')
    const verifier = read('scripts/verify-packaged-resources.mjs')
    expect(viteConfig).toContain("externalDependencyInventory('main')")
    expect(viteConfig).toContain("externalDependencyInventory('preload')")
    expect(verifier).toContain('out/main/external-dependencies.json')
    expect(verifier).toContain('out/preload/external-dependencies.json')
    expect(verifier).not.toContain('.matchAll(')
  })

  it('embeds the GitHub update feed while refusing to publish from any package script', () => {
    expect(builderConfig.publish).toEqual([
      { provider: 'github', owner: 'millZach', repo: 'Sotto' },
    ])
    // The feed exists so app-update.yml lands in the packaged resources. Uploading a
    // release is a deliberate manual act, never a side effect of building one.
    for (const script of ['package:dir', 'package:win', 'package:dir:mac', 'package:mac']) {
      expect(packageManifest.scripts[script]).toContain('--publish never')
    }
  })

  it('compiles the updater into main rather than shipping it as a runtime dependency', () => {
    expect(packageManifest.dependencies['electron-updater']).toBeUndefined()
    expect(packageManifest.devDependencies['electron-updater']).toBeTypeOf('string')
    expect(read('electron.vite.config.ts')).toContain(
      "externalizeDepsPlugin({ exclude: ['electron-updater'] })",
    )
    // Whatever the compile pulls in is redistributed inside app.asar, so the notice
    // inventory has to see it.
    expect(read('electron.vite.config.ts')).toContain('bundledDependencyInventory()')
    expect(read('scripts/verify-notices.mjs')).toContain(
      "join(root, 'out', 'main', 'bundled-dependencies.json')",
    )
  })

  it('keeps the shared release scripts free of Windows-only layout assumptions', () => {
    for (const script of [
      'scripts/verify-packaged-resources.mjs',
      'scripts/release-provenance.mjs',
      'scripts/write-build-provenance.mjs',
    ]) {
      const source = read(script)
      expect(source).not.toContain('Sotto.exe')
      // Backslash-separated asar paths ('\\out\\main\\index.js' in source) match nothing
      // when the packaging host is macOS.
      expect(source).not.toContain('\\\\out\\\\')
    }
  })
})

describe('macOS packaging configuration', () => {
  const { mac, dmg } = builderConfig

  it('builds an ad-hoc signed arm64 disk image', () => {
    expect(mac.target).toEqual([{ target: 'dmg', arch: ['arm64'] }])
    // `identity: null` skips signing entirely, and the arm64 kernel refuses to launch an
    // unsigned Mach-O — the resulting app would not start at all.
    expect(mac.identity).not.toBeNull()
    expect(mac.identity).toBe('-')
    expect(dmg.artifactName).toBe('${productName}-${version}-${arch}.${ext}')
    expect(dmg.title).toBe('${productName} ${version}')
  })

  it('explains both permission prompts the app depends on', () => {
    expect(mac.extendInfo['NSMicrophoneUsageDescription']).toBeTruthy()
    expect(mac.extendInfo['NSAppleEventsUsageDescription']).toBeTruthy()
  })

  it('re-adds the license files electron-builder strips and ships the tray templates', () => {
    const destinations = mac.extraResources.map((resource) => resource.to)
    expect(destinations).toContain('LICENSE.electron.txt')
    expect(destinations).toContain('LICENSES.chromium.html')
    expect(destinations).toContain('tray')
  })

  it('grants the audio and Apple Events entitlements the app needs', () => {
    const entitlements = read(mac.entitlements)
    const inherited = read(mac.entitlementsInherit)

    expect(entitlements).toContain('com.apple.security.device.audio-input')
    expect(entitlements).toContain('com.apple.security.automation.apple-events')
    for (const hardening of [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
      'com.apple.security.cs.allow-dyld-environment-variables',
    ]) {
      expect(entitlements).toContain(hardening)
      expect(inherited).toContain(hardening)
    }
    // Helper processes inherit the app's TCC grants; re-declaring them would prompt twice.
    expect(inherited).not.toContain('com.apple.security.device.audio-input')
    expect(inherited).not.toContain('com.apple.security.automation.apple-events')
  })

  it('leaves the Windows target untouched', () => {
    expect(builderConfig.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
  })
})

describe('Windows installer contract', () => {
  it('offers a visible, unchecked desktop-shortcut choice and removes its shortcut on uninstall', () => {
    const builder = read('electron-builder.yml')
    const installer = read('build/installer.nsh')

    expect(builder).toContain('include: build/installer.nsh')
    expect(builder).toContain('createDesktopShortcut: false')
    expect(installer).toContain('Page custom SottoShortcutPageCreate SottoShortcutPageLeave')
    expect(installer).toContain('Create a desktop shortcut')
    expect(installer).toContain('StrCpy $SottoCreateDesktopShortcut ${BST_UNCHECKED}')
    expect(installer).toContain('CreateShortCut "$newDesktopLink" "$appExe"')
    expect(installer).toContain('WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"')
    expect(installer).toContain('WinShell::UninstShortcut "$oldDesktopLink"')
    expect(installer).toContain('Delete "$oldDesktopLink"')
    expect(installer).toContain('WriteRegDWORD SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" DesktopShortcut')
    expect(installer).toContain('${IfNot} ${isKeepShortcuts}')
  })

  it('documents conservative install headroom and the exact optional shortcut behavior', () => {
    const readme = read('README.md')
    expect(readme).toContain('At least 1.5 GB of free space during installation')
    expect(readme).toContain('The desktop shortcut is optional and unchecked by default')
    expect(readme).toContain('automatically verifies the source model before packaging')
  })
})
