import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface Rule { readonly selectors: readonly string[]; readonly declarations: ReadonlyMap<string, string> }

/** Every rule of a renderer stylesheet with comments dropped and media blocks flattened: its selectors and declarations. */
function rules(path: string): readonly Rule[] {
  const css = readFileSync(join(process.cwd(), 'src/renderer/src', path), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(([, selector, body]) => ({
    selectors: selector!.split(',').map(part => part.trim().replace(/\s+/gu, ' ')),
    declarations: new Map(body!.split(';').map(part => part.trim()).filter(part => part.includes(':')).map(part => {
      const colon = part.indexOf(':')
      return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()] as const
    })),
  }))
}

/** What the rules written for exactly this selector declare, later rules over earlier ones. */
function styleOf(all: readonly Rule[], selector: string): ReadonlyMap<string, string> {
  const merged = new Map<string, string>()
  for (const rule of all) if (rule.selectors.includes(selector)) for (const [property, value] of rule.declarations) merged.set(property, value)
  return merged
}

const selectorsOf = (all: readonly Rule[]): readonly string[] => all.flatMap(rule => rule.selectors)

const sidebar = rules('agents/threadSidebar.css')
const chrome = rules('agents/threadsChrome.css')
const settings = rules('styles/crossing-settings.css')
const global = rules('styles/global.css')

// Going to Settings and back must move nothing in the sidebar's frame. The geometry is checked in the built app
// (tests/e2e/sidebar-crossing.spec.ts); these keep the one frame the stylesheets draw it from from drifting back into
// two: a padded Settings column beside an unpadded Threads sidebar, each with its own widths and foot.
describe('the sidebar frame in the stylesheets', () => {
  it('is unpadded, and the foot carries its own inset, hairline and all', () => {
    const frame = styleOf(sidebar, '.thread-nav')
    expect(frame.get('padding')).toBe('0')
    expect(frame.get('--thread-nav-inset')).toBe('10px')
    // No column is a padded variant of the frame that has to be pulled back to meet the window's corner.
    expect(selectorsOf(sidebar).filter(selector => selector.includes(':not([data-mode])'))).toEqual([])
    const foot = styleOf(chrome, '.thread-nav__foot')
    expect(foot.get('margin')).toBe('auto var(--thread-nav-inset) 0')
    expect(foot.get('border-top')).toMatch(/^1px solid /u)
    // The collapsed rail is as wide as the foot, so it takes no inset.
    expect(styleOf(sidebar, '.thread-nav__rail .thread-nav__foot').get('margin-inline')).toBe('0')
  })

  it('draws the foot switch once, for every column that wears the foot', () => {
    const room = styleOf(chrome, '.thread-nav__foot .thread-nav__seg')
    expect(room.get('display')).toBe('grid')
    expect(room.get('grid-auto-columns')).toBe('minmax(0, 1fr)')
    expect(selectorsOf(settings).filter(selector => selector.includes('thread-nav__foot'))).toEqual([])
  })

  it('gives the Settings column the sidebar width and its frame, not widths and padding of its own', () => {
    // One rule gives the layout its columns, in no media block more; SettingsView hands it the sidebar's remembered width.
    const layouts = settings.filter(rule => rule.selectors.includes('.settings-view .settings-layout'))
    expect(layouts.map(rule => rule.declarations.get('grid-template-columns'))).toEqual(['var(--app-sidebar-width, 320px) minmax(0, 1fr)'])
    expect(global.flatMap(rule => [...rule.declarations.keys()]).filter(property => property === '--app-sidebar-width')).toEqual([])
    // The rail takes no padding of its own, at any size; its section list insets itself as the foot does.
    const rail = settings.filter(rule => rule.selectors.some(selector => /(^|\s)\.settings-sidebar$/u.test(selector)))
    expect(rail.flatMap(rule => [...rule.declarations.keys()]).filter(property => property.startsWith('padding'))).toEqual([])
    expect(styleOf(settings, '.settings-sidebar__body').get('margin-inline')).toBe('var(--thread-nav-inset)')
    // A container as the sidebar is, so its top row answers the container queries on the sidebar's width the same way.
    expect(styleOf(settings, '.settings-view .settings-sidebar').get('container')).toBe('thread-sidebar / inline-size')
  })
})
