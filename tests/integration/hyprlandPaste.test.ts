// @vitest-environment node
import { parseProviderRecords } from '../fixtures/providerRecords'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildLinuxPasteInvocation, createHyprlandPasteAdapter, MODIFIERS_HELD_QUERY } from '../../src/main/output/pasteCommand.linux'
import { OutputService } from '../../src/main/output/outputService'

let directory: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe.skipIf(process.platform !== 'linux')('Hyprland process transport over a recording stub on PATH', () => {
  it.each(['app', 'terminal', 'exit', 'reply'])('delivers the %s case with no shell interpolation', async target => {
    directory = await mkdtemp(join(tmpdir(), 'sotto-hyprctl-'))
    const log = join(directory, 'arguments.jsonl')
    await writeFile(join(directory, 'hyprctl'), '#!/bin/sh\nexec "$SOTTO_HYPRCTL_NODE" "$SOTTO_HYPRCTL_STUB" "$@"\n', { mode: 0o700 })
    vi.stubEnv('PATH', `${directory}${delimiter}${process.env.PATH}`)
    vi.stubEnv('SOTTO_HYPRCTL_NODE', process.execPath)
    vi.stubEnv('SOTTO_HYPRCTL_STUB', join(process.cwd(), 'tests/fixtures/hyprctl.mjs'))
    vi.stubEnv('SOTTO_HYPRCTL_LOG', log)
    vi.stubEnv('SOTTO_HYPRCTL_TAGS', target)
    vi.stubEnv('SOTTO_HYPRCTL_FAIL', target)
    let clipboard = ''
    const copyToPrimary = vi.fn(async () => { expect(clipboard).toBe(text) })
    const output = new OutputService({
      clipboard: { writeText: text => { clipboard = text } },
      widget: { hideWidget: vi.fn(), showWidget: vi.fn() }, delay: vi.fn(),
      process: createHyprlandPasteAdapter(undefined, undefined, undefined, copyToPrimary), buildPasteInvocation: buildLinuxPasteInvocation,
    })
    const text = 'exact text "$(touch no)"; `echo no`\n'
    await expect(output.deliver(text, { autoPaste: true, pasteDelayMs: 75 })).resolves.toBe(
      ['exit', 'reply'].includes(target) ? 'copied' : 'pasted',
    )
    expect(clipboard).toBe(text)
    expect(copyToPrimary).toHaveBeenCalledTimes(target === 'terminal' ? 1 : 0)
    const args = parseProviderRecords(await readFile(log, 'utf8'), { keepEmptyLines: true })
    const mods = target === 'terminal' ? 'SHIFT' : 'CTRL'
    const key = target === 'terminal' ? 'Insert' : 'V'
    expect(args).toEqual([
      ['locked', '-j'], ['repl', MODIFIERS_HELD_QUERY], ['activewindow', '-j'],
      ['locked', '-j'],
      ['eval', [
        `hl.dispatch(hl.dsp.send_key_state({ mods = "${mods}", key = "${key}", state = "down" }))`,
        'hl.timer(function()',
        `  hl.dispatch(hl.dsp.send_key_state({ mods = "${mods}", key = "${key}", state = "up" }))`,
        'end, { timeout = 50, type = "oneshot" })',
      ].join('\n')],
    ])
    expect(JSON.stringify(args)).not.toContain(text)
  })
})
