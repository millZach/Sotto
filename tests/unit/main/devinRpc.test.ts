// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DevinRpc, DevinUncertain, DevinRejected, devinEnvironment, readDevinVersion } from '../../../src/main/agents/devinRpc'

function rpc(script: string, receive: ConstructorParameters<typeof DevinRpc>[5] = () => undefined, timeout = 30_000) {
  return new DevinRpc(process.execPath, ['-e', script], process.cwd(), process.env, timeout, receive, () => undefined)
}
describe('Devin stdio boundary', () => {
  it('passes only native account environment, never API routing or billing overrides', () => {
    expect(devinEnvironment({ PATH: 'bin', APPDATA: 'data', HOME: 'home', DEVIN_API_KEY: 'secret', OPENAI_API_KEY: 'secret', DEVIN_BASE_URL: 'elsewhere', NODE_OPTIONS: '--inspect', HTTPS_PROXY: 'proxy' }))
      .toEqual({ PATH: 'bin', APPDATA: 'data', HOME: 'home', HTTPS_PROXY: 'proxy' })
  })
  it('checks the CLI version banner rather than the unversioned ACP identity', async () => {
    expect(await readDevinVersion(process.execPath, ['-e', "process.stdout.write('devin 3000.10.31 (b98cc431)\\n')", '--'])).toBe('3000.10.31')
    await expect(readDevinVersion(process.execPath, ['-e', "process.stdout.write('PRIVATE INVALID BANNER')", '--'])).rejects.not.toThrow('PRIVATE INVALID BANNER')
  })
  it('applies a response and rejects provider errors without exposing their message', async () => {
    const peer = rpc("process.stdin.on('data', b => { for (const l of b.toString().trim().split('\\n')) { const f=JSON.parse(l); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,...(f.method==='ok'?{result:{accepted:true}}:{error:{code:-32015,message:'PRIVATE BODY'}})})+'\\n') } })")
    let result: unknown
    await peer.request('ok', {}, value => { result = value })
    expect(result).toEqual({ accepted: true })
    await expect(peer.request('fail', {})).rejects.toMatchObject({ code: -32015, operation: 'fail' })
    await expect(peer.request('fail', {})).rejects.not.toThrow('PRIVATE BODY')
    peer.close(); await peer.closed
  })
  it('fails closed on malformed frames and does not expose protocol content', async () => {
    const peer = rpc("process.stdin.once('data', () => process.stdout.write('PRIVATE BODY\\n'))")
    await expect(peer.request('initialize', {})).rejects.toBeInstanceOf(DevinUncertain)
    await peer.closed
  })
  it('rejects an oversized outgoing frame without writing it', async () => {
    const peer = rpc("process.stdin.resume()")
    expect(() => peer.write({ text: 'x'.repeat(1024 * 1024) })).toThrow(DevinUncertain)
    await peer.closed
  })
  it('retains a timed-out mutation for late reconciliation without retrying it', async () => {
    let ready!: () => void; let applied!: () => void
    const sent = new Promise<void>(resolve => { ready = resolve })
    const application = new Promise<void>(resolve => { applied = resolve })
    const peer = rpc("let pending;process.stdin.on('data',b=>{for(const l of b.toString().trim().split('\\n')){const f=JSON.parse(l);if(f.method==='session/new'){pending=f;process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'ready'})+'\\n')}else if(f.method==='release'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:pending.id,result:'created'})+'\\n')}}})", frame => { if (frame.method === 'ready') ready() })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const assertion = expect(peer.request('session/new', {}, () => applied())).rejects.toBeInstanceOf(DevinUncertain)
      await sent
      await vi.advanceTimersByTimeAsync(30_000)
      await assertion
      vi.useRealTimers()
      peer.write({ jsonrpc: '2.0', method: 'release' })
      await application
    } finally { vi.useRealTimers(); peer.close(); await peer.closed }
  })
  it('bounds native stderr without retaining its contents', async () => {
    const peer = rpc("process.stdin.once('data', () => process.stderr.write('x'.repeat(1024*1024+1)))")
    await expect(peer.request('initialize', {})).rejects.toBeInstanceOf(DevinUncertain)
    await peer.closed
  })
  it('retains only safe integer diagnostic codes and the outbound operation', () => {
    expect(new DevinRejected(-32015).message).not.toContain('-32015')
    expect(new DevinRejected(-9999, 'session/load')).toMatchObject({ code: -9999, operation: 'session/load' })
    expect(new DevinRejected(Number.MAX_SAFE_INTEGER + 1).code).toBeUndefined()
  })
})
