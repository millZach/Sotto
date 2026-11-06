// A wrapper in front of the fake Claude CLI that runs it as its child rather than replacing itself with it, as a shell
// script named claude that calls the real CLI without `exec` does (#657). Ending only this process leaves the CLI running.
import { spawn } from 'node:child_process'

const child = spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 1))
