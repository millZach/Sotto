// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { OpenCodeServer, OpenCodeUnsupported } from '../../src/main/agents/opencodeServer'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

/** A stand-in for `opencode serve` that prints what it is given, in the pieces it is given, and then waits. */
async function printing(pieces: readonly string[]): Promise<{ executable: string; args: string[]; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'sotto-opencode-print-'))
  cleanup.push(() => rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const script = `const pieces = ${JSON.stringify(pieces)};
    let at = 0; const next = () => { if (at < pieces.length) { process.stdout.write(pieces[at++]); setTimeout(next, 150) } }; next()
    setInterval(() => {}, 1000)`
  return { executable: process.execPath, args: ['-e', script], cwd }
}
const start = async (pieces: readonly string[]) => {
  const launch = await printing(pieces)
  const started = OpenCodeServer.start({ ...launch, env: process.env, timeoutMs: 15_000 })
  void started.then(server => { cleanup.push(() => server.stop()) }, () => undefined)
  return started
}

it('reads the address only once its line is whole, so an address cut across two reads is not taken', async () => {
  const server = await start(['INFO starting\nserver listening on http://127.0.0.1:355', '17\n'])
  expect(server.url).toBe('http://127.0.0.1:35517')
})

it.each([
  ['http://192.0.2.10:4096'], ['http://example.com:4096'], ['http://127.0.0.1.example.com:4096'], ['http://user:pass@127.0.0.1:4096'],
])('refuses a server that says it listens at %s, off this computer, before its password goes anywhere', async said => {
  const refusal = await start([`server listening on ${said}\n`]).then(() => undefined, (error: unknown) => error)
  expect(refusal).toBeInstanceOf(OpenCodeUnsupported)
  expect((refusal as Error).message).toContain('somewhere other than this computer')
})

it.each([['http://127.0.0.1:4096/'], ['http://localhost:4096'], ['http://[::1]:4096']])('takes a server that listens at %s', async said => {
  const server = await start([`server listening on ${said}\n`])
  expect(server.url).toBe(said.replace(/\/$/u, ''))
})
