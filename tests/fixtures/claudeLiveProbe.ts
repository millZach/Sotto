/** Explicit opt-in live smoke; uses a fresh synthetic project and the native subscription. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'
import { ClaudeSubscriptionClient } from '../../src/main/agents/subscriptionClaude'

async function main() {
  if (process.env.SOTTO_CLAUDE_LIVE !== '1') throw new Error('Set SOTTO_CLAUDE_LIVE=1 to run a synthetic native subscription turn.')
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-live-')); const cwd = join(root, 'project'); await mkdir(cwd)
  let host = new ClaudeStreamJsonHost({ userDataPath: root, requestTimeoutMs: 15000, pollIntervalMs: 50 })
  const id = randomUUID()
  const thread = async () => (await host.snapshot()).threads.find(thread => thread.id === id)!
  const until = async (check: () => Promise<boolean>) => { const deadline = Date.now() + 45000; while (!await check()) { if (Date.now() > deadline) throw new Error('Live Claude smoke timed out'); await new Promise(resolve => setTimeout(resolve, 50)) } }
  try {
    const status = await host.connect(); assert.equal(status.connected, true, status.error ?? 'Claude subscription unavailable')
    assert.ok(status.models.some(model => model.id === 'default' && model.ready))
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: 'synthetic', title: 'Synthetic verification', path: cwd })
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: 'synthetic', title: 'Synthetic verification', modelId: 'default' })
    assert.deepEqual(await host.execute({ type: 'send', commandId: 'synthetic-command', messageId: 'synthetic-message', threadId: id, text: 'Reply exactly SOTTO_ADAPTER_OK. Do not use tools.' }), { accepted: true })
    await until(async () => (await thread()).status !== 'running')
    assert.equal((await thread()).status, 'idle')
    assert.ok((await thread()).messages.some(message => message.role === 'assistant' && message.text.includes('SOTTO_ADAPTER_OK')))
    const before = await thread(); host.disconnect(); await host.closed()
    host = new ClaudeStreamJsonHost({ userDataPath: root, requestTimeoutMs: 15000, pollIntervalMs: 50 }); host.observeThreads([id]); await host.connect()
    assert.deepEqual((await thread()).messages, before.messages)
    const aliases = JSON.parse(await readFile(join(root, 'claude-threads.json'), 'utf8')); const sessionId = aliases[id].sessionId
    const client = new ClaudeSubscriptionClient(root); const executable = await client.findExecutable(); assert.ok(executable)
    await new Promise<void>((resolve, reject) => {
      const cli = spawn(executable, ['--print', '--resume', sessionId, '--model', 'default', '--output-format', 'json', '--permission-mode', 'default', '--permission-prompts', 'none'], { cwd, env: client.environment(), windowsHide: true, stdio: 'pipe' })
      const timer = setTimeout(() => { cli.kill(); reject(new Error('Synthetic native CLI takeover timed out')) }, 45000)
      let bytes = 0; const consume = (buffer: Buffer) => { bytes += buffer.length; if (bytes > 1024 * 1024) cli.kill() }; cli.stdout.on('data', consume); cli.stderr.on('data', consume)
      cli.on('error', reject); cli.on('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error('Synthetic native CLI takeover failed')) })
      cli.stdin.end('Reply exactly SOTTO_CLI_TAKEOVER_OK. Do not use tools.')
    })
    await until(async () => (await thread()).messages.some(message => message.role === 'user' && message.text.includes('SOTTO_CLI_TAKEOVER_OK') && !message.commandId))
    await assert.rejects(() => host.execute({ type: 'send', commandId: 'stale', messageId: 'stale', threadId: id, text: 'Do not send', expectedLastUserMessageId: 'synthetic-message' }), /changed/u)
    console.log(JSON.stringify({ passed: ['native subscription/model discovery', 'create and prompt acknowledgement', 'streamed assistant result', 'same UUID resume with restored messages', 'native CLI takeover detection', 'stale reply rejection'], cliVersion: (await host.snapshot()).version, syntheticRoot: root }))
  } finally { host.disconnect(); await host.closed() }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Live Claude smoke failed'); process.exitCode = 1 })
