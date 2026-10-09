// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve('apps/omarchy/install.sh')

describe.skipIf(process.platform !== 'linux')('Omarchy install helper', () => {
  it('has valid Bash syntax', () => {
    execFileSync('/bin/bash', ['-n', script])
  })

  it('finishes successfully with no input and skips both optional steps', () => {
    const root = mkdtempSync(join(tmpdir(), 'sotto-install-eof-'))
    try {
      const bin = join(root, 'bin')
      const log = join(root, 'calls')
      mkdirSync(bin)
      for (const command of ['pacman', 'omarchy-pkg-add']) {
        writeFileSync(join(bin, command), `#!/bin/bash\nprintf '%s\\n' "${command} $*" >> "$SOTTO_INSTALL_TEST_LOG"\n`, { mode: 0o700 })
      }
      // PATH contains only stubs. The test cannot install, invoke sudo or reach yay.
      const output = execFileSync('/bin/bash', ['-c', 'exec /bin/bash "$1" </dev/null', 'bash', script], {
        env: { PATH: bin, SOTTO_INSTALL_TEST_LOG: log }, encoding: 'utf8',
      })
      expect(output).toContain('Sotto has been installed. Open it from the application menu.')
      expect(output).not.toContain('Copy /usr/share/sotto/bindings.lua')
      expect(output).not.toContain('The shell plugin is separate.')
      expect(readFileSync(log, 'utf8')).toBe('pacman -Si sotto-bin\nomarchy-pkg-add sotto-bin\n')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
