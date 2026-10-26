// Beat 9: the same window in the six built-in themes, alternating dark and light, as stills.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { VIDEO } from '../lib/stage.mjs'
import { sleep } from '../lib/rig.mjs'
import { deskTake, threadIds } from './common.mjs'
import * as darkMode from '../scenes/darkMode.mjs'
import { cwdOf, runTests } from '../scenes/exchanges.mjs'

export const THEMES = [['sotto', 'dark'], ['hush', 'light'], ['linen', 'dark'], ['nocturne', 'light'], ['tropic', 'dark'], ['citrine', 'light']]

export async function themes() {
  const rig = await deskTake()
  const t = threadIds()
  const out = join(VIDEO, 'public', 'stills')
  mkdirSync(out, { recursive: true })
  try {
    await rig.command({ type: 'select-thread', threadId: t.claude })
    darkMode.beforeSend()
    await rig.command({ type: 'manual-send', threadId: t.claude, text: darkMode.PROMPT })
    await darkMode.afterSend(rig, t.claude)
    await darkMode.work(rig, t.claude, { pace: 0.15, withAgents: false })
    const cwd = await cwdOf(rig, t.claude)
    await darkMode.finish(rig, t.claude, { tests: runTests(cwd).split(/\r?\n/u).filter(line => /^ℹ (tests|pass|fail)/u.test(line)).join('\n') })
    await rig.click(rig.main.getByRole('button', { name: 'Tools', exact: true }), { ms: 0 })
    const panel = rig.main.getByRole('complementary', { name: 'Tools', exact: true })
    await panel.getByRole('tab', { name: 'Changes', exact: true }).click()
    await panel.getByRole('button', { name: 'Expand src/styles/theme.css', exact: true }).click()
    await sleep(1500)
    for (const [theme, mode] of THEMES) {
      await rig.settings({ appearance: mode, [mode === 'dark' ? 'darkTheme' : 'lightTheme']: theme })
      await rig.main.emulateMedia({ reducedMotion: 'no-preference', colorScheme: mode })
      await sleep(900)
      await rig.main.screenshot({ path: join(out, `theme-${theme}-${mode}.png`) })
    }
  } finally { await rig.close() }
}
