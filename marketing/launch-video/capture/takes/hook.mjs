// Beats 1 and 2: a sentence dictated into an empty Claude Code composer, sent, and the thread starting work.
// The shortcut, the widget, the recording and the paste are Sotto's own; see storyboard.md on transcription.
import { speak, LINES } from '../lib/voice.mjs'
import { claude, sleep, until } from '../lib/rig.mjs'
import { deskTake, threadIds } from './common.mjs'
import * as darkMode from '../scenes/darkMode.mjs'

export async function hook() {
  const voice = speak('hook')
  const rig = await deskTake({ dictation: { wav: voice.file, transcript: LINES.hook } })
  const { claude: thread } = threadIds()
  try {
    await rig.command({ type: 'select-thread', threadId: thread })
    const prompt = rig.main.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.waitFor()
    await rig.click(prompt, { ms: 0 })
    await sleep(1500)
    darkMode.beforeSend()
    await rig.record('hook')
    await sleep(900)
    await rig.press('ctrl+shift+space')
    rig.mark('listening')
    await sleep(voice.ms + 250)
    await rig.press('ctrl+shift+space')
    await until(async () => (await prompt.inputValue()).includes('dark mode'), { what: 'the transcript in the composer', timeout: 15_000 })
    rig.mark('landed')
    await sleep(800)
    await rig.press('enter')
    rig.mark('sent')
    await darkMode.afterSend(rig, thread)
    await darkMode.work(rig, thread)
    rig.mark('worked')
    await sleep(2500)
    await rig.stop()
    await until(() => claude.session(thread))
  } finally { await rig.close() }
}
