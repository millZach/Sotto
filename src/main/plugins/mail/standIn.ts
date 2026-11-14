import { connect } from 'node:net'
import { MAIL_SEND_SERVERS } from './accounts'
import type { MailConnect, MailServer } from './read'

/** Whether a server is one that mail is sent through, rather than read from. */
const sendsThrough = (server: MailServer): boolean => Object.values(MAIL_SEND_SERVERS).some(sending => sending.host === server.host && sending.port === server.port)

/**
 * Mail servers on this computer in place of an account's own, for an end-to-end run: whatever server is named, the
 * connection goes to a port on 127.0.0.1 and nowhere else, without TLS. A sending server goes to `sendPort`, and with
 * none given it is reached by nothing. Only an unpackaged build under test is ever handed this; a packaged Sotto
 * reaches the account's own servers over TLS and has no way to be told otherwise.
 */
export function mailOnThisComputer(port: number, sendPort?: number): MailConnect {
  return (server, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Stopped before connecting.'))
    const to = sendsThrough(server) ? sendPort : port
    if (to === undefined) return reject(new Error('E2E_NETWORK_DISABLED'))
    const socket = connect({ host: '127.0.0.1', port: to })
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
