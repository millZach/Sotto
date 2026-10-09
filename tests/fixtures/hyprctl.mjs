// Recording stub only: this file never contacts Hyprland or sends input.
import { appendFileSync } from 'node:fs'
import console from 'node:console'
const args = process.argv.slice(2)
appendFileSync(process.env.SOTTO_HYPRCTL_LOG, `${JSON.stringify(args)}\n`)
switch (args[0]) {
  case 'locked': console.log('{"locked":false}'); break
  case 'repl': console.log('false'); break
  case 'activewindow': console.log(JSON.stringify({ tags: process.env.SOTTO_HYPRCTL_TAGS === 'terminal' ? ['terminal*'] : ['browser'] })); break
  case 'dispatch':
    if (process.env.SOTTO_HYPRCTL_FAIL === 'exit') process.exitCode = 1
    else console.log(process.env.SOTTO_HYPRCTL_FAIL === 'reply' ? 'Invalid dispatcher' : 'ok')
    break
  default: process.exitCode = 2
}
