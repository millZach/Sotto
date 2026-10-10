// @vitest-environment node
import { parseProviderRecords } from '../fixtures/providerRecords'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'

type Frame = { type: string; uuid?: string; timestamp?: string; message?: { content: unknown } }

it('gives live and saved fake Claude messages identical timestamps, preserving explicit timestamps', async () => {
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
  try {
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize' } }) + '\n')
    await expect.poll(() => frames.some(frame => frame.type === 'control_response')).toBe(true)
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
    child.stdin.write(JSON.stringify({ type: 'user', uuid: 'user', session_id: session, parent_tool_use_id: null,
      message: { role: 'user', content: 'Synthetic user echo' } }) + '\n')
    await expect.poll(() => frames.some(frame => frame.uuid === 'user')).toBe(true)
    const folder = join(root, 'home', 'projects', root.replace(/[^a-zA-Z0-9]/gu, '-'))
    const saved = parseProviderRecords<Frame>(await readFile(join(folder, `${session}.jsonl`), 'utf8'), { keepEmptyLines: true })
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
    expect(stderr).toBe('')
  } finally {
    child.stdin.end()
    await exited
    lines.close()
    await rm(root, { recursive: true, force: true })
  }
})
