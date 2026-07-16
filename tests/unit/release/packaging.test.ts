import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('Windows release contract', () => {
  it('packages only runtime-external dependencies and verifies source and packaged resources', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      scripts: Record<string, string>
    }

    expect(Object.keys(packageJson.dependencies)).toEqual(['zod'])
    expect(packageJson.devDependencies['@electron/asar']).toBe('3.4.1')
    for (const bundled of ['@huggingface/transformers', 'lucide-react', 'react', 'react-dom']) {
      expect(packageJson.devDependencies[bundled]).toBeTypeOf('string')
    }
    for (const script of ['package:dir', 'package:win']) {
      expect(packageJson.scripts[script]).toMatch(/^npm run model:verify && npm run build && /)
      expect(packageJson.scripts[script]).toContain(
        'node scripts/verify-packaged-resources.mjs release/win-unpacked',
      )
    }

    const viteConfig = read('electron.vite.config.ts')
    const verifier = read('scripts/verify-packaged-resources.mjs')
    expect(viteConfig).toContain("externalDependencyInventory('main')")
    expect(viteConfig).toContain("externalDependencyInventory('preload')")
    expect(verifier).toContain("out/main/external-dependencies.json")
    expect(verifier).toContain("out/preload/external-dependencies.json")
    expect(verifier).not.toContain('.matchAll(')
  })

  it('offers a visible, unchecked desktop-shortcut choice and removes its shortcut on uninstall', () => {
    const builder = read('electron-builder.yml')
    const installer = read('build/installer.nsh')

    expect(builder).toContain('include: build/installer.nsh')
    expect(builder).toContain('createDesktopShortcut: false')
    expect(installer).toContain('Page custom TalkTypeShortcutPageCreate TalkTypeShortcutPageLeave')
    expect(installer).toContain('Create a desktop shortcut')
    expect(installer).toContain('StrCpy $TalkTypeCreateDesktopShortcut ${BST_UNCHECKED}')
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
