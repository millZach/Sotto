// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A generated artifacts/ folder is ignored by git and by lint (AGENTS.md); the captures a verification note cites are
// committed on top of that. These are the floating composer's, the slim composer's and Watcher's column's.
const FOLDERS = ['artifacts/composer-float', 'artifacts/composer-shrink', 'artifacts/watcher-column'] as const

describe('the floating and slim composer evidence folders', () => {
  const gitignore = readFileSync('.gitignore', 'utf8').split(/\r?\n/).map(line => line.trim())
  const eslint = readFileSync('eslint.config.mjs', 'utf8')

  it.each(FOLDERS)('registers %s with git and with lint', folder => {
    expect(gitignore.some(line => line === `${folder}/` || line === `/${folder}/`), `${folder} in .gitignore`).toBe(true)
    expect(eslint.includes(`'${folder}/**'`), `${folder} in eslint.config.mjs`).toBe(true)
  })
})
