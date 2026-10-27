// Runs only under the private process-integration fixture; no Electron or real desktop commands.
// Main's own code runs here, so English is active first, as it is in main (tests/fixtures/desktopMainBundle.ts).
import '../../src/main/interfaceLanguage'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OmarchySetup, type OmarchySetupOptions } from '../../src/main/omarchy/setup'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import type { OmarchyPiece } from '../../src/shared/omarchySetup'

const options = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as Pick<OmarchySetupOptions, 'home' | 'data' | 'resources' | 'environment'>
let settings = structuredClone(DEFAULT_SETTINGS)
try { settings = JSON.parse(await readFile(join(options.data, 'settings.json'), 'utf8')) } catch { /* Fresh fixture. */ }
const engine = new OmarchySetup({ ...options, version: '9.0.0', settings: {
  get: async () => settings,
  update: async patch => {
    settings = { ...settings, ...patch, worktreeCleanup: { ...settings.worktreeCleanup, ...patch.worktreeCleanup } }
    await mkdir(options.data, { recursive: true })
    await writeFile(join(options.data, 'settings.json'), JSON.stringify(settings))
    return settings
  },
} })
const piece = process.argv[3] as OmarchyPiece
await engine.command(process.argv[4] === 'remove' ? { type: 'remove', pieces: [piece] } : { type: 'setup', pieces: [piece], keys: 'give' })
