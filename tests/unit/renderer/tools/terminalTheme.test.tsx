import { afterEach, describe, expect, it, vi } from 'vitest'

const xterm = vi.hoisted(() => ({ instances: [] as { options: Record<string, unknown>; themes: unknown[] }[] }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    readonly themes: unknown[] = []
    readonly options: Record<string, unknown>
    constructor(options: Record<string, unknown>) {
      const themes = this.themes
      let theme = options.theme
      this.options = new Proxy({ ...options }, { set(target, key, value) { if (key === 'theme') { theme = value; themes.push(value) } target[key as string] = value; return true } })
      Object.defineProperty(this.options, 'theme', { get: () => theme, set: value => { theme = value; themes.push(value) }, enumerable: true, configurable: true })
      xterm.instances.push(this)
    }
    loadAddon(): void {}
    onData(): void {}
    attachCustomKeyEventHandler(): void {}
    open(): void {}
    dispose(): void {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions(): undefined { return undefined } } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const { createXtermView, terminalTheme } = await import('../../../../src/renderer/src/tools/terminalView')

/** Stands in for the page's colour engine: the named CSS values the tests use, as the sRGB a canvas reads back. */
const PAINTED: Record<string, string> = {
  'oklch(0.242641 0.024125 250.573)': '#1b2430',
  'oklch(0.990339 0.008411 325.64)': '#fcf8fc',
  'oklch(0.758933 0.105833 241.548)': '#58b6ec',
  'oklch(0.439946 0.0561 243.479)': '#3a5470',
  'oklch(0.58613 0.012959 267.22)': '#7c8089',
  'oklch(0.681569 0.010909 276.465)': '#9a9da5',
  'oklch(0.974199 0.002856 241.597)': '#f6f8f9',
  'oklch(0.222003 0.03479 328.979)': '#28172a',
  'oklch(0.895373 0.023469 241.913)': '#d8e4ee',
  'color-mix(in oklab, oklch(0.990339 0.008411 325.64) 100%, oklch(0.242641 0.024125 250.573))': '#fcf8fc',
  'color-mix(in srgb, oklch(0.439946 0.0561 243.479) 60%, oklch(0.242641 0.024125 250.573))': '#2f3f53',
  'color-mix(in srgb, oklch(0.895373 0.023469 241.913) 60%, oklch(0.974199 0.002856 241.597))': '#e5edf3',
}
const resolve = (css: string): string | null => /^#[0-9a-f]{6}([0-9a-f]{2})?$/iu.test(css) ? css.toLowerCase() : PAINTED[css] ?? null

const OCEAN_DARK = {
  '--tt-terminal-background': 'oklch(0.242641 0.024125 250.573)',
  '--tt-terminal-foreground': 'color-mix(in oklab, oklch(0.990339 0.008411 325.64) 100%, oklch(0.242641 0.024125 250.573))',
  '--tt-terminal-cursor': 'oklch(0.758933 0.105833 241.548)',
  '--tt-terminal-selection': 'oklch(0.439946 0.0561 243.479)',
  '--tt-terminal-scrollbar': 'oklch(0.58613 0.012959 267.22)',
  '--tt-terminal-scrollbar-hover': 'oklch(0.681569 0.010909 276.465)',
}
const OCEAN_LIGHT = {
  '--tt-terminal-background': 'oklch(0.974199 0.002856 241.597)',
  '--tt-terminal-foreground': 'oklch(0.222003 0.03479 328.979)',
  '--tt-terminal-cursor': 'oklch(0.536684 0.120219 247.01)',
  '--tt-terminal-selection': 'oklch(0.895373 0.023469 241.913)',
}

function paint(root: HTMLElement, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) root.style.setProperty(name, value)
}

afterEach(() => {
  document.documentElement.removeAttribute('style')
  for (const name of Object.keys(document.documentElement.dataset)) delete document.documentElement.dataset[name]
  xterm.instances.length = 0
})

describe('terminal colours', () => {
  it('reads the theme’s terminal roles, resolved to colours xterm parses, with the opaque selection it draws text above', () => {
    const root = document.documentElement
    root.dataset.theme = 'dark'
    paint(root, OCEAN_DARK)
    const theme = terminalTheme(root, resolve)
    expect(theme).toMatchObject({
      background: '#1b2430', foreground: '#fcf8fc', cursor: '#58b6ec', cursorAccent: '#1b2430',
      selectionBackground: '#3a5470', selectionInactiveBackground: '#2f3f53',
      scrollbarSliderBackground: '#7c8089', scrollbarSliderHoverBackground: '#9a9da5', scrollbarSliderActiveBackground: '#9a9da5',
      black: '#1a1d1b',
    })
    // No value xterm would have to guess at: every colour is plain hex.
    for (const value of Object.values(theme)) if (typeof value === 'string') expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/u)
  })

  it('picks the ANSI set from how light the terminal field is, not from the mode name', () => {
    const root = document.documentElement
    root.dataset.theme = 'dark'
    paint(root, OCEAN_LIGHT)
    const theme = terminalTheme(root, resolve)
    expect(theme).toMatchObject({ background: '#f6f8f9', foreground: '#28172a', selectionBackground: '#d8e4ee', selectionInactiveBackground: '#e5edf3', red: '#b42318' })
  })

  it('falls back to the Crossing tokens, writing an accent wash as #rrggbbaa whatever notation the accent uses', () => {
    const root = document.documentElement
    root.dataset.theme = 'dark'
    paint(root, { '--tt-sidebar': '#050706', '--tt-code-text': '#dfe4e1', '--tt-accent': 'oklch(0.758933 0.105833 241.548)' })
    expect(terminalTheme(root, resolve)).toMatchObject({ background: '#050706', foreground: '#dfe4e1', cursor: '#58b6ec', selectionBackground: '#58b6ec52', selectionInactiveBackground: '#58b6ec2e' })
  })

  it('never hands xterm a value the page cannot paint', () => {
    const root = document.documentElement
    root.dataset.theme = 'light'
    paint(root, { '--tt-terminal-background': 'not-a-colour', '--tt-terminal-selection': 'oklch(nope)' })
    const theme = terminalTheme(root, resolve)
    expect(theme.background).toBe('#eef0ec')
    expect(theme.selectionBackground).toMatch(/^#[0-9a-f]{8}$/u)
  })
})

describe('a live terminal', () => {
  it('repaints the same xterm when the theme, its mode or its colours change on the root, and only then', async () => {
    const root = document.documentElement
    root.dataset.theme = 'dark'
    root.dataset.themeId = 'ocean'
    paint(root, OCEAN_DARK)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const view = createXtermView({ onInput: () => undefined, onInterrupt: () => undefined }, { resolveColor: resolve })
    view.mount(document.body.appendChild(document.createElement('div')))
    expect(xterm.instances).toHaveLength(1)
    const terminal = xterm.instances[0]!
    expect(terminal.options.theme).toMatchObject({ background: '#1b2430' })
    const flush = () => new Promise(resolve => setTimeout(resolve, 0))

    // An editor change to one role in the same mode and theme is only an inline style change.
    root.style.setProperty('--tt-terminal-selection', 'oklch(0.58613 0.012959 267.22)')
    await flush()
    expect(terminal.themes.at(-1)).toMatchObject({ selectionBackground: '#7c8089' })

    // Another theme with the same mode.
    root.dataset.themeId = 'paper'
    paint(root, OCEAN_LIGHT)
    await flush()
    expect(terminal.themes.at(-1)).toMatchObject({ background: '#f6f8f9', foreground: '#28172a' })

    const repaints = terminal.themes.length
    root.dataset.themeSwitching = ''
    root.style.setProperty('--followups-top', '12px')
    await flush()
    expect(terminal.themes).toHaveLength(repaints)
    expect(xterm.instances).toHaveLength(1)

    view.dispose()
    paint(root, OCEAN_DARK)
    await flush()
    expect(terminal.themes).toHaveLength(repaints)
  })
})
