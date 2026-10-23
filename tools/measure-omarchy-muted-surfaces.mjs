// Usage: mise exec node@24.22.1 -- node tools/measure-omarchy-muted-surfaces.mjs [output.json]
import console from 'node:console'
import process from 'node:process'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const temporary = mkdtempSync(join(tmpdir(), 'sotto-muted-measure-'))
try {
  const bundle = join(temporary, 'measurement.cjs')
  await build({ stdin: { resolveDir: process.cwd(), contents: `
    export { default as fixtures } from './tests/fixtures/omarchy-themes.json'
    export { parseOmarchyTheme, omarchySuccessText } from './src/shared/themes/omarchy'
    export { BUILT_IN_THEMES, DEFAULT_THEME_ID } from './src/shared/themes/library'
    export { parseTokenBlocks, rootDeclarations, resolveColor, contrast, over } from './tests/fixtures/renderer/themeTokenResolver'
    export { OMARCHY_CSS_TEXT_PAIRS } from './tests/fixtures/renderer/omarchyTextSurfaces'
  ` }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle })
  const { fixtures, parseOmarchyTheme, omarchySuccessText, BUILT_IN_THEMES, DEFAULT_THEME_ID,
    parseTokenBlocks, rootDeclarations, resolveColor, contrast, over, OMARCHY_CSS_TEXT_PAIRS } = createRequire(import.meta.url)(bundle)
  const blocks = parseTokenBlocks(readFileSync('src/renderer/src/styles/tokens.css', 'utf8'))
  const changes = parseTokenBlocks(readFileSync('src/renderer/src/tools/changes.css', 'utf8'))
    .find(block => block.declarations.has('--changes-picked')).declarations.get('--changes-picked')
  const surfaces = [
    ['Room', 'canvas'], ['Sidebar', 'sidebar'], ['Selected sidebar row', 'sidebar-row-selected'],
    ['Hovered sidebar row', 'sidebar', 'hover'], ['Message bubble', 'bubble'],
    ['Cards and fields', 'surface'], ['Raised cards', 'surface-elevated'], ['Overlay', 'surface-overlay'],
    ['Sunken cards', 'surface-sunken'], ['Secondary controls', 'secondary'], ['Sidebar controls', 'sidebar-control'],
    ['Strong hover', 'hover-strong'], ['Code', 'code-bg'],
    ['Changes hunk', 'code-bg', 'accent-wash'],
    ['Changes added', 'diff-add'], ['Changes removed', 'diff-remove'],
    ['Changes context hovered', 'code-bg', 'hover'], ['Changes added hovered', 'diff-add', 'hover'],
    ['Changes removed hovered', 'diff-remove', 'hover'],
    ['Changes context selected', 'code-bg', 'changes-picked'], ['Changes added selected', 'diff-add', 'changes-picked'],
    ['Changes removed selected', 'diff-remove', 'changes-picked'],
    ['Error card', 'error-surface'], ['Warning card', 'warning-surface'], ['Update card', 'update-surface'],
    ['Glass over room', 'canvas', 'glass'], ['Glass over sidebar', 'sidebar', 'glass'],
    ['Composer glass', 'canvas', 'glass-field'], ['Accent wash', 'canvas', 'accent-wash'],
    ['Owl header', 'owl-night'], ['Owl mode control', 'owl-night-control'], ['Owl search field', 'owl-night-field'],
    ['History warning', 'canvas', 'history-warning'], ['Working copy warning', 'canvas', 'working-warning'],
    ['Success notice', 'surface-sunken', 'success-notice'], ['Table stripe', 'canvas', 'table-stripe'],
  ]
  const themes = [
    ...Object.entries(fixtures.themes).map(([id, fixture]) => ({ ...parseOmarchyTheme(fixture.rendered, id), group: 'Omarchy' })),
    ...BUILT_IN_THEMES.flatMap(theme => ['light', 'dark'].map(appearance => ({
      ...theme, appearance, colors: theme.appearance === appearance ? theme.colors : theme.variants[appearance], group: 'Built-in',
    }))),
  ]
  const measurements = [], faintMeasurements = []
  for (const theme of themes) {
    const declarations = rootDeclarations(theme.appearance, DEFAULT_THEME_ID, { colors: theme.colors }, blocks)
    if (theme.group === 'Omarchy') declarations.set('--tt-success', omarchySuccessText(theme.colors, theme.appearance))
    for (const [name, value] of [
      ['diff-add', 'color-mix(in srgb, var(--tt-success) 12%, var(--tt-code-bg))'],
      ['diff-remove', 'color-mix(in srgb, var(--tt-error) 12%, var(--tt-code-bg))'],
      ['changes-picked', changes], ['history-warning', 'color-mix(in srgb, var(--tt-warning) 9%, transparent)'],
      ['working-warning', 'color-mix(in srgb, var(--tt-warning) 10%, transparent)'],
      ['success-notice', 'color-mix(in srgb, var(--tt-success) 8%, transparent)'],
    ]) declarations.set(`--tt-${name}`, value)
    const canvas = resolveColor('--tt-canvas', declarations)
    for (const [surface, base, ...layers] of surfaces) {
      let background = over(resolveColor(`--tt-${base}`, declarations), canvas)
      for (const layer of layers) background = over(resolveColor(`--tt-${layer}`, declarations), background)
      for (const ink of surface === 'Changes hunk' ? ['text-2'] : ['text-muted', 'text-2']) {
        const foreground = over(resolveColor(`--tt-${ink}`, declarations), background)
        measurements.push({ group: theme.group, theme: theme.sourceName ?? theme.label, mode: theme.appearance,
          ink, surface, ratio: contrast(foreground, background) })
      }
    }
    // Faint labels and placeholders have their own role. Keep their audited
    // surfaces separate from timestamp/secondary measurements, rather than
    // inventing faint text on selected Changes lines where it never appears.
    for (const surface of OMARCHY_CSS_TEXT_PAIRS.find(([ink]) => ink === 'text-faint')[1]) {
      const background = over(resolveColor(`--tt-${surface}`, declarations), canvas)
      const foreground = over(resolveColor('--tt-text-faint', declarations), background)
      faintMeasurements.push({ group: theme.group, theme: theme.sourceName ?? theme.label, mode: theme.appearance,
        ink: 'text-faint', surface, ratio: contrast(foreground, background) })
    }
  }
  const minimum = (group, surface) => measurements.filter(row => row.group === group && row.surface === surface && row.ink === (surface === 'Changes hunk' ? 'text-2' : 'text-muted')).sort((a, b) => a.ratio - b.ratio)[0]
  const minima = surfaces.map(([surface]) => ({ surface, omarchy: minimum('Omarchy', surface), builtin: minimum('Built-in', surface) }))
  for (const row of minima) console.log(`${row.surface}: Omarchy ${row.omarchy.ratio.toFixed(4)} (${row.omarchy.theme} ${row.omarchy.mode}); built-in ${row.builtin.ratio.toFixed(4)} (${row.builtin.theme} ${row.builtin.mode})`)
  const failures = [...measurements, ...faintMeasurements].filter(row => row.group === 'Omarchy' && row.ratio < 4.5)
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ contrast: 100, glass: 80, surfaces, minima, measurements, faintMeasurements, failures }, null, 2) + '\n')
  if (failures.length) throw new Error(`Omarchy has ${failures.length} muted/secondary pairs below 4.5:1`)
} finally { rmSync(temporary, { recursive: true, force: true }) }
