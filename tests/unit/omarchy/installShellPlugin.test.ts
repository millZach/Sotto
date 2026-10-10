// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// install-shell-plugin.sh --uninstall against stand-ins for Omarchy's
// commands and a throwaway HOME. It is a bash script for Omarchy, so it
// runs where bash and jq do on Linux.
const script = resolve(__dirname, '../../../apps/omarchy/install-shell-plugin.sh')
const runs = process.platform === 'linux' && spawnSync('jq', ['--version']).status === 0
const root = typeof process.getuid === 'function' && process.getuid() === 0

const onBar = JSON.stringify({ bar: { layout: { left: [], center: [{ id: 'omarchy.indicators' }, { id: 'sotto.dictation' }], right: [] } } })
const offBar = JSON.stringify({ bar: { layout: { left: [], center: [{ id: 'omarchy.indicators' }], right: [] } } })

describe.runIf(runs)('install-shell-plugin.sh --uninstall', () => {
  let home = ''
  let bin = ''
  let config = ''
  let plugin = ''

  // `omarchy plugin disable` does what STUB_DISABLE says to shell.json: take
  // the entry off, or leave a file that cannot be parsed.
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sotto-uninstall-'))
    bin = join(home, 'bin')
    config = join(home, '.config/omarchy/shell.json')
    plugin = join(home, '.config/omarchy/plugins/sotto.dictation')
    mkdirSync(bin)
    mkdirSync(plugin, { recursive: true })
    writeFileSync(join(plugin, 'manifest.json'), JSON.stringify({ id: 'sotto.dictation' }))
    stub('omarchy-shell', '[[ $1 == shell && $2 == ping ]] && exit "${STUB_PING:-0}"\nexit 0')
    stub('omarchy', [
      '[[ $1 == plugin && $2 == disable ]] || exit 0',
      'case $STUB_DISABLE in',
      `  remove) printf '%s' '${offBar}' >"$HOME/.config/omarchy/shell.json" ;;`,
      `  break) printf '{"bar":' >"$HOME/.config/omarchy/shell.json" ;;`,
      'esac',
    ].join('\n'))
    // The script waits a tenth of a second between reads of shell.json.
    stub('sleep', 'exit 0')
  })

  afterEach(() => {
    if (existsSync(config)) chmodSync(config, 0o600)
    rmSync(home, { recursive: true, force: true })
  })

  const uninstall = (env: Record<string, string> = {}) => {
    const result = spawnSync('bash', [script, '--uninstall'], {
      encoding: 'utf8',
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...env },
    })
    return { status: result.status, out: result.stdout + result.stderr }
  }

  it('keeps the plugin folder when shell.json cannot be parsed, and says why', () => {
    writeFileSync(config, '{"bar":{"layout":')
    const { status, out } = uninstall()
    expect(status).toBe(1)
    expect(existsSync(plugin)).toBe(true)
    expect(out).toContain(`Could not read ${config} to see whether Sotto's glyph is on the bar: parse error`)
    expect(out).toContain('Nothing was removed. Fix or restore that file, then run this again.')
  })

  it.skipIf(root)('keeps the plugin folder when shell.json cannot be opened', () => {
    writeFileSync(config, onBar)
    chmodSync(config, 0)
    const { status, out } = uninstall()
    expect(status).toBe(1)
    expect(existsSync(plugin)).toBe(true)
    expect(out).toContain('Permission denied. Nothing was removed.')
  })

  it('keeps the plugin folder when shell.json holds no settings', () => {
    writeFileSync(config, '')
    const { status, out } = uninstall()
    expect(status).toBe(1)
    expect(existsSync(plugin)).toBe(true)
    expect(out).toContain('it holds no settings. Nothing was removed.')
  })

  it('keeps the plugin folder when shell.json cannot be read after the glyph is taken off', () => {
    writeFileSync(config, onBar)
    const { status, out } = uninstall({ STUB_DISABLE: 'break' })
    expect(status).toBe(1)
    expect(existsSync(plugin)).toBe(true)
    expect(out).toContain("Asked the shell to take Sotto's glyph off the bar, but could not read")
    expect(out).toContain('The plugin folder was kept. Run this again once that file can be read.')
  })

  it('removes the folder once a read of shell.json shows the glyph is off the bar', () => {
    writeFileSync(config, onBar)
    const { status, out } = uninstall({ STUB_DISABLE: 'remove' })
    expect(status).toBe(0)
    expect(existsSync(plugin)).toBe(false)
    expect(out).toContain("Took Sotto's glyph off the bar.")
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual(JSON.parse(offBar))
  })

  it('keeps everything when the glyph will not come off', () => {
    writeFileSync(config, onBar)
    const { status, out } = uninstall()
    expect(status).toBe(1)
    expect(existsSync(plugin)).toBe(true)
    expect(out).toContain("Sotto's glyph is still in the bar's layout")
  })

  it('removes the folder without the shell when shell.json names no glyph, or there is no shell.json', () => {
    writeFileSync(config, offBar)
    expect(uninstall({ STUB_PING: '1' }).status).toBe(0)
    expect(existsSync(plugin)).toBe(false)
    mkdirSync(plugin, { recursive: true })
    writeFileSync(join(plugin, 'manifest.json'), JSON.stringify({ id: 'sotto.dictation' }))
    rmSync(config)
    expect(uninstall({ STUB_PING: '1' }).status).toBe(0)
    expect(existsSync(plugin)).toBe(false)
  })

  it('removes nothing without the shell while the glyph is on the bar', () => {
    writeFileSync(config, onBar)
    const { status, out } = uninstall({ STUB_PING: '1' })
    expect(status).toBe(1)
    expect(existsSync(plugin)).toBe(true)
    expect(out).toContain('only a running Omarchy shell can take it off. Nothing was removed.')
  })
})
