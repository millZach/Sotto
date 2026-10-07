// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { parseServeStatus, parseTailscaleStatus, servePortOwner, serveTarget, tailscaleCandidates, TailscaleAccessDenied, TailscaleCli, type TailscaleRun } from '../../../src/main/phones/tailscale'

const running = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'laptop-russh2j5.tail5728ca.ts.net.', HostName: 'Laptop-RUSSH2J5' } })
const web = (target: string, extra: Record<string, unknown> = {}) => ({ TCP: { 8443: { HTTPS: true } }, Web: { 'laptop.tail5728ca.ts.net:8443': { Handlers: { '/': { Proxy: target } } } }, ...extra })
const missing = Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' })

describe('tailscale status', () => {
  it('reads a running node, dropping the trailing dot of its MagicDNS name', () => {
    expect(parseTailscaleStatus(running)).toEqual({ state: 'running', dnsName: 'laptop-russh2j5.tail5728ca.ts.net', hostName: 'Laptop-RUSSH2J5' })
  })
  it('counts a stopped, signed-out or unreadable node as not running', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '' } }))).toEqual({ state: 'not-running' })
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'laptop.tail.ts.net.' } }))).toEqual({ state: 'not-running' })
    expect(parseTailscaleStatus('failed to connect to local tailscaled; it doesn\'t appear to be running')).toEqual({ state: 'not-running' })
    // A name that could carry anything but a DNS name is not used in an address.
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'evil host/path.' } }))).toEqual({ state: 'not-running' })
  })
  it('falls back to the first label when the node reports no host name', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'studio.tail.ts.net.' } }))).toMatchObject({ hostName: 'studio' })
  })
})

describe('who holds port 8443', () => {
  it('is free on an empty setting and on setting that uses other ports only', () => {
    expect(servePortOwner(parseServeStatus(''), 8443, [41000])).toBe('free')
    expect(servePortOwner(parseServeStatus('{}'), 8443, [41000])).toBe('free')
    expect(servePortOwner({ TCP: { 443: { HTTPS: true } }, Web: { 'laptop.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3773' } } } } }, 8443, [41000])).toBe('free')
  })
  it('is Sotto’s only for one HTTPS proxy at / to one of its loopback ports', () => {
    expect(servePortOwner(web(serveTarget(41000)), 8443, [41000])).toBe('ours')
    expect(servePortOwner(web(serveTarget(41000) + '/'), 8443, [39000, 41000])).toBe('ours')
  })
  it('is taken by anything else, which Sotto never overwrites', () => {
    expect(servePortOwner(web('http://127.0.0.1:3773'), 8443, [41000])).toBe('taken')
    expect(servePortOwner(web('http://localhost:41000'), 8443, [41000])).toBe('taken')
    expect(servePortOwner({ TCP: { 8443: { TCPForward: '127.0.0.1:22' } } }, 8443, [41000])).toBe('taken')
    const twoPaths = { TCP: { 8443: { HTTPS: true } }, Web: { 'laptop.ts.net:8443': { Handlers: { '/': { Proxy: serveTarget(41000) }, '/other': { Proxy: 'http://127.0.0.1:9' } } } } }
    expect(servePortOwner(twoPaths, 8443, [41000])).toBe('taken')
    // Funnel on 8443 would put the listener on the internet: never Sotto's, whatever it proxies to.
    expect(servePortOwner(web(serveTarget(41000), { AllowFunnel: { 'laptop.tail5728ca.ts.net:8443': true } }), 8443, [41000])).toBe('taken')
  })
  it('refuses to read a status that is not an object', () => {
    expect(() => parseServeStatus('[1]')).toThrow()
    expect(() => parseServeStatus('not json')).toThrow()
  })
})

describe('the CLI', () => {
  it('looks on the PATH first, then where each platform installs it', () => {
    expect(tailscaleCandidates('win32', { ProgramFiles: 'D:\\Programs' })).toEqual(['tailscale', 'D:\\Programs\\Tailscale\\tailscale.exe'])
    expect(tailscaleCandidates('darwin', {})).toEqual(['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'])
    expect(tailscaleCandidates('linux', {})).toEqual(['tailscale'])
  })
  it('falls through to the next candidate when one is not there, and remembers the one that ran', async () => {
    const run = vi.fn<TailscaleRun>(async executable => { if (executable === 'tailscale') throw missing; return { code: 0, stdout: running, stderr: '' } })
    const cli = new TailscaleCli(run, ['tailscale', 'C:\\Tailscale\\tailscale.exe'])
    expect(await cli.status()).toMatchObject({ state: 'running' })
    await cli.status()
    expect(run.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ['tailscale', ['status', '--json']], ['C:\\Tailscale\\tailscale.exe', ['status', '--json']], ['C:\\Tailscale\\tailscale.exe', ['status', '--json']],
    ])
  })
  it('says Tailscale is missing when no candidate exists', async () => {
    const cli = new TailscaleCli(async () => { throw missing }, ['tailscale'])
    expect(await cli.status()).toEqual({ state: 'missing' })
    await expect(cli.serveStatus()).rejects.toThrow()
  })
  it('asks for HTTPS on 8443 to the loopback port, with argument arrays and never Funnel', async () => {
    const run = vi.fn<TailscaleRun>(async () => ({ code: 0, stdout: 'Serve started and running in the background.', stderr: '' }))
    const cli = new TailscaleCli(run, ['tailscale'])
    expect(await cli.serve(8443, 41000)).toEqual({ ok: true })
    expect(await cli.unserve(8443)).toBe(true)
    expect(run.mock.calls.map(call => call[1])).toEqual([['serve', '--bg', '--https=8443', 'http://127.0.0.1:41000'], ['serve', '--https=8443', 'off']])
    expect(run.mock.calls.flatMap(call => call[1]).join(' ')).not.toMatch(/funnel/iu)
    expect(run.mock.calls[0]![2]).toMatchObject({ timeoutMs: expect.any(Number), stopOn: expect.any(RegExp) })
  })
  it('stops at the consent page when the tailnet has not turned Serve on, and hands back its address', async () => {
    const stdout = 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nXyZ123CNTRL\n'
    const run = vi.fn<TailscaleRun>(async (_executable, _args, options) => { expect(options.stopOn!.test(stdout)).toBe(true); return { code: null, stdout, stderr: '' } })
    expect(await new TailscaleCli(run, ['tailscale']).serve(8443, 41000)).toEqual({ ok: false, reason: 'not-enabled', enableUrl: 'https://login.tailscale.com/f/serve?node=nXyZ123CNTRL' })
  })
  it('says Tailscale refused this account, as Linux does until the account is its operator', async () => {
    const stderr = 'Access denied: serve config denied\n\nUse \'sudo tailscale serve\' or \'sudo tailscale set --operator=$USER\' to run it as you.\n'
    const cli = new TailscaleCli(async () => ({ code: 1, stdout: '', stderr }), ['tailscale'])
    expect(await cli.serve(8443, 41000)).toEqual({ ok: false, reason: 'denied' })
    await expect(cli.serveStatus()).rejects.toBeInstanceOf(TailscaleAccessDenied)
  })
  it('reports any other serve failure as failed', async () => {
    const cli = new TailscaleCli(async () => ({ code: 1, stdout: '', stderr: 'error: something went wrong' }), ['tailscale'])
    expect(await cli.serve(8443, 41000)).toEqual({ ok: false, reason: 'failed' })
    expect(await cli.unserve(8443)).toBe(false)
  })
})
