import { connect, createServer } from 'node:net'

/** A loopback port nothing is listening on, for a throwaway sshd. */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(done => server.close(() => done()))
  return port
}

/** sshd has started listening once a TCP connection is answered with its banner. */
export async function banner(port: number): Promise<boolean> {
  return new Promise(done => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(1000, () => { socket.destroy(); done(false) })
    socket.once('data', chunk => { socket.destroy(); done(chunk.toString('utf8').startsWith('SSH-')) })
    socket.once('error', () => done(false))
  })
}
