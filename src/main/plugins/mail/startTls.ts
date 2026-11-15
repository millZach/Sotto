import { createHash } from 'node:crypto'
import { connect as connectTcp } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as connectTls, type TLSSocket } from 'node:tls'

/**
 * TLS begun inside a plain connection (STARTTLS, RFC 3207 and RFC 9051), as Proton Mail Bridge offers it on this
 * computer (ADR-0205, slice 10). Bridge shows a certificate of its own, made for 127.0.0.1 and signed by nobody a
 * computer already trusts. So the certificate is not checked against the usual list: it is checked against the one
 * the user's Bridge showed when the account was added, by its SHA-256, and a connection showing any other is ended
 * before anything is sent over it. Another program on Bridge's port, while Bridge is closed, is never sent the
 * Bridge password.
 */

/** The SHA-256 of a certificate, as hex: what is kept of the one an account's server showed. */
export type MailCertificate = string
/** A server's certificate is not the one kept for it. Nothing was sent over the connection. */
export class MailCertificateChanged extends Error {}
/**
 * TLS could not be begun on a connection whose server had said yes to it, as when it sent something in the clear
 * that is not TLS. That is a server that broke TLS, not one that could not be reached. Nothing was sent.
 */
export class MailTlsBroken extends Error {}

/** Whether text is a certificate's SHA-256 as `certificateOf` writes it. */
export const isMailCertificate = (text: string): boolean => /^[0-9a-f]{64}$/u.test(text)
const certificateOf = (raw: Buffer): MailCertificate => createHash('sha256').update(raw).digest('hex')

/** Whether a host is this computer: the only place a connection that begins in the clear goes. */
export const isThisComputer = (host: string): boolean => host === '127.0.0.1' || host === '::1'

/**
 * A plain connection to a server on this computer, for STARTTLS to make TLS of. Refused for any other host: a
 * connection that leaves the computer is TLS from its first byte.
 */
export const plainToThisComputer = (server: { readonly host: string; readonly port: number }, signal: AbortSignal): Promise<Duplex> => new Promise((resolve, reject) => {
  if (!isThisComputer(server.host)) return reject(new Error('Only this computer is reached without TLS.'))
  if (signal.aborted) return reject(new Error('Stopped before connecting.'))
  const socket = connectTcp({ host: server.host, port: server.port })
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

/**
 * Makes TLS of a plain connection the server has just said yes to STARTTLS on. `kept` is the certificate the server
 * must show, or `learn` to take whichever it shows, as when the account is added or the user trusts a new one.
 * Resolves with the TLS connection and the certificate it showed; rejects with `MailCertificateChanged` when that is
 * not the one kept.
 */
export function startTls(plain: Duplex, kept: MailCertificate | 'learn', signal: AbortSignal): Promise<{ readonly socket: TLSSocket; readonly certificate: MailCertificate }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      plain.destroy()
      return reject(new Error('Stopped before TLS.'))
    }
    // The certificate is checked below, against the one kept, instead of against the usual list.
    const socket = connectTls({ socket: plain, rejectUnauthorized: false })
    const stop = (): void => {
      socket.destroy()
      reject(new Error('Stopped before TLS.'))
    }
    signal.addEventListener('abort', stop, { once: true })
    // Words in the clear that arrive after the yes, rather than with it, reach TLS and break it here.
    const broken = (): void => {
      signal.removeEventListener('abort', stop)
      socket.destroy()
      reject(new MailTlsBroken())
    }
    socket.once('secureConnect', () => {
      signal.removeEventListener('abort', stop)
      socket.off('error', broken)
      const raw = socket.getPeerCertificate().raw
      const certificate = raw ? certificateOf(raw) : ''
      if (!certificate || (kept !== 'learn' && certificate !== kept)) {
        socket.destroy()
        return reject(new MailCertificateChanged())
      }
      resolve({ socket, certificate })
    })
    socket.once('error', broken)
  })
}
