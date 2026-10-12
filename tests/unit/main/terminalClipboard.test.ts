// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { win32 } from 'node:path'
import { expect, it } from 'vitest'
import { terminalImageInput } from '../../../src/main/terminals/clipboard'

const run = promisify(execFile)
const sensitive = "Review $(1+1) $name `literal` 'quoted' ‘smart’ project"

it('quotes expansions and all PowerShell single quote characters literally', () => {
  expect(terminalImageInput(sensitive, 'win32')).toBe("'Review $(1+1) $name `literal` ''quoted'' ‘‘smart’’ project'")
})

it('quotes POSIX apostrophes outside the literal while preserving expansions and backticks', () => {
  expect(terminalImageInput(sensitive, 'linux')).toBe("'Review $(1+1) $name `literal` '\\''quoted'\\'' ‘smart’ project'")
})

it('round trips shell-sensitive folder names through the actual platform shell', async () => {
  const path = process.platform === 'win32' ? `D:\\${sensitive}\\.sotto\\clipboard\\image.png` : `/tmp/${sensitive}/.sotto/clipboard/image.png`
  const literal = terminalImageInput(path)
  const result = process.platform === 'win32'
    ? await run(win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); [Console]::Write([string] ${literal})`])
    : await run('/bin/sh', ['-c', `printf '%s' ${literal}`])
  expect(result.stdout).toBe(path)
})
