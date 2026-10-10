import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { LAUNCH_SCRIPT_SOURCE } from '../../src/main/hosts/launchScript'

export interface LaunchScriptOutcome {
  readonly messages: Record<string, unknown>[]
  readonly code: number | null
  readonly errors: string
}

/** Collect the existing JSON messages; process ownership and error decisions stay with the case. */
export function collectLaunchScript(child: ChildProcess): Promise<LaunchScriptOutcome> {
  let output = '', errors = ''
  child.stdout!.on('data', chunk => { output += String(chunk) })
  child.stderr!.on('data', chunk => { errors += String(chunk) })
  return new Promise(resolve => child.once('close', code => resolve({ code, errors,
    messages: output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>) })))
}

/** One operation as SSH sends it: source on stdin, configuration in one argument. */
export function launchScriptChild(configuration: Record<string, unknown>, env?: NodeJS.ProcessEnv, track: (child: ChildProcess) => void = () => undefined): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ['--input-type=commonjs', '-', JSON.stringify(configuration)],
    { shell: false, windowsHide: true, ...(env ? { env } : {}) })
  track(child)
  child.stdin!.end(LAUNCH_SCRIPT_SOURCE)
  return child
}
