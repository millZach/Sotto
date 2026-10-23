import { defineConfig } from '@lingui/conf'
import { formatter } from '@lingui/format-po'

import { INTERFACE_LANGUAGE_CODES, INTERFACE_PSEUDO_LANGUAGES, SOURCE_INTERFACE_LANGUAGE } from './src/shared/interfaceLanguages'

/**
 * Sotto's interface catalogs (ADR-0123). English is the source: each message is written in English where it is used,
 * and `npm run i18n:extract` writes every area's catalog for every language, `src/locales/<area>/<language>.po`.
 *
 * One catalog per area of the tree, so pull requests that translate different areas never touch the same file:
 * - `settings`  src/renderer/src/features/settings, the Settings page
 * - `threads`   src/renderer/src/agents, the Threads page
 * - `tools`     src/renderer/src/tools, Tools and the surfaces beside a thread
 * - `widget`    src/renderer/src/widget and its entry, the floating widget
 * - `features`  the rest of the renderer: the other pages, Watcher's room, the shell, state and components
 * - `main`      src/main, the tray, the application menu and main's own dialogs
 * - `shared`    src/shared, words both processes show
 *
 * Both windows load every renderer area and main loads `main` and `shared`, so a component may move between
 * areas without its words going missing. src/shared is also built into the headless host, whose two builds
 * (electron.vite.config.ts and scripts/build-host.mjs) have no macro transform yet: a shared module the host imports
 * gets that transform added to both before it uses a macro.
 */
const renderer = 'src/renderer/src'
const area = (name: string, include: string[], exclude: string[] = []) => ({
  path: `<rootDir>/src/locales/${name}/{locale}`,
  include,
  exclude: ['**/node_modules/**', '**/*.d.ts', '**/*.d.mts', ...exclude],
})

export default defineConfig({
  sourceLocale: SOURCE_INTERFACE_LANGUAGE,
  locales: [...INTERFACE_LANGUAGE_CODES, ...INTERFACE_PSEUDO_LANGUAGES.map(language => language.code)],
  // A message with no translation shows in English, never its id.
  fallbackLocales: { default: SOURCE_INTERFACE_LANGUAGE },
  // Longer, accented text (en-XA) and right-to-left text (ar-XB) for layout checks in development; never in the picker.
  // Lingui pseudo-localizes each run of text between placeholders on its own, so markers around a message would land
  // inside it; the extra length is enough to show what clips.
  pseudoLocale: [
    { locale: 'en-XA', extend: 0.35 },
    { locale: 'ar-XB', rightToLeft: true },
  ],
  // Without line numbers or a creation date, a catalog changes only when its messages do, so two pull requests in
  // different areas never touch the same file.
  format: formatter({ lineNumbers: false, customHeaderAttributes: { 'POT-Creation-Date': '' } }),
  orderBy: 'message',
  // Components read the interface language without a provider above them, so a component renders the same in a test
  // as in a window (src/renderer/src/state/interfaceLanguageReact.tsx).
  runtimeConfigModule: {
    useLingui: ['#interface-language-react', 'useLingui'],
    Trans: ['#interface-language-react', 'Trans'],
  },
  catalogs: [
    area('settings', [`${renderer}/features/settings`]),
    area('threads', [`${renderer}/agents`]),
    area('tools', [`${renderer}/tools`]),
    area('widget', [`${renderer}/widget`, `${renderer}/widget.tsx`]),
    area('features', [renderer], [
      `${renderer}/features/settings/**`, `${renderer}/agents/**`, `${renderer}/tools/**`, `${renderer}/widget/**`, `${renderer}/widget.tsx`,
    ]),
    area('main', ['src/main']),
    area('shared', ['src/shared']),
  ],
})
