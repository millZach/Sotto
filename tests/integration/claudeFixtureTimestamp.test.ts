// @vitest-environment node
import { parseProviderRecords } from '../fixtures/providerRecords'
import { claudeTranscriptPath } from '../fixtures/claudeFixture'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'

type Frame = { type: string; uuid?: string; timestamp?: string; message?: { content: unknown } }

/** The fake CLI on a provider session of its own, initialized, keeping every frame it prints, with its next action scripted. */
async function fakeClaude() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-claude-timestamps-'))
  const session = 'fixture-session'
  const child = spawn(process.execPath, [resolve('tests/fixtures/fakeClaudeThread.mjs'), root,
    '--session-id', session, '--permission-mode', 'default', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio'],
  { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const exited = once(child, 'exit')
  const frames: Frame[] = []
  let stderr = ''
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => { frames.push(JSON.parse(line) as Frame) })
  const control = join(root, `control-${session}.json`)
  const action = async (value: Record<string, unknown>) => {
    await expect.poll(() => readFile(control).then(() => false, () => true)).toBe(true)
    await writeFile(control, JSON.stringify(value))
  }
  const saved = async () => parseProviderRecords<Frame>(await readFile(claudeTranscriptPath(root, session), 'utf8').catch(() => ''), { keepEmptyLines: true })
  const close = async () => { child.stdin.end(); await exited; lines.close(); await rm(root, { recursive: true, force: true }) }
  child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize' } }) + '\n')
  await expect.poll(() => frames.some(frame => frame.type === 'control_response')).toBe(true)
  return { root, session, child, frames, action, saved, close, stderr: () => stderr }
}

it('gives live and saved fake Claude messages identical timestamps, preserving explicit timestamps', async () => {
  const fake = await fakeClaude()
  const { frames, action, session } = fake
  try {
    await action({ id: 'complete', type: 'complete', text: 'Synthetic completed reply' })
    await expect.poll(() => frames.some(frame => frame.type === 'result')).toBe(true)
    const explicit = '2026-01-02T03:04:05.678Z'
    await action({ id: 'raw', type: 'raw', persist: true, frame: { type: 'assistant', uuid: 'raw', message: { content: 'Synthetic raw reply' } } })
    await expect.poll(() => frames.some(frame => frame.uuid === 'raw')).toBe(true)
    await action({ id: 'burst', type: 'raw-burst', persist: true, frames: [
      { type: 'assistant', uuid: 'burst', message: { content: 'Synthetic burst reply' } },
      { type: 'assistant', uuid: 'explicit', timestamp: explicit, message: { content: 'Synthetic dated reply' } },
    ] })
    await expect.poll(() => frames.some(frame => frame.uuid === 'explicit')).toBe(true)
    fake.child.stdin.write(JSON.stringify({ type: 'user', uuid: 'user', session_id: session, parent_tool_use_id: null,
      message: { role: 'user', content: 'Synthetic user echo' } }) + '\n')
    await expect.poll(() => frames.some(frame => frame.uuid === 'user')).toBe(true)
    const saved = await fake.saved()
    const live = frames.filter(frame => frame.type === 'assistant' || frame.type === 'user')
    expect(live).toHaveLength(5)
    expect(saved).toHaveLength(5)
    for (const frame of live) {
      const replay = saved.find(value => value.uuid === frame.uuid)!
      expect(frame.timestamp, `Live ${frame.uuid} must carry its saved event timestamp`).toBe(replay.timestamp)
      expect(Number.isFinite(Date.parse(frame.timestamp!))).toBe(true)
      expect(frame.message).toEqual(replay.message)
    }
    expect(live.find(frame => frame.uuid === 'explicit')!.timestamp).toBe(explicit)
    expect(fake.stderr()).toBe('')
  } finally { await fake.close() }
})

// The referee asks for this, so a finished reply's date is never the moment Sotto heard its stream open (#2698). The
// reply opens on a thinking block, saved once its stream has begun, and finishes only once the test lets it: dated as it
// finished, the reply would come after the thinking line; dated before its stream began, it comes before.
it('dates a finished reply before its stream began when asked to', async () => {
  const fake = await fakeClaude()
  const { frames, action, root } = fake
  try {
    await action({ id: 'dated', type: 'complete', text: 'Synthetic dated-before reply', thinking: 'Weighing it', holdAfterThinking: 'finish', datedBeforeStream: true })
    await expect.poll(async () => (await fake.saved()).length).toBe(1)
    const [thinking] = await fake.saved()
    await writeFile(join(root, 'finish'), '')
    await expect.poll(() => frames.some(frame => frame.type === 'result')).toBe(true)
    const finished = frames.find(frame => frame.type === 'assistant' && JSON.stringify(frame.message?.content).includes('Synthetic dated-before reply'))!
    expect(Date.parse(finished.timestamp!)).toBeLessThan(Date.parse(thinking!.timestamp!))
    expect((await fake.saved()).at(-1)?.timestamp).toBe(finished.timestamp)
    expect(fake.stderr()).toBe('')
  } finally { await fake.close() }
})
