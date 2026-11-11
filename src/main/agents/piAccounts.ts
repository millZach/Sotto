import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentModel } from '../../shared/agents'
import { PI_SOURCES } from '../../shared/piSignIn'
import type { ModelSources } from '../../shared/opencodeSignIn'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { PiRpc } from './piRpc'
import { PI_EFFORTS, PI_RUNTIME_MODES } from './piModels'
import { PI_ISOLATION_ARGS } from './piRuntime'

export interface PiProgram { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv }
const checkSchema = z.object({ status: z.enum(['ready', 'not_ready', 'invalid']), provider: z.string(), authType: z.string().optional(), reason: z.string().optional() })
const knownSchema = z.array(z.string())
const modelsSchema = z.object({ models: z.array(z.object({ id: z.string(), provider: z.string(), name: z.string(), reasoning: z.boolean().optional(), input: z.array(z.string()).optional() })) })

/** No credential-print command is used. Stdout and stderr are private to the subprocess boundary and never logged. */
export async function piAuthCommand(program: PiProgram, args: readonly string[]): Promise<{ stdout: string; success: boolean }> {
  return new Promise(resolve => execFile(program.executable, [...program.args, 'auth', ...args], { env: program.env, windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
    (error, stdout) => resolve({ stdout, success: error === null })))
}
export class PiAccounts {
  private readonly store: AtomicJsonStore<string[]>
  private pending: Promise<{ sources: ModelSources; models: AgentModel[] }> | undefined
  private revision = 0
  constructor(readonly directory: string, readonly program: () => Promise<PiProgram>) {
    // Identities only: the keys and refresh tokens belong exclusively to Pi's auth.json.
    this.store = new AtomicJsonStore(join(directory, 'sotto-accounts.json'), knownSchema.parse, () => [])
  }
  invalidate(): void { this.revision++; this.pending = undefined }
  async remember(id: string, signedIn: boolean): Promise<void> {
    const known = new Set(await this.store.read())
    if (signedIn) known.add(id); else known.delete(id)
    await this.store.write([...known]); this.invalidate()
  }
  async check(id: string): Promise<z.infer<typeof checkSchema>> {
    try {
      const result = await piAuthCommand(await this.program(), ['check', '--provider', id, '--json'])
      const check = checkSchema.parse(JSON.parse(result.stdout))
      if (check.provider !== id) throw new Error('Unexpected provider.')
      return check
    } catch { return { status: 'invalid', provider: id, reason: 'unavailable' } }
  }
  read(): Promise<{ sources: ModelSources; models: AgentModel[] }> {
    if (this.pending) return this.pending
    const revision = this.revision
    const pending = this.readNow().then(result => revision === this.revision ? result : this.read())
      .finally(() => { if (this.pending === pending) this.pending = undefined })
    this.pending = pending
    return pending
  }
  private async readNow(): Promise<{ sources: ModelSources; models: AgentModel[] }> {
    const known = new Set(await this.store.read())
    const authExists = await access(join(this.directory, 'auth.json')).then(() => true, () => false)
    const available = authExists ? await this.catalogue() : []
    const ids = new Set([...known, ...available.map(model => model.provider)])
    const checks = new Map(await Promise.all([...ids].filter(id => PI_SOURCES.some(source => source.id === id)).map(async id => [id, await this.check(id)] as const)))
    const models = available.filter(model => checks.get(model.provider)?.status === 'ready').map((model): AgentModel => ({
      id: `${model.provider}/${model.id}`, provider: 'Pi', name: model.name, source: PI_SOURCES.find(source => source.id === model.provider)!.name,
      runtimeModes: [...PI_RUNTIME_MODES], ready: true,
      ...(model.input?.includes('image') ? { supportsImages: true } : {}),
      ...(model.reasoning ? { reasoningEfforts: [...PI_EFFORTS], defaultReasoningEffort: 'medium' } : {}),
    }))
    return { models, sources: { status: 'ok', zenModels: 0, sources: PI_SOURCES.map(source => {
      const check = checks.get(source.id)
      return { id: source.id, name: source.name, models: models.filter(model => model.id.startsWith(`${source.id}/`)).length,
        methods: [...source.keyLabel ? [{ id: 'key', kind: 'key' as const, label: source.keyLabel }] : [], ...source.oauthLabel ? [{ id: 'browser', kind: 'browser' as const, label: source.oauthLabel }] : []],
        ...(check?.status === 'ready' ? { signedIn: { how: check.authType === 'oauth' ? 'Account' : 'API key' } }
          : known.has(source.id) ? { signedIn: { how: 'Sign-in needs attention' }, problem: 'unavailable' as const } : {}),
      }
    }) } }
  }
  private async catalogue(): Promise<z.infer<typeof modelsSchema>['models']> {
    const program = await this.program()
    const rpc = new PiRpc(program.executable, [...program.args, '--mode', 'rpc', '--no-session', '--no-mcp', '--no-tools', '--no-context-files', ...PI_ISOLATION_ARGS.filter((arg, i) => arg !== '-e' && PI_ISOLATION_ARGS[i - 1] !== '-e')], this.directory, program.env, 30_000, () => {}, () => {})
    let models: z.infer<typeof modelsSchema>['models'] = []
    try { await rpc.request('get_available_models', {}, value => { models = modelsSchema.parse(value).models }); return models }
    finally { rpc.close(); await rpc.closed }
  }
}
