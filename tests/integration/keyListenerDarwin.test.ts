// @vitest-environment node
// Live checks need Input Monitoring (and Accessibility for osascript) for the terminal running vitest:
//   SOTTO_KEY_LISTENER_LIVE=1 npx vitest run tests/integration/keyListenerDarwin.test.ts
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const binary = resolve(root, 'native/key-listener/build/sotto-key-listener')
const hasSwiftc = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0
const live = process.env.SOTTO_KEY_LISTENER_LIVE === '1'

function startHelper(args: string[] = []) {
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines: string[] = []
  const waiters: Array<() => void> = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line)
    waiters.splice(0).forEach((wake) => wake())
  })
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)))
  async function waitFor(predicate: (seen: string[]) => boolean, ms: number) {
    const deadline = Date.now() + ms
    while (!predicate(lines)) {
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`timed out; saw ${JSON.stringify(lines)}`)
      await new Promise<void>((wake) => { waiters.push(wake); setTimeout(wake, left) })
    }
  }
  return { child, lines, exited, waitFor }
}

describe.runIf(hasSwiftc)('macOS key listener helper', () => {
  it('builds and passes its self-test', () => {
    execFileSync(process.execPath, [resolve(root, 'scripts/build-key-listener.mjs')], { cwd: root, stdio: 'inherit' })
    expect(spawnSync(binary, ['--selftest'], { stdio: 'inherit' }).status).toBe(0)
  }, 180_000)

  it('reports permission first and exits 0 when stdin closes', async () => {
    const helper = startHelper()
    await helper.waitFor((seen) => seen.length > 0, 5_000)
    expect(helper.lines[0]).toMatch(/^permission (granted|denied)$/)
    helper.child.stdin.end()
    expect(await helper.exited).toBe(0)
  })

  it.runIf(live)('reports a posted key while recording', async () => {
    const helper = startHelper(['--accept-synthetic'])
    await helper.waitFor((seen) => seen.length > 0, 5_000)
    expect(helper.lines[0]).toBe('permission granted')
    helper.child.stdin.write('record on\n')
    await new Promise((wait) => setTimeout(wait, 200))
    execFileSync('osascript', ['-e', 'tell application "System Events" to key code 0'])
    await helper.waitFor((seen) => seen.includes('up A'), 5_000)
    expect(helper.lines.slice(1)).toEqual(['down A', 'up A'])
    helper.child.stdin.end()
    expect(await helper.exited).toBe(0)
  })
})
