import { createConnection } from 'node:net'
import { dictationSocketPath, parseDictationArguments } from './dictationCommand'

const command = parseDictationArguments(process.argv.slice(2))
if (command === null) {
  console.error('Use: sotto dictation start|stop|toggle|cancel')
  process.exitCode = 2
} else {
  try {
    const socket = createConnection(dictationSocketPath(process.env.XDG_RUNTIME_DIR))
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
    socket.once('connect', () => socket.write(`${command}\n`))
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
    console.error('Dictation needs a desktop session with XDG_RUNTIME_DIR. Open Sotto there, then try again.')
    process.exitCode = 1
  }
}
