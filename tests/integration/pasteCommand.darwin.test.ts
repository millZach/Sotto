import { spawn } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { createSpawnProcessAdapter } from '../../src/main/output/outputService'
import { createPasteCommands } from '../../src/main/output/pasteCommand'

const SMOKE_TEXT = 'sotto-osascript-smoke'

const OPEN_TARGET_SCRIPT = `tell application "TextEdit"
  activate
  make new document
end tell
delay 0.5`

const READ_TARGET_SCRIPT = `tell application "TextEdit" to get text of front document`

const CLOSE_TARGET_SCRIPT = `tell application "TextEdit"
  close every document saving no
  quit saving no
end tell`

function runCommand(
  executable: string,
  args: readonly string[],
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    })
    let output = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      output += chunk
    })
    child.once('error', () => reject(new Error(`${executable} failed to start`)))
    child.once('exit', (code) => {
      if (code === 0) resolve(output.trim())
      else reject(new Error(`${executable} exited with code ${String(code)}`))
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

const runAppleScript = (script: string): Promise<string> =>
  runCommand('/usr/bin/osascript', ['-e', script])

const shouldRun =
  process.platform === 'darwin' && process.env.SOTTO_NATIVE_PASTE_SMOKE === '1'

describe.runIf(shouldRun)('macOS native paste integration', () => {
  it('pastes the clipboard into the frontmost native text document', async () => {
    const originalClipboard = await runCommand('/usr/bin/pbpaste', []).catch(() => '')
    await runCommand('/usr/bin/pbcopy', [], SMOKE_TEXT)
    await runAppleScript(OPEN_TARGET_SCRIPT)

    try {
      const invocation = createPasteCommands('darwin').oneShot()
      expect(invocation.executable).toBe('/usr/bin/osascript')
      expect(invocation.args.join(' ')).not.toContain(SMOKE_TEXT)

      const adapter = createSpawnProcessAdapter((executable, args, options) =>
        spawn(executable, [...args], options),
      )
      // A denied Accessibility or Automation grant surfaces here as false; the
      // clipboard-first path then reports 'copied' instead of failing.
      await expect(adapter.run(invocation)).resolves.toBe(true)
      await expect(runAppleScript(READ_TARGET_SCRIPT)).resolves.toBe(SMOKE_TEXT)
    } finally {
      await runAppleScript(CLOSE_TARGET_SCRIPT).catch(() => undefined)
      await runCommand('/usr/bin/pbcopy', [], originalClipboard).catch(() => undefined)
    }
  }, 30_000)
})
