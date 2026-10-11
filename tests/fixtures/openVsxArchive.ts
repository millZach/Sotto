import { createZip } from '../../src/main/themes/openVsxFixture'
import type { OpenVsxThemeExtension } from '../../src/shared/themes/bridge'

export const extension: OpenVsxThemeExtension = {
  id: 'probe.theme', namespace: 'probe', name: 'theme', collectionId: 'open-vsx:probe.theme',
  displayName: 'Probe', description: '', downloadCount: 0, sourceUrl: null, version: '1.0.0', license: 'MIT',
}
export const contribution = { label: 'Probe Dark', uiTheme: 'vs-dark', path: './themes/dark.json' }
export const theme = { name: 'Probe Dark', type: 'dark', colors: { 'editor.background': '#111111', 'editor.foreground': '#eeeeee' } }
export const manifest = (overrides: Record<string, unknown> = {}) => ({
  publisher: 'probe', name: 'theme', version: '1.0.0', license: 'MIT', contributes: { themes: [contribution] }, ...overrides,
})
export function archive(overrides: Record<string, unknown> = {}, extraFiles: Record<string, string> = {}, themeText = JSON.stringify(theme)): Buffer {
  return createZip(Object.entries({
    'extension/package.json': JSON.stringify(manifest(overrides)), 'extension/themes/dark.json': themeText, ...extraFiles,
  }).map(([name, data]) => ({ name, data, stored: true })))
}
