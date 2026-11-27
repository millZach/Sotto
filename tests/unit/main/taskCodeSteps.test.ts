// @vitest-environment node
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runCodeStep } from '../../../src/main/automation/codeSteps'

it('keeps a JSON command result within the playbook limit intact', async () => {
  const result = await runCodeStep({
    argv: [process.execPath, '-e', "process.stdout.write(JSON.stringify({ data: 'x'.repeat(10000) }))"],
    cwd: tmpdir(), env: {}, timeoutMs: 10_000, signal: new AbortController().signal, jsonOutput: true,
  })
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ data: 'x'.repeat(10000) })
})

it.skipIf(process.platform !== 'win32')('passes punctuation in one argument to a Windows command script', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'sotto-task-code-'))
  const command = join(folder, 'echo-args.cmd')
  try {
    await writeFile(command, '@echo off\r\necho first=[%~1] second=[%~2]\r\n')
    const result = await runCodeStep({
      argv: [command, '--format=json', 'second'], cwd: folder, env: {}, timeoutMs: 10_000, signal: new AbortController().signal,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('first=[--format=json] second=[second]')
  } finally {
    await unlink(command)
    await rmdir(folder)
  }
})
