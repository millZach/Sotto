// The edits each scripted agent makes to pantry. They are written to disk as the agent reports them, so
// Changes, Files, the terminal and the browser all show real work in a real repository.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const edit = (cwd, path, change) => {
  const file = join(cwd, path)
  const before = (() => { try { return readFileSync(file, 'utf8') } catch { return '' } })()
  const after = typeof change === 'function' ? change(before) : change
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, after, 'utf8')
  return { before, after }
}
const replace = (from, to) => text => { if (!text.includes(from)) throw new Error(`Edit anchor missing: ${from.slice(0, 40)}`); return text.replace(from, to) }

// Claude Code: the dark mode toggle, in four steps as the thread reports them.
export const darkMode = {
  settings: cwd => edit(cwd, 'src/settings/settings.ts', text => replace(`  sortBy: 'name' | 'expiry'
}`, `  sortBy: 'name' | 'expiry'
  darkMode: boolean
}`)(replace(`{ units: 'metric', sortBy: 'expiry' }`, `{ units: 'metric', sortBy: 'expiry', darkMode: false }`)(text))),
  page: cwd => edit(cwd, 'src/settings/SettingsPage.ts', text => replace(`      <h2>Appearance</h2>
      <p class="hint">More options are on the way.</p>
    </section>\``, `      <h2>Appearance</h2>
      <label class="toggle">Dark mode
        <input type="checkbox" name="darkMode" role="switch" \${settings.darkMode ? 'checked' : ''} />
      </label>
    </section>\``)(replace(`  root.querySelectorAll('select').forEach(select => select.addEventListener('change', () => {
    saveSettings({ ...loadSettings(), [select.name]: select.value })
  }))`, `  root.querySelectorAll('select').forEach(select => select.addEventListener('change', () => {
    saveSettings({ ...loadSettings(), [select.name]: select.value })
  }))
  root.querySelector<HTMLInputElement>('input[name="darkMode"]')!.addEventListener('change', event => {
    const darkMode = (event.target as HTMLInputElement).checked
    saveSettings({ ...loadSettings(), darkMode })
    applyTheme(darkMode)
  })`)(replace(`import { loadSettings, saveSettings } from './settings.ts'`, `import { applyTheme } from '../theme.ts'
import { loadSettings, saveSettings } from './settings.ts'`)(text)))),
  theme: cwd => {
    edit(cwd, 'src/theme.ts', `/** Switches the page between the light and dark palettes in theme.css. */
export function applyTheme(darkMode: boolean): void {
  document.documentElement.dataset.theme = darkMode ? 'dark' : 'light'
}
`)
    edit(cwd, 'src/main.ts', text => replace(`const app = document.querySelector<HTMLElement>('#app')!`, `import { applyTheme } from './theme.ts'
import { loadSettings } from './settings/settings.ts'

applyTheme(loadSettings().darkMode)
const app = document.querySelector<HTMLElement>('#app')!`)(text))
  },
  css: cwd => edit(cwd, 'src/styles/theme.css', text => replace(`  font-family: system-ui, sans-serif;
}
`, `  font-family: system-ui, sans-serif;
}

:root[data-theme='dark'] {
  --surface: #151917;
  --surface-raised: #1f2522;
  --text: #e9eeeb;
  --muted: #9aa6a1;
  --accent: #7cc7bd;
  --border: #303934;
}
`)(text) + `
.toggle input {
  width: 2.5rem;
  height: 1.4rem;
  accent-color: var(--accent);
}
`),
}

// Codex: single-digit days and months in the CSV import.
export const expiryDates = {
  dates: cwd => edit(cwd, 'src/dates.ts', text => text
    .replace(String.raw`/^(\d{4})-(\d{2})-(\d{2})$/`, String.raw`/^(\d{4})-(\d{1,2})-(\d{1,2})$/`)
    .replace(String.raw`/^(\d{2})\/(\d{2})\/(\d{4})$/`, String.raw`/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/`)),
  test: cwd => edit(cwd, 'test/dates.test.ts', text => text + `
test('reads single-digit days and months', () => {
  assert.deepEqual(parseExpiry('2026-10-4'), new Date(2026, 9, 4))
  assert.deepEqual(parseExpiry('4/9/2026'), new Date(2026, 8, 4))
})
`),
}

// Grok Build: tests for the store.
export const storeTests = {
  test: cwd => edit(cwd, 'test/store.test.ts', `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addItem, loadItems, saveItems } from '../src/store.ts'

function memoryStorage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

test('adds an item with a trimmed name', () => {
  const [item] = addItem([], '  Oat milk ', 2)
  assert.equal(item.name, 'Oat milk')
  assert.equal(item.quantity, 2)
})

test('keeps the expiry date when there is one', () => {
  const [item] = addItem([], 'Basil', 1, '2026-10-04')
  assert.equal(item.expires, '2026-10-04')
})

test('saves and loads the same items', () => {
  const storage = memoryStorage()
  const items = addItem(addItem([], 'Rice'), 'Coffee', 3)
  saveItems(items, storage)
  assert.deepEqual(loadItems(storage), items)
})

test('loads an empty pantry when nothing is saved', () => {
  assert.deepEqual(loadItems(memoryStorage()), [])
})
`),
}

// Devin: a tidier README.
export const readme = {
  write: cwd => edit(cwd, 'README.md', `# Pantry

Keep track of what's in the kitchen, and what runs out first.

## Run it

\`\`\`sh
npm install
npm run dev
\`\`\`

Then open http://localhost:5173.

## Test it

\`\`\`sh
npm test
\`\`\`

## Import a list

\`importCsv\` reads a CSV file with a header row: \`name,quantity,expires\`. Dates can be \`2026-10-04\` or \`04/10/2026\`.
`),
}
