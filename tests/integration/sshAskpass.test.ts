// @vitest-environment node
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { AskpassBroker, type AskpassQuestion } from '../../src/main/hosts/sshAskpass'

const execute = promisify(execFile)
const brokers: AskpassBroker[] = [], children: ChildProcess[] = [], directories: string[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill()
  for (const broker of brokers.splice(0)) await broker.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env })
    children.push(child)
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code, output }))
  })
}

describe.skipIf(process.platform !== 'win32')('the Windows askpass helper', () => {
  it('keeps complete questions and answers when started directly', async () => {
    const questions: AskpassQuestion[] = []
    const broker = await AskpassBroker.start(async (caller, question) => {
      expect(caller).toBe('ssh')
      questions.push(question)
      return 'fixture réponse'
    }, { platform: 'win32', node: process.execPath })
    brokers.push(broker)
    const env = { ...process.env, ...broker.environment('ssh') }
    const prompt = "The authenticity of host 'forge' can't be established.\nED25519 key fingerprint is SHA256:fixtureKey.\nContinue connecting?"
    expect(await run(env.SSH_ASKPASS!, [prompt], env)).toEqual({ code: 0, output: 'fixture réponse\r\n' })
    expect(questions).toEqual([{ prompt, hint: '' }])
    expect(await run(env.SSH_ASKPASS!, ['Confirm the key'], { ...env, SSH_ASKPASS_PROMPT: 'confirm' })).toMatchObject({ code: 0 })
    expect(questions.at(-1)).toEqual({ prompt: 'Confirm the key', hint: 'confirm' })
    expect(await run(env.SSH_ASKPASS!, ['Touch the key'], { ...env, SSH_ASKPASS_PROMPT: 'none' })).toMatchObject({ code: 0 })
    expect(questions.at(-1)).toEqual({ prompt: 'Touch the key', hint: 'none' })
    const programDirectory = dirname(env.SSH_ASKPASS!)
    await broker.close()
    await expect(access(programDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns no answer when the user cancels or the caller is forgotten', async () => {
    const questions: AskpassQuestion[] = []
    const broker = await AskpassBroker.start(async (_caller, question) => { questions.push(question); return null }, { platform: 'win32', node: process.execPath })
    brokers.push(broker)
    const env = { ...process.env, ...broker.environment('ssh') }
    expect(await run(env.SSH_ASKPASS!, ['Password:'], env)).toEqual({ code: 1, output: '' })
    broker.forget('ssh')
    expect(await run(env.SSH_ASKPASS!, ['Password:'], env)).toEqual({ code: 1, output: '' })
    expect(questions).toHaveLength(1)
  })

  it('removes the helper folder when closed during an unanswered question', async () => {
    const waiting = Promise.withResolvers<void>()
    const broker = await AskpassBroker.start(async (_caller, _question, withdrawn) => {
      waiting.resolve()
      await new Promise<void>(resolve => withdrawn.addEventListener('abort', () => resolve(), { once: true }))
      return null
    }, { platform: 'win32', node: process.execPath })
    brokers.push(broker)
    const env = { ...process.env, ...broker.environment('ssh') }
    const result = run(env.SSH_ASKPASS!, ['Password:'], env)
    void result.catch(error => waiting.reject(error))
    await waiting.promise
    await broker.close()
    expect(await result).toEqual({ code: 1, output: '' })
    await expect(access(dirname(env.SSH_ASKPASS!))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('answers a passphrase request from Windows OpenSSH', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-askpass-key-'))
    directories.push(directory)
    const key = join(directory, 'key')
    const keygen = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe')
    await execute(keygen, ['-q', '-t', 'ed25519', '-N', 'test-secret', '-f', key], { windowsHide: true })
    const questions: AskpassQuestion[] = []
    const broker = await AskpassBroker.start(async (_caller, question) => { questions.push(question); return 'test-secret' }, { platform: 'win32', node: process.execPath })
    brokers.push(broker)
    const result = await run(keygen, ['-y', '-f', key], { ...process.env, ...broker.environment('ssh') })
    expect(result.code).toBe(0)
    expect(result.output).toMatch(/^ssh-ed25519 /u)
    expect(questions).toHaveLength(1)
    expect(questions[0]).toEqual({ prompt: 'Enter passphrase: ', hint: '' })
  })
})
