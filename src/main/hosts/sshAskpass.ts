import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const compile = promisify(execFile)

const WINDOWS_HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Web.Script.Serialization;

class Askpass {
  static int Main(string[] args) {
    try {
      int port;
      string token = Environment.GetEnvironmentVariable("SOTTO_ASKPASS_TOKEN");
      if (!Int32.TryParse(Environment.GetEnvironmentVariable("SOTTO_ASKPASS_PORT"), out port)
          || port < 1 || port > 65535 || String.IsNullOrEmpty(token)) return 1;
      var json = new JavaScriptSerializer();
      var utf8 = new UTF8Encoding(false);
      using (var client = new TcpClient("127.0.0.1", port))
      using (var stream = client.GetStream())
      using (var writer = new StreamWriter(stream, utf8))
      using (var reader = new StreamReader(stream, utf8)) {
        writer.WriteLine(json.Serialize(new Dictionary<string, object> {
          { "token", token }, { "prompt", String.Join(" ", args) },
          { "hint", Environment.GetEnvironmentVariable("SSH_ASKPASS_PROMPT") ?? "" }
        }));
        writer.Flush();
        var input = new StringBuilder();
        int character;
        while ((character = reader.Read()) != -1 && character != '\n') {
          if (input.Length >= 16384) return 1;
          input.Append((char)character);
        }
        if (character == -1) return 1;
        var reply = json.Deserialize<Dictionary<string, object>>(input.ToString());
        object answer;
        if (reply == null || !reply.TryGetValue("answer", out answer) || !(answer is string)) return 1;
        Console.OutputEncoding = utf8;
        Console.WriteLine((string)answer);
        return 0;
      }
    } catch { return 1; }
  }
}
`

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
  /** OpenSSH's own prompt text. */
  readonly prompt: string
  /**
   * SSH_ASKPASS_PROMPT: `confirm` for a yes-or-no question answered by exit status, `none` for a notice
   * that takes no answer (such as "Confirm user presence for key ..." while ssh waits for a security key
   * to be touched), otherwise empty.
   */
  readonly hint: string
}
/**
 * Resolves with the answer, or null to tell ssh the user gave none. `withdrawn` aborts when the helper goes
 * away before an answer, which is ssh no longer waiting for it. Never logs the question or the answer.
 */
export type AskpassHandler = (caller: string, question: AskpassQuestion, withdrawn: AbortSignal) => Promise<string | null>

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
    private readonly program: string) {}

  static async start(handler: AskpassHandler, options: { readonly node: string; readonly platform: NodeJS.Platform }): Promise<AskpassBroker> {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-askpass-'))
    try {
      let program: string
      if (options.platform === 'win32') {
        // OpenSSH starts this executable directly; its arguments stay with the askpass helper.
        const source = join(directory, 'askpass.cs')
        program = join(directory, 'askpass.exe')
        await writeFile(source, WINDOWS_HELPER_SOURCE, 'utf8')
        const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
        // A budget only a hung compiler reaches: csc usually takes a second or two, but a loaded machine (or a virus
        // scan of the new executable) has held it past 15 seconds, which failed a connect that would have worked.
        try {
          await compile(compiler, ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${program}`, source], { windowsHide: true, timeout: 60_000 })
        } catch {
          throw new Error('Sotto could not start its SSH helper. Nothing was saved. Check Windows .NET Framework 4, then reconnect.')
        }
      } else {
        const script = join(directory, 'askpass.cjs')
        await writeFile(script, ASKPASS_HELPER_SOURCE, { encoding: 'utf8', mode: 0o600 })
        program = join(directory, 'askpass.sh')
        const quote = (value: string): string => `'${value.replace(/'/gu, "'\\''")}'`
        await writeFile(program, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(options.node)} ${quote(script)} "$@"\n`, { encoding: 'utf8', mode: 0o700 })
        await chmod(program, 0o700)
      }
      const server = createServer()
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); throw new Error('askpass-listen-failed') }
      const broker = new AskpassBroker(server, address.port, directory, program)
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
    await rm(this.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined)
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
      // ssh kills its helper when it stops waiting (a notice ended, or ssh gave up), so a helper that goes
      // away before its answer takes its question with it.
      const withdrawn = new AbortController()
      let answered = false
      socket.once('close', () => { if (!answered) withdrawn.abort() })
      void handler(caller.id, { prompt: request.prompt, hint: typeof request.hint === 'string' ? request.hint : '' }, withdrawn.signal)
        .catch(() => null)
        .then(answer => { answered = true; if (!socket.destroyed) socket.end(JSON.stringify(answer === null ? { cancel: true } : { answer }) + '\n') })
    }
    socket.on('data', onData)
  }
  private caller(token: string): Caller | undefined {
    const presented = Buffer.from(token, 'base64url')
    for (const caller of this.callers.values()) if (presented.length === caller.token.length && timingSafeEqual(presented, caller.token)) return caller
    return undefined
  }
}
