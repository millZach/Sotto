// The stage every take runs on: a throwaway home for Sotto and the provider clients, native stand-ins
// for claude, codex, grok, devin and gh that run the repository's fake clients, and a fresh profile.
// Nothing here touches the real home folder, the real clients or the real credential store.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VIDEO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const REPO = resolve(VIDEO, '..', '..')
export const FIXTURES = join(REPO, 'tests', 'fixtures')
// A short, neutral root: every path Sotto can show on screen starts here.
export const ROOT = process.env.SOTTO_VIDEO_ROOT ?? 'C:\\demo'

export const paths = {
  root: ROOT,
  home: join(ROOT, 'home'),
  appData: join(ROOT, 'home', 'AppData', 'Roaming'),
  localAppData: join(ROOT, 'home', 'AppData', 'Local'),
  bin: join(ROOT, 'bin'),
  fakes: join(ROOT, 'fakes'),
  profile: join(ROOT, 'profile'),
  project: join(ROOT, 'pantry'),
  remote: join(ROOT, 'remotes', 'pantry.git'),
  audio: join(ROOT, 'audio'),
  takes: join(VIDEO, 'public', 'takes'),
}
export const fake = {
  claude: join(paths.fakes, 'claude'),
  codex: join(paths.fakes, 'codex'),
  grok: join(paths.fakes, 'grok'),
  devin: join(paths.fakes, 'devin'),
  ghState: join(paths.fakes, 'gh-state.json'),
}

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'

/** Compiles capture/shim/<name>.cs to .<name>.exe in the stage's bin, unless the exe is newer than the source. */
export function compile(name) {
  const source = join(VIDEO, 'capture', 'shim', `${name}.cs`), out = join(paths.bin, `.${name.toLowerCase()}.exe`)
  if (existsSync(out) && statSync(out).mtimeMs > statSync(source).mtimeMs) return out
  execFileSync(CSC, ['-nologo', '-optimize', '-platform:x64', `-out:${out}`, source], { stdio: 'inherit' })
  return out
}

function shim(target, script, ...prefix) {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(paths.bin, '.shim.exe'), target)
  writeFileSync(target.replace(/\.exe$/u, '.shim'), [process.execPath, script, ...prefix].join('\n') + '\n', 'utf8')
}

/** Builds the stand-ins and the empty fake roots. The profile and project are made elsewhere. */
export function buildStage() {
  if (!/^[A-Za-z]:\\[^\\]+$/u.test(ROOT)) throw new Error(`SOTTO_VIDEO_ROOT must be a top-level folder such as C:\\demo, not ${ROOT}`)
  for (const folder of [paths.home, paths.fakes, paths.bin]) rmSync(folder, { recursive: true, force: true })
  for (const folder of [paths.appData, paths.localAppData, paths.bin, ...Object.values(fake).filter(p => !p.endsWith('.json'))]) mkdirSync(folder, { recursive: true })
  compile('Shim')
  compile('Input')
  // Where each adapter looks first for its client (src/main/agents/subscription*.ts, devinRpc.ts).
  shim(join(paths.home, '.local', 'bin', 'claude.exe'), join(FIXTURES, 'fakeClaudeThread.mjs'), fake.claude)
  shim(join(paths.bin, 'codex.exe'), join(FIXTURES, 'fakeCodexAppServer.mjs'), fake.codex)
  shim(join(paths.home, '.grok', 'bin', 'grok.exe'), join(VIDEO, 'capture', 'fakes', 'grok.mjs'), fake.grok)
  shim(join(paths.localAppData, 'Programs', 'Devin', 'resources', 'app', 'extensions', 'windsurf', 'devin', 'bin', 'devin.exe'), join(VIDEO, 'capture', 'fakes', 'devin.mjs'), fake.devin)
  shim(join(paths.bin, 'gh.exe'), join(VIDEO, 'capture', 'fakes', 'gh.mjs'))
  // Claude's fake writes its transcripts under <root>/home; the adapter reads ~/.claude.
  mkdirSync(join(fake.claude, 'home'), { recursive: true })
  execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', join(paths.home, '.claude'), join(fake.claude, 'home')], { stdio: 'ignore' })
  mkdirSync(join(fake.codex, 'home'), { recursive: true })
  mkdirSync(join(fake.grok, 'home'), { recursive: true })
  // The models each client reports, named as the clients name them today.
  writeFileSync(join(fake.claude, 'models.json'), JSON.stringify([
    { value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · Most capable for complex work', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5 · Best for everyday tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ]))
  writeFileSync(join(fake.codex, 'script.json'), JSON.stringify({ models: [
    { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6 Astra', isDefault: true, defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }] },
  ] }))
  writeFileSync(join(fake.grok, 'script.json'), JSON.stringify({ catalog: { currentModelId: 'grok-4.7', availableModels: [
    { modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { supportsReasoningEffort: true, reasoningEffort: 'high', reasoningEfforts: [{ id: 'xhigh' }, { id: 'high' }, { id: 'medium' }, { id: 'low' }] } },
  ] } }))
  writeFileSync(join(paths.home, '.gitconfig'), '[user]\n\tname = Pantry Dev\n\temail = dev@pantry.example\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n', 'utf8')
}

/** The environment Sotto runs in: the throwaway home, and a PATH with the stand-ins and nothing of the real clients. */
export function stageEnvironment(extra = {}) {
  const git = dirname(execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).split(/\r?\n/u)[0])
  const system = process.env.SystemRoot ?? 'C:\\Windows'
  const environment = {
    SystemRoot: system, windir: system, ComSpec: join(system, 'System32', 'cmd.exe'),
    PATHEXT: process.env.PATHEXT, NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS, PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE,
    OS: process.env.OS, ProgramData: process.env.ProgramData, ProgramFiles: process.env.ProgramFiles, 'ProgramFiles(x86)': process.env['ProgramFiles(x86)'],
    CommonProgramFiles: process.env.CommonProgramFiles, SystemDrive: process.env.SystemDrive,
    PATH: [paths.bin, dirname(process.execPath), git, join(system, 'System32'), system, join(system, 'System32', 'WindowsPowerShell', 'v1.0'), join(system, 'System32', 'OpenSSH')].join(';'),
    USERPROFILE: paths.home, HOME: paths.home, HOMEDRIVE: paths.home.slice(0, 2), HOMEPATH: paths.home.slice(2),
    APPDATA: paths.appData, LOCALAPPDATA: paths.localAppData, USERNAME: 'demo',
    TEMP: join(paths.root, 'tmp'), TMP: join(paths.root, 'tmp'),
    CODEX_HOME: join(fake.codex, 'home'), GROK_HOME: join(paths.home, '.grok'),
    FAKE_GH_STATE: fake.ghState, TZ: 'America/Los_Angeles',
    ...extra,
  }
  mkdirSync(environment.TEMP, { recursive: true })
  return Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined))
}

export function exists(path) { return existsSync(path) }
