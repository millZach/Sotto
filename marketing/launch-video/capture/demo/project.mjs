// pantry: the small web app the launch video's agents work on. Written as a short, believable history
// of commits, pushed to a local bare remote, so every take starts from the same repository.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const history = [
  ['Start pantry with a list of items', {
    '.gitignore': 'node_modules/\ndist/\n',
    'package.json': JSON.stringify({ name: 'pantry', version: '1.1.0', private: true, type: 'module',
      scripts: { dev: 'vite', build: 'tsc --noEmit && vite build', test: 'node --test' },
      devDependencies: { typescript: '^5.9.2', vite: '^7.1.5' } }, null, 2) + '\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
      noEmit: true, allowImportingTsExtensions: true, lib: ['ES2023', 'DOM'] }, include: ['src', 'test'] }, null, 2) + '\n',
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Pantry</title>
    <link rel="stylesheet" href="/src/styles/theme.css" />
  </head>
  <body>
    <header class="bar"><a href="/">Pantry</a><a href="/settings">Settings</a></header>
    <main id="app"></main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
    'src/main.ts': `import { renderList } from './pages/ListPage.ts'

const app = document.querySelector<HTMLElement>('#app')!
renderList(app)
`,
    'src/store.ts': `export interface Item {
  id: string
  name: string
  quantity: number
}

const KEY = 'pantry.items'

export function loadItems(storage: Pick<Storage, 'getItem'> = localStorage): Item[] {
  const saved = storage.getItem(KEY)
  return saved ? (JSON.parse(saved) as Item[]) : []
}

export function saveItems(items: Item[], storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(KEY, JSON.stringify(items))
}

export function addItem(items: Item[], name: string, quantity = 1): Item[] {
  return [...items, { id: crypto.randomUUID(), name: name.trim(), quantity }]
}
`,
    'src/pages/ListPage.ts': `import { loadItems } from '../store.ts'

export function renderList(root: HTMLElement): void {
  const items = loadItems()
  root.innerHTML = \`
    <h1>In the pantry</h1>
    <ul class="items">
      \${items.map(item => \`<li><span>\${item.name}</span><span class="count">\${item.quantity}</span></li>\`).join('')}
    </ul>\`
}
`,
    'src/styles/theme.css': `:root {
  --surface: #fbfaf7;
  --surface-raised: #ffffff;
  --text: #1d2321;
  --muted: #5d6763;
  --accent: #2f6f6a;
  --border: #e3e0d8;
  font-family: system-ui, sans-serif;
}

body {
  margin: 0;
  background: var(--surface);
  color: var(--text);
}

.bar {
  display: flex;
  gap: 1.5rem;
  padding: 1rem 2rem;
  border-bottom: 1px solid var(--border);
}

.bar a {
  color: var(--accent);
  font-weight: 600;
  text-decoration: none;
}

main {
  max-width: 40rem;
  margin: 0 auto;
  padding: 2rem;
}

.items li {
  display: flex;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  margin-bottom: 0.5rem;
}

.count {
  color: var(--muted);
}
`,
    'README.md': `# Pantry

Keep track of what's in the kitchen, and what runs out first.

## Run it

\`\`\`sh
npm install
npm run dev
\`\`\`

Then open http://localhost:5173.
`,
  }],
  ['Add expiry dates to items', {
    'src/dates.ts': `/** Reads an expiry date written as 2026-10-04 or 04/10/2026 (day first). */
export function parseExpiry(text: string): Date | null {
  const iso = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(text.trim())
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
  const dayFirst = /^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/.exec(text.trim())
  if (dayFirst) return new Date(Number(dayFirst[3]), Number(dayFirst[2]) - 1, Number(dayFirst[1]))
  return null
}

export function daysLeft(expiry: Date, today = new Date()): number {
  return Math.ceil((expiry.getTime() - today.getTime()) / 86_400_000)
}
`,
    'src/store.ts': `export interface Item {
  id: string
  name: string
  quantity: number
  expires?: string
}

const KEY = 'pantry.items'

export function loadItems(storage: Pick<Storage, 'getItem'> = localStorage): Item[] {
  const saved = storage.getItem(KEY)
  return saved ? (JSON.parse(saved) as Item[]) : []
}

export function saveItems(items: Item[], storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(KEY, JSON.stringify(items))
}

export function addItem(items: Item[], name: string, quantity = 1, expires?: string): Item[] {
  return [...items, { id: crypto.randomUUID(), name: name.trim(), quantity, ...(expires ? { expires } : {}) }]
}
`,
  }],
  ['Import items from a CSV file', {
    'src/importCsv.ts': `import { parseExpiry } from './dates.ts'
import type { Item } from './store.ts'

/** name,quantity,expires, one item a line, with a header row. */
export function importCsv(text: string): Item[] {
  const [, ...rows] = text.trim().split(/\\r?\\n/)
  return rows.map(row => {
    const [name, quantity, expires] = row.split(',')
    const date = expires ? parseExpiry(expires) : null
    return { id: crypto.randomUUID(), name: name.trim(), quantity: Number(quantity) || 1,
      ...(date ? { expires: date.toISOString().slice(0, 10) } : {}) }
  })
}
`,
  }],
  ['Add a settings page', {
    'src/settings/settings.ts': `export interface Settings {
  units: 'metric' | 'imperial'
  sortBy: 'name' | 'expiry'
}

const KEY = 'pantry.settings'
export const DEFAULT_SETTINGS: Settings = { units: 'metric', sortBy: 'expiry' }

export function loadSettings(storage: Pick<Storage, 'getItem'> = localStorage): Settings {
  const saved = storage.getItem(KEY)
  return saved ? { ...DEFAULT_SETTINGS, ...(JSON.parse(saved) as Partial<Settings>) } : DEFAULT_SETTINGS
}

export function saveSettings(settings: Settings, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(KEY, JSON.stringify(settings))
}
`,
    'src/settings/SettingsPage.ts': `import { loadSettings, saveSettings } from './settings.ts'

export function renderSettings(root: HTMLElement): void {
  const settings = loadSettings()
  root.innerHTML = \`
    <h1>Settings</h1>
    <section class="panel">
      <h2>General</h2>
      <label>Units
        <select name="units">
          <option value="metric" \${settings.units === 'metric' ? 'selected' : ''}>Metric</option>
          <option value="imperial" \${settings.units === 'imperial' ? 'selected' : ''}>Imperial</option>
        </select>
      </label>
      <label>Sort by
        <select name="sortBy">
          <option value="expiry" \${settings.sortBy === 'expiry' ? 'selected' : ''}>Expiry date</option>
          <option value="name" \${settings.sortBy === 'name' ? 'selected' : ''}>Name</option>
        </select>
      </label>
    </section>
    <section class="panel">
      <h2>Appearance</h2>
      <p class="hint">More options are on the way.</p>
    </section>\`
  root.querySelectorAll('select').forEach(select => select.addEventListener('change', () => {
    saveSettings({ ...loadSettings(), [select.name]: select.value })
  }))
}
`,
    'src/main.ts': `import { renderList } from './pages/ListPage.ts'
import { renderSettings } from './settings/SettingsPage.ts'

const app = document.querySelector<HTMLElement>('#app')!
if (location.pathname === '/settings') renderSettings(app)
else renderList(app)
`,
    'src/styles/theme.css': null,
  }],
  ['Sort the list by expiry date', {
    'src/pages/ListPage.ts': `import { daysLeft, parseExpiry } from '../dates.ts'
import { loadSettings } from '../settings/settings.ts'
import { loadItems, type Item } from '../store.ts'

function byExpiry(left: Item, right: Item): number {
  return (left.expires ?? '9999').localeCompare(right.expires ?? '9999')
}

export function renderList(root: HTMLElement): void {
  const { sortBy } = loadSettings()
  const items = [...loadItems()].sort(sortBy === 'expiry' ? byExpiry : (a, b) => a.name.localeCompare(b.name))
  root.innerHTML = \`
    <h1>In the pantry</h1>
    <ul class="items">
      \${items.map(item => {
        const expiry = item.expires ? parseExpiry(item.expires) : null
        const left = expiry ? \`\${daysLeft(expiry)} days\` : ''
        return \`<li><span>\${item.name}</span><span class="count">\${item.quantity} · \${left}</span></li>\`
      }).join('')}
    </ul>\`
}
`,
  }],
  ['Add tests for date parsing', {
    'test/dates.test.ts': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { daysLeft, parseExpiry } from '../src/dates.ts'

test('reads an ISO date', () => {
  assert.deepEqual(parseExpiry('2026-10-04'), new Date(2026, 9, 4))
})

test('reads a day-first date', () => {
  assert.deepEqual(parseExpiry('04/10/2026'), new Date(2026, 9, 4))
})

test('gives up on anything else', () => {
  assert.equal(parseExpiry('next week'), null)
})

test('counts the days left', () => {
  assert.equal(daysLeft(new Date(2026, 9, 4), new Date(2026, 9, 1)), 3)
})
`,
    '.github/pull_request_template.md': `## What changed

## How it was checked
`,
  }],
]

// theme.css gains the settings panel styles with the settings page.
const PANEL_CSS = `
.panel {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
}

.panel label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0;
}

.hint {
  color: var(--muted);
}
`

export function makeProject({ project, remote, env }) {
  rmSync(project, { recursive: true, force: true }); rmSync(remote, { recursive: true, force: true })
  mkdirSync(project, { recursive: true }); mkdirSync(remote, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: project, env, stdio: ['ignore', 'pipe', 'inherit'] })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env })
  git('init', '-q', '-b', 'main')
  let css = ''
  let day = 1
  for (const [subject, files] of history) {
    for (const [path, content] of Object.entries(files)) {
      const text = path === 'src/styles/theme.css' ? (content === null ? css + PANEL_CSS : content) : content
      if (path === 'src/styles/theme.css') css = text
      mkdirSync(dirname(join(project, path)), { recursive: true })
      writeFileSync(join(project, path), text, 'utf8')
    }
    git('add', '-A')
    const date = `2026-09-${String(day += 3).padStart(2, '0')}T10:${String(10 + day).padStart(2, '0')}:00-07:00`
    execFileSync('git', ['commit', '-q', '-m', subject], { cwd: project, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
  }
  git('remote', 'add', 'origin', remote)
  git('push', '-q', '-u', 'origin', 'main')
}
