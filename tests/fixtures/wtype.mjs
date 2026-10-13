// Recording stub only: never connects to Wayland or sends input.
import { appendFileSync } from 'node:fs'
import process from 'node:process'

appendFileSync(process.env.SOTTO_HYPRCTL_LOG, `${JSON.stringify(['wtype', ...process.argv.slice(2)])}\n`)
if (process.env.SOTTO_HYPRCTL_FAIL === 'exit') process.exitCode = 1
