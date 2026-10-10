import { randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { SocketFrames } from '../../src/host/socketFrames'
import { phoneTerminalApprovalSchema } from '../../src/shared/phoneTerminals'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, firstSottoWindow, launchSotto, openThreads } from './support/sottoLaunch'

// Usage: npm run build && npx playwright test tests/e2e/phone-terminals.spec.ts
test('a paired phone reviews and answers a built desktop terminal through its live hook', async () => {
  test.skip(process.platform !== 'win32', 'Windows native PTY acceptance')
  test.setTimeout(180_000)
  const bin = await mkdtemp(join(tmpdir(), 'sotto-e2e-phone-terminal-bin-'))
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'"
  await writeFile(join(bin, 'claude.ps1'), `& ${quote(process.execPath)} ${quote(resolve('tests/fixtures/fakeTerminalAgent.mjs'))} 'claude' @args\nexit $LASTEXITCODE\n`)
  const launched = await launchSotto('design-threads', undefined, {
    createProfile: async () => {
      const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-'))
      await writeFile(join(profile, 'e2e-tailscale.json'), JSON.stringify({ state: 'running', dnsName: 'studio.tail5728ca.ts.net', hostName: 'studio', serve: 'free' }))
      return profile
    },
    launch: options => electron.launch({ ...options, env: { ...options?.env, PATH: bin + ';' + (options?.env?.PATH ?? process.env.PATH ?? ''), SOTTO_FAKE_PERMISSION_WAIT_MS: '30000' } }),
    firstWindow: firstSottoWindow,
    removeProfile: path => rm(requireOwnedE2EProfile(path), { recursive: true, force: true }),
  })
  const { page } = launched
  let frames: SocketFrames | undefined
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, phoneAccess: true, reducedMotion: 'on' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await openThreads(page)
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.phones!.get()).phase)).toBe('on')
    const code = await page.evaluate(async () => (await window.sotto!.phones!.command({ type: 'show-code' })).code!.code)
    const record = JSON.parse(await readFile(join(launched.userData, 'phone-access.json'), 'utf8')) as { port: number }
    const base = `http://127.0.0.1:${record.port}`
    const paired = await (await fetch(base + '/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, code, name: 'Terminal test iPhone' }) })).json() as { clientId: string; token: string }
    const { session } = await (await fetch(base + '/v1/session', { method: 'POST', headers: { Authorization: 'Bearer ' + paired.token } })).json() as { session: string }
    const messages: Record<string, unknown>[] = []
    frames = await new Promise<SocketFrames>((resolveFrames, reject) => {
      const upgrade = httpRequest(base + '/v1/socket', { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), Authorization: 'Bearer ' + session } })
      upgrade.on('error', reject)
      upgrade.on('upgrade', (_response, stream, head) => {
        const socket = new SocketFrames(stream, true, text => messages.push(JSON.parse(text) as Record<string, unknown>))
        socket.feed(head); resolveFrames(socket)
      }); upgrade.end()
    })
    const call = async (operation: Record<string, unknown>) => {
      const id = randomUUID(); frames!.send({ v: 1, id, session, ...operation })
      await expect.poll(() => messages.find(message => message.id === id)).toBeDefined()
      return messages.find(message => message.id === id)!
    }
    const hello = await call({ op: 'hello', accepts: ['terminals'] })
    expect(hello.ok).toBe(true); expect((hello.result as { features: string[] }).features).toContain('terminals')
    await page.getByRole('radio', { name: 'Terminal', exact: true }).click()
    await page.getByRole('complementary', { name: 'Terminal sidebar', exact: true }).getByRole('button', { name: 'New terminal in workshop', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'New terminal', exact: true })
    await dialog.getByLabel('Terminal name', { exact: true }).fill('Phone approval')
    await dialog.getByLabel('Terminal provider', { exact: true }).selectOption('claude')
    await dialog.getByRole('button', { name: 'Open terminal', exact: true }).click()
    const terminalId = await page.evaluate(async () => {
      const listing = await window.sotto!.terminals!.list()
      if (!listing.ok) throw new Error(listing.error.message)
      return listing.value.terminals.find(item => item.title === 'Phone approval')!.id
    })
    const state = () => page.evaluate(async id => {
      const result = await window.sotto!.terminals!.read({ id })
      if (!result.ok) throw new Error(result.error.message)
      return result.value.terminal.agentState
    }, terminalId)
    await expect.poll(state).toBe('idle')
    const input = page.locator('.terminal-pane').filter({ has: page.getByRole('heading', { name: 'Phone approval', exact: true }) }).locator('.xterm-helper-textarea')
    await input.pressSequentially('w'); await input.press('Enter'); await expect.poll(state).toBe('working')
    await input.pressSequentially('n'); await input.press('Enter'); await expect.poll(state).toBe('needs-you')
    let approval: ReturnType<typeof phoneTerminalApprovalSchema.parse> | undefined
    await expect.poll(async () => {
      const result = await call({ op: 'terminal-approval', terminalId })
      const parsed = phoneTerminalApprovalSchema.safeParse(result.result)
      if (parsed.success) approval = parsed.data
      return parsed.success
    }).toBe(true)
    const { lines, ...binding } = approval!
    expect(lines.join('\n')).toContain('Do you want to make this edit')
    const shell = await call({ op: 'shell' })
    expect(JSON.stringify(shell.result)).not.toMatch(/PRIVATE_|Do you want to make this edit|tool_input|HOOK_SECRET/u)
    const screen = page.locator('.terminal-pane').locator('.xterm-screen')
    let capture: Buffer | undefined
    // Main's ready state can precede the GPU frame. Prove text is painted before retaining visual evidence.
    await expect.poll(async () => {
      const box = await screen.boundingBox()
      if (!box) return 0
      const png = await page.screenshot({ scale: 'css' })
      const ink = await page.evaluate(async ({ base64, box }) => {
        const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let ink = 0
        for (let y = Math.floor(box.y); y < Math.min(canvas.height, box.y + box.height); y++) {
          for (let x = Math.floor(box.x); x < Math.min(canvas.width, box.x + box.width); x++) {
            const index = (y * canvas.width + x) * 4
            if (pixels[index]! > 150 && pixels[index + 1]! > 150 && pixels[index + 2]! > 150) ink++
          }
        }
        return ink
      }, { base64: png.toString('base64'), box })
      if (ink > 500) capture = png
      return ink
    }).toBeGreaterThan(500)
    const folder = resolve('artifacts/phone-terminals'); await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'desktop-live-approval.png'), capture!)
    const answer = { ...binding, decision: 'deny' }
    expect(await call({ op: 'answer-terminal', answer })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    await page.evaluate(async clientId => { await window.sotto!.phones!.command({ type: 'set-can-answer', clientId, allowed: true }) }, paired.clientId)
    expect(await call({ op: 'answer-terminal', answer })).toMatchObject({ ok: true, result: { answerDelivered: true } })
    expect(await call({ op: 'answer-terminal', answer })).toMatchObject({ ok: false, error: { code: 'stale_request' } })
    expect(errors).toEqual([])
  } finally {
    frames?.close(); await closeSotto(launched); await rm(bin, { recursive: true, force: true })
  }
})
