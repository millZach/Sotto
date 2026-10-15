// @vitest-environment node
import { expect, it } from 'vitest'
import { terminalImageInput } from '../../../src/main/terminals/clipboard'

const sensitive = "Review $(1+1) $name `literal` 'quoted' ‘smart’ project"

it('quotes expansions and all PowerShell single quote characters literally', () => {
  expect(terminalImageInput(sensitive, 'win32')).toBe("'Review $(1+1) $name `literal` ''quoted'' ‘‘smart’’ project'")
})

it('quotes POSIX apostrophes outside the literal while preserving expansions and backticks', () => {
  expect(terminalImageInput(sensitive, 'linux')).toBe("'Review $(1+1) $name `literal` '\\''quoted'\\'' ‘smart’ project'")
})
