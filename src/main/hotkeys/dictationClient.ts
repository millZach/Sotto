import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { dictationSocketPath, parseDictationArguments } from './dictationCommand'
import { readDictationEndpoint, validateDictationFolder } from './dictationEndpoint'
import { assertDictationDirectories, validateDictationRuntime } from './dictationRuntime'

const request = parseDictationArguments(process.argv.slice(2))
if (request === null) {
  console.error('Use: sotto dictation start|stop|toggle|cancel [--at epoch-ns]')
  process.exitCode = 2
} else {
  let guidance = 'Dictation needs a private desktop runtime folder owned by you, with no folder links. Open Sotto in a desktop session that provides one, then try again.'
  try {
    const directories = validateDictationRuntime(process.env.XDG_RUNTIME_DIR)
    guidance = 'Sotto’s dictation socket is unavailable. Open Sotto in this desktop session, then try again.'
    const path = dictationSocketPath(process.env.XDG_RUNTIME_DIR)
    directories.push(validateDictationFolder(dirname(path)))
    const endpoint = readDictationEndpoint(path)
    assertDictationDirectories(directories)
    const socket = createConnection(endpoint.target === null ? path : join(dirname(path), endpoint.target))
    let finished = false
    const fail = (): void => {
      if (finished) return
      finished = true
      console.error('Sotto could not receive the dictation command. Open Sotto in this desktop session, then try again.')
      process.exitCode = 1
      socket.destroy()
    }
    socket.setTimeout(1_000, fail)
    socket.once('error', fail)
    socket.once('connect', () => socket.write(`${request.command}${request.at === undefined ? '' : ` --at ${request.at}`}\n`))
    let reply = ''
    socket.setEncoding('utf8')
    socket.on('data', data => {
      reply += data
      if (reply.length > 32) fail()
    })
    socket.once('end', () => {
      if (reply !== 'ok\n') fail()
      else { finished = true; socket.destroy() }
    })
    socket.once('close', () => { if (!finished) fail() })
  } catch {
    console.error(guidance)
    process.exitCode = 1
  }
}
