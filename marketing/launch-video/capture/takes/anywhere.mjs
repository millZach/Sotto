// Beat 8: dictation into another app. Notepad is in front with a short list; the shortcut starts and stops
// Sotto's dictation and the words are pasted at Notepad's cursor.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../lib/stage.mjs'
import { input, sleep } from '../lib/rig.mjs'
import { LINES, speak } from '../lib/voice.mjs'
import { deskTake } from './common.mjs'

/** Where Notepad sits on the 2560x1600 screen, in physical pixels. */
export const NOTEPAD = { x: 680, y: 240, w: 1200, h: 1080 }

export async function anywhere() {
  const voice = speak('anywhere')
  // Sotto stays open behind Notepad, as it would be; Notepad is the app in front.
  const rig = await deskTake({ dictation: { wav: voice.file, transcript: LINES.anywhere }, widgetEdge: 'bottom', topmost: false })
  try {
    const list = join(paths.root, 'Groceries.txt')
    writeFileSync(list, 'Groceries\r\n\r\nRice\r\nLemons\r\n', 'utf8')
    spawn('notepad.exe', [list], { detached: true, stdio: 'ignore' }).unref()
    await sleep(2500)
    input('window', 'Groceries', NOTEPAD.x, NOTEPAD.y, NOTEPAD.w, NOTEPAD.h)
    await sleep(800)
    input('move', NOTEPAD.x + NOTEPAD.w / 2, NOTEPAD.y + NOTEPAD.h / 2, 300); input('click')
    await sleep(300)
    // Notepad's text at 200%, so the words can be read on a phone.
    input('keys', 'ctrl+zero'); for (let i = 0; i < 10; i++) input('keys', 'ctrl+plus')
    input('keys', 'ctrl+end')
    input('move', 2300, 1300, 300)
    await sleep(800)

    // The taskbar shows while Notepad is in front, so the sync mark goes in Sotto's empty sidebar beside it.
    await rig.record('anywhere', { sync: { x: 12, y: 1300 } })
    input('move', 2300, 1300, 300)
    await sleep(900)
    await rig.press('ctrl+shift+space')
    rig.mark('listening')
    await sleep(voice.ms + 250)
    await rig.press('ctrl+shift+space')
    rig.mark('stopped')
    await sleep(3500)
    await rig.stop()
    input('keys', 'ctrl+z'); input('keys', 'ctrl+zero')
  } finally {
    await rig.close()
    input('close-window', 'Groceries')
  }
}
