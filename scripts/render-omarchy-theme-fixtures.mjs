// Use the installed Omarchy renderer; never change the live theme or HOME.
import process from 'node:process'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function renderOmarchyStockThemes(omarchyPath = '/usr/share/omarchy') {
  const root = resolve('artifacts/omarchy-theme')
  mkdirSync(root, { recursive: true })
  const home = mkdtempSync(join(root, 'stock-home-'))
  const next = join(home, '.local/state/omarchy/current/next-theme')
  const template = readFileSync('apps/omarchy/sotto.json.tpl')
  const result = { templateSha256: createHash('sha256').update(template).digest('hex'), themes: {} }
  try {
    mkdirSync(join(home, '.config/omarchy/themed'), { recursive: true })
    mkdirSync(join(home, 'tmp'))
    writeFileSync(join(home, '.config/omarchy/themed/sotto.json.tpl'), template)
    for (const slug of readdirSync(join(omarchyPath, 'themes')).sort()) {
      const colors = join(omarchyPath, 'themes', slug, 'colors.toml')
      mkdirSync(next, { recursive: true })
      copyFileSync(colors, join(next, 'colors.toml'))
      execFileSync(join(omarchyPath, 'bin/omarchy-theme-set-templates'), [], { env: {
        ...process.env, HOME: home, TMPDIR: join(home, 'tmp'), OMARCHY_PATH: omarchyPath,
        PATH: `${join(omarchyPath, 'bin')}:${process.env.PATH}`,
      }, timeout: 30_000, stdio: 'pipe' })
      result.themes[slug] = {
        colorsSha256: createHash('sha256').update(readFileSync(colors)).digest('hex'),
        rendered: JSON.parse(readFileSync(join(next, 'sotto.json'), 'utf8')),
      }
      rmSync(next, { recursive: true })
    }
    return result
  } finally { rmSync(home, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync('tests/fixtures/omarchy-themes.json', `${JSON.stringify(renderOmarchyStockThemes(), null, 2)}\n`)
}
