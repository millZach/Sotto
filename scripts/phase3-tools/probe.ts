import { app, BrowserWindow, ipcMain, webContents, shell } from 'electron'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { FilesService } from '../../src/main/files/service'
import { TerminalService } from '../../src/main/tools/terminal'
import { BrowserService } from '../../src/main/tools/browser'
import { GitChangesService } from '../../src/main/tools/gitChanges'
import { registerToolsIpc } from '../../src/main/tools/ipc'
import { TERMINAL_EVENT, type TerminalEvent } from '../../src/shared/terminal'
import { BROWSER_EVENT, type BrowserPage } from '../../src/shared/browser'
import type { ToolsResult } from '../../src/shared/tools'

const unwrap = <T>(result: ToolsResult<T>): T => { assert.equal(result.ok, true, JSON.stringify(result)); return (result as { ok: true; value: T }).value }
const wait = async (predicate: () => boolean | Promise<boolean>, label: string, timeout = 12000): Promise<void> => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw new Error(`Timed out: ${label}`)
}
async function main(): Promise<void> {
const evidence: Record<string, unknown> = { versions: process.versions, platform: process.platform, arch: process.arch, checks: [] as string[] }
const passed = (name: string): void => { (evidence.checks as string[]).push(name); console.log(`PASS ${name}`) }
const directory = await mkdtemp(join(tmpdir(), 'sotto-tools-electron-'))
evidence.ownedDirectory = directory
app.setPath('userData', join(directory, 'profile'))
app.on('window-all-closed', () => undefined)
await app.whenReady()
let win: BrowserWindow | undefined, terminal: TerminalService | undefined, browser: BrowserService | undefined, cleanup: (() => void) | undefined
let server: ReturnType<typeof createServer> | undefined
let transcript = ''
try {
  const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'synthetic', workingDirectory: directory }), copyPath: () => {}, reveal: () => {} })
  const events: TerminalEvent[] = []
  terminal = new TerminalService({ files, directory, emit: event => {
    events.push(event)
    if (event.type === 'output') transcript += event.data
    if (win && !win.isDestroyed()) win.webContents.send(TERMINAL_EVENT, event)
  } })
  const owner = unwrap(await terminal.list({ threadId: 'probe' })).workspace
  const target = { threadId: owner.threadId, workspaceId: owner.workspaceId }
  const first = unwrap(await terminal.create(target)), second = unwrap(await terminal.create(target))
  const request = { ...target, sessionId: first.session.id }
  unwrap(await terminal.resize({ ...request, cols: 101, rows: 31 }))
  // The terminal output and cwd are produced by a genuine Windows shell in ConPTY.
  unwrap(await terminal.write({ ...request, data: "Write-Output ('SOTTO_' + 'PTY_OK'); (Get-Location).Path; $Host.UI.RawUI.WindowSize.Width\r" }))
  await wait(() => transcript.includes('SOTTO_PTY_OK') && transcript.includes(directory) && transcript.includes('101'), 'PTY input, cwd and resize')
  assert.equal(unwrap(await terminal.list({ threadId: 'other' })).sessions.length, 0)
  assert.equal(unwrap(await terminal.list({ threadId: 'probe' })).sessions.length, 2)
  passed('Windows PowerShell ConPTY: real input/output, exact cwd, 101x31 resize, two retained sessions, thread ownership')
  // A bounded HTTP server owned by the shell proves long-running child lifetime and Ctrl+C.
  const portFile = join(directory, 'pty-port.txt')
  await writeFile(join(directory, 'server.ps1'), `$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)\n$listener.Start()\n$listener.LocalEndpoint.Port | Set-Content -LiteralPath '${portFile.replaceAll("'", "''")}'\nWrite-Output 'SERVER_READY'\ntry { while ($true) { if ($listener.Pending()) { $client = $listener.AcceptTcpClient(); $stream = $client.GetStream(); $bytes = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nPTY_HTTP"); $stream.Write($bytes, 0, $bytes.Length); $client.Close() }; Start-Sleep -Milliseconds 25 } } finally { $listener.Stop() }\n`)
  unwrap(await terminal.write({ ...request, data: '. ./server.ps1\r' }))
  await wait(() => transcript.includes('SERVER_READY'), 'PTY local server')
  const { readFile } = await import('node:fs/promises')
  const port = Number((await readFile(portFile, 'utf8')).trim())
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'PTY_HTTP')
  const before = transcript.length
  unwrap(await terminal.interrupt(request))
  await wait(() => transcript.slice(before).includes('PS '), 'interrupt returns shell prompt')
  unwrap(await terminal.write({ ...request, data: "Write-Output ('AFTER_' + 'INTERRUPT')\r" }))
  await wait(() => transcript.slice(before).includes('AFTER_INTERRUPT'), 'interrupt returns to shell')
  passed('PTY-owned local HTTP server responded; Ctrl+C stopped the command and shell accepted subsequent input')
  const secondRequest = { ...target, sessionId: second.session.id }
  unwrap(await terminal.write({ ...secondRequest, data: 'exit 7\r' }))
  await wait(async () => unwrap(await terminal!.read(secondRequest)).session.status === 'exited', 'PTY exit')
  assert.equal(unwrap(await terminal.read(secondRequest)).session.exitCode, 7)
  passed('Native exit event and exit code 7')
  if (process.env.SOTTO_TOOLS_PTY_ONLY !== '1') {
    let externalSeen = false
    server = createServer((req, res) => {
      if (req.url === '/external') externalSeen = true
      if (req.url === '/download') { res.writeHead(200, { 'Content-Disposition': 'attachment; filename=blocked.txt' }); res.end('blocked'); return }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html><title>Owned local app</title><input id="retained" value="initial"><a id="bad" href="file:///C:/Windows/win.ini">Blocked file</a><a id="download" href="/download">Download</a><script>window.localProbe=true</script>')
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address(); assert(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { preload: process.env.SOTTO_TOOLS_PRELOAD!, sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ['--sotto-renderer-role=main', '--sotto-platform=win32'] } })
    await win.loadURL(`${base}/host`)
    const host = win
    const pageStates = new Map<string, BrowserPage>()
    browser = new BrowserService({ files, getWindow: () => host, destination: async () => 'external', openExternal: url => shell.openExternal(url), emit: event => { if (event.type === 'page') pageStates.set(event.page.id, event.page); host.webContents.send(BROWSER_EVENT, event) } })
    const gitChanges = new GitChangesService({ files, copyPath: () => {}, reveal: () => {}, emit: () => {} })
    cleanup = registerToolsIpc(ipcMain, { terminal, browser, gitChanges }, () => [{ role: 'main', webContents: host.webContents, url: `${base}/host` }])
    const bridged = await host.webContents.executeJavaScript(`window.sotto.terminal.list({threadId:'probe'})`)
    assert.equal(bridged.ok, true); assert.equal(bridged.value.sessions.length, 2)
    const page = unwrap(await browser.create({ ...target, url: `${base}/one` }))
    await wait(() => pageStates.get(page.id)?.status === 'ready', 'local app navigation')
    const remote = webContents.getAllWebContents().find(contents => contents.getURL() === `${base}/one`)!; assert(remote)
    const isolation = await remote.executeJavaScript(`({sotto:typeof window.sotto,widget:typeof window.sottoWidget,require:typeof require,process:typeof process,opener:window.opener})`)
    assert.deepEqual(isolation, { sotto: 'undefined', widget: 'undefined', require: 'undefined', process: 'undefined', opener: null })
    assert.equal(remote.getLastWebPreferences().preload, undefined)
    assert.notEqual(remote.session, host.webContents.session)
    evidence.isolation = isolation
    passed('Real main/preload IPC works; visited local HTTP page has no Sotto, widget, require, process or opener and a separate session')
    const pageRequest = { ...target, pageId: page.id }
    const childCount = host.contentView.children.length
    unwrap(await browser.mount({ ...pageRequest, bounds: { x: 500, y: 150, width: 400, height: 450 } }))
    await remote.executeJavaScript(`document.querySelector('#retained').value='kept across hiding'`)
    unwrap(await browser.mount({ ...pageRequest, bounds: null }))
    const page2 = unwrap(await browser.create({ ...target, url: `${base}/two` }))
    unwrap(await browser.mount({ ...target, pageId: page2.id, bounds: { x: 500, y: 150, width: 400, height: 450 } }))
    unwrap(await browser.mount({ ...pageRequest, bounds: null }))
    assert.equal(host.contentView.children.length, childCount + 1)
    unwrap(await browser.mount({ ...pageRequest, bounds: { x: 500, y: 150, width: 400, height: 450 } }))
    assert.equal(await remote.executeJavaScript(`document.querySelector('#retained').value`), 'kept across hiding')
    passed('Two main-owned WebContentsViews retained DOM state across hide/focus and stale page cleanup')
    unwrap(await browser.navigate({ ...pageRequest, url: `${base}/next` }))
    await wait(() => pageStates.get(page.id)?.status === 'ready' && pageStates.get(page.id)?.url === `${base}/next`, 'navigate next')
    unwrap(await browser.back(pageRequest)); await wait(() => remote.getURL() === `${base}/one`, 'back')
    unwrap(await browser.forward(pageRequest)); await wait(() => remote.getURL() === `${base}/next`, 'forward')
    unwrap(await browser.reload(pageRequest)); await wait(() => pageStates.get(page.id)?.status === 'ready', 'reload')
    passed('Browser navigation, actual back/forward history and reload')
    await remote.executeJavaScript(`window.open('https://example.com')`)
    await wait(() => pageStates.get(page.id)?.error?.includes('new-window') === true, 'popup blocked')
    assert.equal(webContents.getAllWebContents().length, 3)
    await remote.executeJavaScript(`document.querySelector('#download').click()`)
    await wait(() => pageStates.get(page.id)?.error?.includes('Downloads') === true, 'download blocked')
    await remote.executeJavaScript(`document.querySelector('#bad').click()`)
    assert.equal(remote.getURL().startsWith(base), true)
    for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,evil', 'https://user:password@example.com']) assert.equal((await browser.navigate({ ...pageRequest, url })).ok, false)
    passed('Popup denied without OS launch; download cancelled; file/javascript/data/credential navigation rejected')
    unwrap(await browser.openLink({ url: `${base}/external` }))
    await wait(() => externalSeen, 'system browser reached owned external URL', 20000)
    passed('Default external link used actual shell.openExternal and system browser reached owned loopback server')
    // Use a closed owned listen port, never a guessed port belonging to another app.
    const closed = createServer(); await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const unused = closed.address(); assert(unused && typeof unused !== 'string'); await new Promise<void>(resolve => closed.close(() => resolve()))
    unwrap(await browser.navigate({ ...pageRequest, url: `http://127.0.0.1:${unused.port}/` }))
    await wait(() => pageStates.get(page.id)?.status === 'unavailable', 'unavailable local server')
    passed('Unavailable local server produces explicit unavailable page state')
    const remoteId = remote.id
    unwrap(await browser.close(pageRequest)); assert.equal(webContents.fromId(remoteId), undefined)
    browser.dispose(); await wait(() => webContents.getAllWebContents().length === 1, 'owned pages destroyed')
    passed('Closing and shutdown destroy only owned browser contents')
  }
  terminal.dispose()
  let replacementOutput = ''
  const restored = new TerminalService({ files, directory, emit: event => { if (event.type === 'output') replacementOutput += event.data } })
  const sessions = unwrap(await restored.list({ threadId: 'probe' })).sessions
  assert.equal(sessions.find(session => session.id === first.session.id)?.status, 'interrupted')
  const replacement = unwrap(await restored.reopen(request))
  assert.notEqual(replacement.session.id, first.session.id)
  await wait(() => replacementOutput.includes('PS '), 'reopened shell ready')
  restored.dispose()
  passed('Persisted formerly running terminal truthfully becomes interrupted and explicit reopen creates a new PTY')
  evidence.ok = true
} catch (error) {
  evidence.ok = false; evidence.error = error instanceof Error ? error.stack : String(error)
  evidence.terminalTail = transcript.slice(-12000)
  console.error(evidence.error)
} finally {
  cleanup?.(); terminal?.dispose(); browser?.dispose()
  if (win && !win.isDestroyed()) win.destroy()
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
  await writeFile(process.env.SOTTO_TOOLS_EVIDENCE!, JSON.stringify(evidence, null, 2))
  // The runner removes this owned directory after Electron exits and releases Chromium file locks.
  app.exit(evidence.ok ? 0 : 1)
}
}
void main().catch(error => { console.error(error); app.exit(1) })
