import { connect } from 'node:net'
import type { MailConnect } from './read'

/**
 * A mail server on this computer in place of an account's own, for an end-to-end run: whatever server is named, the
 * connection goes to a port on 127.0.0.1 and nowhere else, without TLS. Only an unpackaged build under test is ever
 * handed this; a packaged Sotto reads mail over TLS at the account's own server and has no way to be told otherwise.
 */
export function mailOnThisComputer(port: number): MailConnect {
  return (_server, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Stopped before connecting.'))
    const socket = connect({ host: '127.0.0.1', port })
    const stop = (): void => {
      socket.destroy()
      reject(new Error('Stopped before connecting.'))
    }
    signal.addEventListener('abort', stop, { once: true })
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
    socket.once('close', () => signal.removeEventListener('abort', stop))
  })
}
