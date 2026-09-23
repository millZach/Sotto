import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The helper OpenSSH runs through SSH_ASKPASS for a password, a key passphrase or a host-key answer.
 * It carries the question to the desktop over a loopback socket, with a token only that one ssh process
 * holds, and prints the answer the user gave for ssh to read. It writes nothing else anywhere.
 */
export const ASKPASS_HELPER_SOURCE = String.raw`'use strict';
const net = require('net');
const port = Number(process.env.SOTTO_ASKPASS_PORT), token = process.env.SOTTO_ASKPASS_TOKEN;
if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) process.exit(1);
const socket = net.connect({ host: '127.0.0.1', port });
let input = '', done = false;
const fail = () => { if (!done) { done = true; process.exit(1); } };
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(JSON.stringify({ token, prompt: process.argv.slice(2).join(' '), hint: process.env.SSH_ASKPASS_PROMPT || '' }) + '\n'));
socket.on('data', chunk => {
  input += chunk;
  if (input.length > 16384) return fail();
  const at = input.indexOf('\n');
  if (at === -1 || done) return;
  let reply;
  try { reply = JSON.parse(input.slice(0, at)); } catch { return fail(); }
  if (!reply || typeof reply.answer !== 'string') return fail();
  done = true;
  process.stdout.write(reply.answer + '\n', () => process.exit(0));
});
socket.on('error', fail); socket.on('close', fail);
`

export interface AskpassQuestion {
  /** OpenSSH's own prompt text. On Windows only its first line arrives: cmd.exe cuts an argument at a line break. */
  readonly prompt: string
  /** SSH_ASKPASS_PROMPT: `confirm` for a yes-or-no question answered by exit status, otherwise empty. */
  readonly hint: string
}
/** Resolves with the answer, or null to tell ssh the user gave none. Never logs the question or the answer. */
export type AskpassHandler = (caller: string, question: AskpassQuestion) => Promise<string | null>

interface Caller { readonly id: string; readonly token: Buffer }

/**
 * The desktop's end of SSH_ASKPASS: a listener bound to 127.0.0.1 only, and the helper files OpenSSH
 * runs, in a private temporary folder removed on close. Each ssh process gets its own token, so a
 * question is always answered for the process that asked it.
 */
export class AskpassBroker {
  private readonly callers = new Map<string, Caller>()
  private readonly sockets = new Set<Socket>()
  private closed = false
  private constructor(private readonly server: Server, private readonly port: number, private readonly directory: string,
    private readonly program: string, private readonly node: string, private readonly platform: NodeJS.Platform) {}

  static async start(handler: AskpassHandler, options: { readonly node: string; readonly platform: NodeJS.Platform }): Promise<AskpassBroker> {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-askpass-'))
    try {
      const script = join(directory, 'askpass.cjs')
      await writeFile(script, ASKPASS_HELPER_SOURCE, { encoding: 'utf8', mode: 0o600 })
      let program: string
      if (options.platform === 'win32') {
        // OpenSSH for Windows starts SSH_ASKPASS with CreateProcess, which runs a .cmd but not a script.
        program = join(directory, 'askpass.cmd')
        await writeFile(program, '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%SOTTO_ASKPASS_NODE%" "%~dp0askpass.cjs" %*\r\n', 'utf8')
      } else {
        program = join(directory, 'askpass.sh')
        const quote = (value: string): string => `'${value.replace(/'/gu, "'\\''")}'`
        await writeFile(program, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(options.node)} ${quote(script)} "$@"\n`, { encoding: 'utf8', mode: 0o700 })
        await chmod(program, 0o700)
      }
      const server = createServer()
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); throw new Error('askpass-listen-failed') }
      const broker = new AskpassBroker(server, address.port, directory, program, options.node, options.platform)
      // Nobody knows the port until an ssh process is given it, so no helper can connect before this.
      server.on('connection', socket => broker.accept(socket, handler))
      return broker
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  }

  /** The environment one ssh process needs to reach the user. The token in it is that process's alone. */
  environment(caller: string): NodeJS.ProcessEnv {
    const token = randomBytes(32)
    this.callers.set(caller, { id: caller, token })
    return {
      SSH_ASKPASS: this.program, SSH_ASKPASS_REQUIRE: 'force',
      SOTTO_ASKPASS_PORT: String(this.port), SOTTO_ASKPASS_TOKEN: token.toString('base64url'),
      ...(this.platform === 'win32' ? { SOTTO_ASKPASS_NODE: this.node } : {}),
    }
  }
  /** A finished ssh process's token stops working. */
  forget(caller: string): void { this.callers.delete(caller) }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.callers.clear()
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined)
  }

  private accept(socket: Socket, handler: AskpassHandler): void {
    if (this.closed) { socket.destroy(); return }
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.setEncoding('utf8')
    // A helper sends its question at once; a connection that does not is not one.
    const timer = setTimeout(() => socket.destroy(), 10_000)
    let input = ''
    const onData = (chunk: string): void => {
      input += chunk
      if (input.length > 16_384) { clearTimeout(timer); socket.destroy(); return }
      const at = input.indexOf('\n')
      if (at === -1) return
      clearTimeout(timer)
      socket.removeListener('data', onData)
      let request: { token?: unknown; prompt?: unknown; hint?: unknown }
      try { request = JSON.parse(input.slice(0, at)) as typeof request } catch { socket.destroy(); return }
      const caller = typeof request.token === 'string' ? this.caller(request.token) : undefined
      if (!caller || typeof request.prompt !== 'string') { socket.destroy(); return }
      void handler(caller.id, { prompt: request.prompt, hint: typeof request.hint === 'string' ? request.hint : '' })
        .catch(() => null)
        .then(answer => { if (!socket.destroyed) socket.end(JSON.stringify(answer === null ? { cancel: true } : { answer }) + '\n') })
    }
    socket.on('data', onData)
  }
  private caller(token: string): Caller | undefined {
    const presented = Buffer.from(token, 'base64url')
    for (const caller of this.callers.values()) if (presented.length === caller.token.length && timingSafeEqual(presented, caller.token)) return caller
    return undefined
  }
}
