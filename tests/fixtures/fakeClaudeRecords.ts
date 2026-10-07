/**
 * What the fake Claude CLI (`fakeClaudeThread.mjs`) left in its root folder, read the one way every test reads it:
 * `requests.jsonl` for what each process was started with and sent, and `home/projects/<folder>/<session>.jsonl` for
 * the session files Claude Code would have written.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface FakeClaudeRecord { method?: string; params?: { frame?: { args?: string[]; session?: string } } }
export interface FakeClaudeLaunch { resume: boolean; session: string; args: string[] }

/** Every line of `requests.jsonl`, in the order the fake processes wrote them. */
export async function fakeClaudeRecords(root: string): Promise<FakeClaudeRecord[]> {
  const lines = (await readFile(join(root, 'requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
  return lines.map(line => JSON.parse(line) as FakeClaudeRecord)
}
/** A record's thread launch, with the session ID it was started on; the account check's own run is not one. */
export function fakeClaudeLaunch(record: FakeClaudeRecord): FakeClaudeLaunch | undefined {
  if (record.method !== 'launch' && record.method !== 'resume') return undefined
  const args = record.params?.frame?.args ?? []
  const flag = args.includes('--resume') ? '--resume' : args.includes('--session-id') ? '--session-id' : undefined
  return flag ? { resume: flag === '--resume', session: args[args.indexOf(flag) + 1]!, args } : undefined
}
/** The fake CLI's thread launches, in order. */
export const fakeClaudeLaunches = async (root: string): Promise<FakeClaudeLaunch[]> =>
  (await fakeClaudeRecords(root)).map(fakeClaudeLaunch).filter(launch => launch !== undefined)
/** How many prompts the fake CLIs were sent. */
export const fakeClaudePrompts = async (root: string): Promise<number> => (await fakeClaudeRecords(root)).filter(record => record.method === 'user').length
/** Whether the CLI on this session has exited. */
export const fakeClaudeExited = async (root: string, session: string): Promise<boolean> =>
  (await fakeClaudeRecords(root)).some(record => record.method === 'exit' && record.params?.frame?.session === session)
/** The session IDs the fake CLI has written a session file for. */
export async function fakeClaudeSessionFiles(root: string): Promise<string[]> {
  const projects = join(root, 'home', 'projects')
  const folders = await readdir(projects).catch(() => [] as string[])
  return (await Promise.all(folders.map(folder => readdir(join(projects, folder)).catch(() => [] as string[])))).flat()
    .filter(name => name.endsWith('.jsonl')).map(name => name.slice(0, -'.jsonl'.length))
}
/** The folder the fake CLI keeps a session file in when it runs in `cwd`, named the way Claude Code names it. */
export const fakeClaudeSessionFolder = (root: string, cwd: string): string => join(root, 'home', 'projects', cwd.replace(/[^a-zA-Z0-9]/gu, '-'))
