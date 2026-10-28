import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { plural, t } from '@lingui/core/macro'
import { z } from 'zod'


import { OMARCHY_PIECES, shortcutsBlocked, type OmarchyPiece, type OmarchyPieceState, type OmarchySetupCommand, type OmarchySetupState } from '../../shared/omarchySetup'
import type { DictationShortcutSet } from '../../shared/dictationShortcuts'
import type { AppSettings, SettingsPatch } from '../../shared/settings'
import { OMARCHY_THEME_ID, parseOmarchyTheme } from '../../shared/themes/omarchy'
import { atomicWrite, contents, digest, exclusiveWrite, plainPath, treeDigest } from './files'
import { omarchySetupEnvironment } from './environment'
import { boundChords, chordOfBind, DEFAULT_OMARCHY_SHORTCUTS, hyprlandChord, linuxChordWords, linuxKeyList, renderSottoBindings, SOTTO_BIND_LABELS } from './keys'

const ID = 'sotto.dictation'
const REQUIRE = '-- Sotto Omarchy setup\nrequire("hypr.sotto-bindings")\n-- End Sotto Omarchy setup\n'
const appearanceSchema = z.object({ appearance: z.enum(['system', 'light', 'dark']), theme: z.enum(['system', 'light', 'dark']), lightTheme: z.string(), darkTheme: z.string() }).strict()
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const pendingSchema = z.object({ operation: z.enum(['setup', 'remove']), previousHash: hashSchema.nullable(), token: z.string().uuid(),
  restart: z.boolean(), bindingsBeforeHash: hashSchema.nullable().optional(), bindingsAfterHash: hashSchema.nullable().optional(),
  owlOptions: z.record(z.string(), z.unknown()).optional() }).strict()
const pieceReceiptSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), backup: z.string().optional(),
  originalMissing: z.boolean().optional(), appearance: appearanceSchema.optional(), pending: pendingSchema.optional() }).strict()
const receiptSchema = z.object({ version: z.literal(1), pieces: z.object({
  keys: pieceReceiptSchema.optional(), owl: pieceReceiptSchema.optional(), theme: pieceReceiptSchema.optional(),
}).strict() }).strict()
type Receipt = z.infer<typeof receiptSchema>
type PieceReceipt = z.infer<typeof pieceReceiptSchema>

export interface CommandOutput { readonly ok: boolean; readonly stdout: string; readonly stderr: string }
export type SetupRun = (command: string, args: readonly string[]) => Promise<CommandOutput>
export interface OmarchySetupOptions {
  readonly home: string
  readonly data: string
  readonly resources: string
  readonly version: string
  readonly settings: { get(): Promise<AppSettings>; update(patch: SettingsPatch): Promise<unknown> }
  readonly run?: SetupRun
  readonly environment?: NodeJS.ProcessEnv
  readonly onChanged?: (state: OmarchySetupState) => void
  /** The dictation shortcuts as saved, read without waiting on the settings queue. Omitted, Sotto's keys are the defaults. */
  readonly shortcuts?: () => Promise<DictationShortcutSet>
  /** Saves shortcuts whose keys Hyprland has just taken; a throw rolls the keys back. */
  readonly commitShortcuts?: (set: DictationShortcutSet) => Promise<void>
  /** The Owl feature `dictation-hold-shortcuts`, read once at start. Off, only the first press shortcut and the hold shortcuts are bound. */
  readonly holdShortcutsEnabled?: boolean
}

/** A shortcut change's answer, shown only in its row. */
export type OmarchyShortcutsResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'conflict' | 'invalid' | 'unavailable'; readonly chord?: string; readonly message: string }

function state(status: OmarchyPieceState['status'], message = '', owned = false, retry?: OmarchyPieceState['retry']): OmarchyPieceState {
  return { status, message, owned, ...(retry ? { retry } : {}) }
}
function ownedHash(hash: string | null, receipt: PieceReceipt | undefined): boolean {
  return hash !== null && !!receipt && (hash === receipt.hash || hash === receipt.pending?.previousHash)
}
const bindSchema = z.object({ key: z.string(), modmask: z.number(), dispatcher: z.string(), arg: z.string(),
  release: z.boolean().optional(), description: z.string().optional() }).passthrough()
type Bind = z.infer<typeof bindSchema>
const bindsSchema = z.array(bindSchema)
const shellConfigSchema = z.object({ bar: z.object({ layout: z.record(z.string(), z.array(z.unknown())).optional() }).optional() }).passthrough()
const pluginsSchema = z.array(z.object({ id: z.string() }).passthrough())
const objectSchema = z.record(z.string(), z.unknown())
type Verb = 'start' | 'stop' | 'toggle'
const VOXTYPE_LABELS = { start: 'Start dictation (push-to-talk)', stop: 'Stop dictation (push-to-talk)', toggle: 'Toggle dictation' }
const isSottoBind = (bind: Bind, verb: Verb, legacySotto: boolean): boolean => sottoVerb(bind) === verb ||
  bind.dispatcher === '__lua' && (bind.description === SOTTO_BIND_LABELS[verb] || legacySotto && bind.description === VOXTYPE_LABELS[verb])
/** The verb a binding runs when it runs Sotto's command, read from its command line or its label. */
function sottoVerb(bind: Bind): Verb | null {
  const verb = /(?:^|[\s/'"])sotto(?:['"])?\s+dictation\s+(start|stop|toggle)\b/.exec(bind.arg)?.[1] as Verb | undefined
  if (verb) return verb
  if (bind.dispatcher !== '__lua') return null
  return (Object.keys(SOTTO_BIND_LABELS) as Verb[]).find(key => bind.description === SOTTO_BIND_LABELS[key]) ?? null
}

/** Who owns each of these chords, including a hold's release binding. Without shortcuts, the default F9 and Super+Ctrl+X. */
export function inspectDictationBindings(value: unknown, legacySotto = false, shortcuts: DictationShortcutSet = DEFAULT_OMARCHY_SHORTCUTS): { conflicts: string[]; voxtype: boolean; manual: boolean } {
  const chords = boundChords(shortcuts)
  const binds = bindsSchema.parse(value).flatMap(bind => {
    const on = chordOfBind(bind, chords)
    return on ? [{ bind, on }] : []
  })
  const verb = ({ bind, on }: (typeof binds)[number]): Verb => on.role === 'press' ? 'toggle' : bind.release ? 'stop' : 'start'
  // Lua binds expose only callback IDs. Sotto's labels identify new snippets;
  // the old shared labels are Sotto's only with a recognised, loaded legacy snippet.
  const isSotto = (entry: (typeof binds)[number]): boolean => sottoVerb(entry.bind) !== null ||
    entry.bind.dispatcher === '__lua' && legacySotto && entry.bind.description === VOXTYPE_LABELS[verb(entry)]
  const isVoxtype = ({ bind, ...entry }: (typeof binds)[number]): boolean => /(?:^|[\s/'"])voxtype(?:['"])?\s/.test(bind.arg) ||
    bind.dispatcher === '__lua' && !legacySotto && bind.description === VOXTYPE_LABELS[verb({ bind, ...entry })]
  const conflicts = binds.filter(entry => !isSotto(entry) && !isVoxtype(entry))
    .map(({ bind, on }) => `${linuxChordWords(on.chord)} runs “${(bind.description || bind.dispatcher).slice(0, 800)}”.`)
  const has = (role: 'hold' | 'press', chord: (typeof chords)[number], wanted: Verb): boolean => binds.some(entry =>
    entry.on === chord && isSottoBind(entry.bind, wanted, legacySotto) && (role === 'press' || (wanted === 'stop') === (entry.bind.release === true)))
  return { conflicts: [...new Set(conflicts)].slice(0, 100), voxtype: binds.some(isVoxtype),
    manual: conflicts.length === 0 && chords.length > 0 && chords.every(chord => chord.role === 'press'
      ? has('press', chord, 'toggle') : has('hold', chord, 'start') && has('hold', chord, 'stop')) }
}

/** The bindings Hyprland already runs on a chord, other than Sotto's own and Voxtype's, which Sotto's keys take over. */
export function hyprlandUses(value: unknown, chord: string): string | null {
  const hypr = hyprlandChord(chord)
  if (hypr === null) return null
  const entry = bindsSchema.parse(value).find(bind => chordOfBind(bind, [{ chord, role: 'press', hypr }]) !== undefined &&
    sottoVerb(bind) === null && !/(?:^|[\s/'"])voxtype(?:['"])?\s/.test(bind.arg) &&
    !(bind.dispatcher === '__lua' && Object.values(VOXTYPE_LABELS).includes(bind.description ?? '')))
  return entry === undefined ? null : (entry.description || entry.dispatcher).slice(0, 800)
}

/** Resources are outside ASAR on Linux; development uses the same checked-in pieces. */
export async function findOmarchyResources(resourcesPath: string, checkout: string): Promise<string> {
  const bundled = join(resourcesPath, 'omarchy')
  if (await contents(join(bundled, 'bindings.lua')) !== null) return bundled
  return join(resolve(checkout), 'apps/omarchy')
}

/** Main owns setup, file ownership and its single operation lane. No command output enters a log. */
export class OmarchySetup {
  private receipt: Receipt = { version: 1, pieces: {} }
  private loaded = false
  private lane: Promise<unknown> = Promise.resolve()
  private readonly notes: Partial<Record<OmarchyPiece, OmarchyPieceState>> = {}
  private snapshot: OmarchySetupState = { pieces: { keys: state('missing'), owl: state('missing'), theme: state('missing') },
    busy: false, keyConflicts: [], voxtype: false, shellRunning: false, notice: '' }
  private readonly receiptPath: string
  private readonly hypr: string
  private readonly bindings: string
  private readonly snippet: string
  private readonly snippetBackup: string
  private readonly plugin: string
  private readonly template: string
  private readonly rendered: string
  private readonly shellConfig: string
  private readonly run: SetupRun

  constructor(private readonly options: OmarchySetupOptions) {
    this.receiptPath = join(options.data, 'omarchy-setup.json')
    this.hypr = join(options.home, '.config/hypr')
    this.bindings = join(this.hypr, 'bindings.lua')
    this.snippet = join(this.hypr, 'sotto-bindings.lua')
    // The snippet as it was before the latest shortcut change; bindings.lua's own backup is made once, at setup.
    this.snippetBackup = join(this.hypr, 'sotto-bindings.lua.bak')
    this.plugin = join(options.home, '.config/omarchy/plugins', ID)
    this.template = join(options.home, '.config/omarchy/themed/sotto.json.tpl')
    this.rendered = join(options.home, '.local/state/omarchy/current/theme/sotto.json')
    this.shellConfig = join(options.home, '.config/omarchy/shell.json')
    this.run = options.run ?? ((command, args) => new Promise(resolveRun => {
      execFile(command, [...args], { env: omarchySetupEnvironment({ ...process.env, ...options.environment }, options.home), timeout: 30_000, maxBuffer: 128 * 1024 },
        (error, stdout, stderr) => resolveRun({ ok: !error, stdout: String(stdout), stderr: String(stderr) }))
    }))
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lane.then(operation)
    this.lane = next.catch(() => undefined)
    return next
  }
  private publish(): OmarchySetupState {
    const result = structuredClone(this.snapshot)
    this.options.onChanged?.(result)
    return result
  }
  private async load(): Promise<void> {
    if (this.loaded) return
    const saved = await contents(this.receiptPath)
    if (saved !== null) {
      const parsed = receiptSchema.safeParse(JSON.parse(saved))
      if (!parsed.success) throw new Error(t`Sotto could not read its Omarchy setup record. Your files were left alone. Restore the record, then try again.`)
      this.receipt = parsed.data
    }
    this.loaded = true
  }
  private async save(piece: OmarchyPiece, receipt?: PieceReceipt): Promise<void> {
    const next = structuredClone(this.receipt)
    if (receipt) next.pieces[piece] = receipt
    else delete next.pieces[piece]
    await atomicWrite(this.receiptPath, JSON.stringify(next), 0o600)
    this.receipt = next
  }
  private async savePending(piece: OmarchyPiece, receipt: PieceReceipt, previousHash: string | null, removing: boolean,
    detail: { restart?: boolean; bindingsBeforeHash?: string | null; bindingsAfterHash?: string | null; owlOptions?: Record<string, unknown> } = {}): Promise<PieceReceipt> {
    const next = { ...receipt, pending: { operation: removing ? 'remove' as const : 'setup' as const, previousHash,
      token: this.receipt.pieces[piece]?.pending?.token ?? randomUUID(), restart: detail.restart ?? false, ...detail } }
    await this.save(piece, next)
    return next
  }
  private async checked(command: string, args: readonly string[], message: string): Promise<string> {
    const result = await this.run(command, args)
    if (!result.ok) throw new Error(message)
    return result.stdout
  }
  /** What Sotto's keys bind: the saved shortcuts, with extra press shortcuts only while the Owl feature is on. */
  private async keyShortcuts(): Promise<DictationShortcutSet> {
    return this.bound(await (this.options.shortcuts?.() ?? Promise.resolve(DEFAULT_OMARCHY_SHORTCUTS)))
  }
  private bound(set: DictationShortcutSet): DictationShortcutSet {
    // Stable keeps the first hold shortcut bound, F9 unless an Owl run changed it, as Linux always has (ADR-0097).
    // Extra holds, like extra press shortcuts, are the Owl feature's: stable binds the first and keeps the rest saved.
    return this.options.holdShortcutsEnabled ? { press: [...set.press], hold: [...set.hold] } : { press: set.press.slice(0, 1), hold: set.hold.slice(0, 1) }
  }
  /** The bundled snippet, rebound to these shortcuts. */
  private async renderKeys(set: DictationShortcutSet): Promise<string> {
    const template = await contents(join(this.options.resources, 'bindings.lua'))
    const rendered = template === null ? null : renderSottoBindings(set, template)
    if (rendered === null) throw new Error(t`This Sotto install is missing its keys. Install Sotto again.`)
    return rendered
  }
  private async bundledHash(piece: OmarchyPiece): Promise<string> {
    if (piece === 'keys') return digest(await this.renderKeys(await this.keyShortcuts()))
    const value = piece === 'owl' ? await treeDigest(join(this.options.resources, 'shell-plugin', ID))
      : await contents(join(this.options.resources, 'sotto.json.tpl'))
    if (value === null) throw new Error(t`This Sotto install is missing its Omarchy files. Install Sotto again, then try again.`)
    return piece === 'owl' ? value : digest(value)
  }
  private async installedHash(piece: OmarchyPiece): Promise<string | null> {
    if (piece === 'owl') return treeDigest(this.plugin)
    const value = await contents(piece === 'keys' ? this.snippet : this.template)
    return value === null ? null : digest(value)
  }
  private async onBar(): Promise<boolean> {
    const value = await contents(this.shellConfig)
    if (value === null) return false
    const config = shellConfigSchema.parse(JSON.parse(value))
    // Top-level plugins enable services; only a bar layout entry places the owl.
    return Object.values(config.bar?.layout ?? {}).flat().some(entry =>
      entry === ID || (typeof entry === 'object' && entry !== null && 'id' in entry && entry.id === ID))
  }

  private async detect(): Promise<void> {
    await this.load()
    const binds = await this.run('hyprctl', ['binds', '-j'])
    let keys: ReturnType<typeof inspectDictationBindings> | null = null
    const shortcuts = await this.keyShortcuts()
    if (binds.ok) {
      try {
        const file = await contents(this.bindings), snippet = await contents(this.snippet)
        const knownSnippet = (text: string): boolean => /local\s+sotto\s*=\s*["'][^\n]*sotto/.test(text) &&
          ['start', 'stop', 'toggle'].every(verb => new RegExp(`dictation\\(["']${verb}["']\\)`).test(text))
        const legacy = !!file && (snippet !== null && !snippet.includes('Sotto dictation') && knownSnippet(snippet) && /require\(["']hypr\.sotto-bindings["']\)\s*(?:-- End Sotto Omarchy setup\s*)?$/.test(file.trim()) || !file.includes('Sotto dictation') && knownSnippet(file))
        keys = inspectDictationBindings(JSON.parse(binds.stdout), legacy, shortcuts)
      } catch { /* A malformed response is unavailable, never permission to replace keys. */ }
    }
    this.snapshot.keyConflicts = keys?.conflicts ?? []
    this.snapshot.voxtype = keys?.voxtype ?? false
    this.snapshot.shellRunning = (await this.run('omarchy-shell', ['shell', 'ping'])).ok
    for (const piece of OMARCHY_PIECES) {
      try {
        const installed = await this.installedHash(piece), ours = this.receipt.pieces[piece]
        let next: OmarchyPieceState
        if (installed === null) next = state('missing', '', !!ours)
        else if (!ours) next = state('manual', t`Set up by hand. Sotto leaves these files alone.`)
        else if (!ownedHash(installed, ours)) next = state('conflict', t`These files changed outside Sotto. Sotto leaves them alone.`, true)
        else next = state(installed === await this.bundledHash(piece) ? 'done' : 'stale', '', true)
        if (piece === 'keys') {
          const file = await contents(this.bindings)
          const bindingHash = file === null ? null : digest(file)
          const untouched = ours?.pending && (bindingHash === ours.pending.bindingsBeforeHash || bindingHash === ours.pending.bindingsAfterHash)
          if (ours && installed !== null && !file?.includes(REQUIRE) && !untouched) next = state('conflict', t`The line Sotto added to bindings.lua changed. Sotto leaves your file alone.`, true)
          if (keys?.manual && !ours) next = state('manual', t`Your bindings.lua already gives ${{ keys: linuxKeyList(shortcuts) }} to Sotto. Leaving those lines alone.`)
          else if (keys && !keys.manual && next.status === 'manual') next = state('conflict', t`A key snippet was installed by hand, but Hyprland is not using it. Sotto leaves it alone.`)
          else if (keys && !keys.manual && next.status === 'done') next = state('missing', t`Hyprland is not using Sotto’s keys.`, true)
          else if (next.status === 'missing' && keys && keys.conflicts.length && !ours) next = state('conflict')
          if (!keys) next = state('failed', t`Sotto could not read Hyprland’s keys. Open Sotto in your Omarchy desktop session, then try again.`, !!ours)
        }
        if (piece === 'owl' && ['done', 'manual', 'stale'].includes(next.status) && !await this.onBar()) {
          next = ours ? state(next.status === 'stale' ? 'stale' : 'missing', t`The owl is not on the bar.`, true)
            : state('conflict', t`A plugin was installed by hand, but it is not on the bar. Sotto leaves it alone.`)
        }
        if (piece === 'theme' && next.status === 'manual' && await contents(this.rendered) === null) {
          next = state('conflict', t`A template was installed by hand, but its colours have not been rendered. Sotto leaves it alone.`)
        }
        if (piece === 'theme' && ['done', 'stale'].includes(next.status) && await contents(this.rendered) === null) {
          next = state('missing', t`Omarchy has not rendered Sotto’s colours.`, true)
        }
        if (piece === 'theme' && installed === null && !ours && await contents(this.rendered) !== null) {
          next = state('manual', t`An Omarchy palette was installed by hand. Sotto leaves it alone.`)
        }
        if (next.status === 'stale' && piece === 'owl') next.message = t`Sotto ${{ version: this.options.version }} has a newer owl. Updating restarts the bar for a moment.`
        if (ours?.pending && next.status !== 'conflict') {
          next = piece === 'owl' && ours.pending.restart ? state('stale', t`The owl update stopped before it finished. Updating it restarts the bar for a moment.`, true)
            : state('failed', ours.pending.operation === 'remove' ? t`Removal stopped before it finished. Try again to finish removing this piece.`
              : t`Setup stopped before it finished. Try again, or remove it in Settings › Dictation.`, true, ours.pending.operation)
        }
        // Operation outcomes stay visible while detection continues to see that same outcome.
        const note = this.notes[piece]
        if (note && (note.status === next.status || (note.status === 'failed' && (['missing', 'stale'].includes(next.status) || note.retry === 'remove' && next.status === 'done')) ||
          (note.status === 'skipped' && (['missing', 'conflict', 'stale'].includes(next.status) || !!ours?.pending && next.status === 'failed')))) next = { ...note, owned: next.owned }
        this.snapshot.pieces[piece] = next
      } catch (error) { this.snapshot.pieces[piece] = state('failed', this.explain(error), !!this.receipt.pieces[piece]) }
    }
  }
  private explain(error: unknown): string {
    if (error instanceof Error && !('code' in error) && !(error instanceof z.ZodError) && !(error instanceof SyntaxError)) return error.message.slice(0, 8000)
    return t`Sotto could not read or change these files. Check that your configuration is readable and writable, then try again.`
  }
  private async inspect(): Promise<boolean> {
    try { await this.detect(); return true } catch (error) {
      for (const piece of OMARCHY_PIECES) this.snapshot.pieces[piece] = state('failed', this.explain(error), false, 'inspect')
      return false
    }
  }
  get(): Promise<OmarchySetupState> {
    // A get during a run sees progress without starting a second inspection over changing files.
    if (this.snapshot.busy) return Promise.resolve(structuredClone(this.snapshot))
    return this.enqueue(async () => {
      await this.inspect()
      return this.publish()
    })
  }

  command(command: OmarchySetupCommand): Promise<OmarchySetupState> {
    return this.enqueue(async () => {
      if (!await this.inspect()) return this.publish()
      const pieces = command.type === 'update-owl' ? ['owl'] as const : OMARCHY_PIECES.filter(piece => command.pieces.includes(piece))
      const keyBackup = command.type === 'remove' ? this.receipt.pieces.keys?.backup : undefined
      this.snapshot.busy = true
      this.snapshot.operation = command.type
      this.snapshot.notice = ''
      this.publish()
      try {
        for (const piece of pieces) {
          const previous = this.snapshot.pieces[piece]
          if (previous.status === 'manual') continue
          if (command.type === 'remove' && !previous.owned) continue
          if (command.type !== 'remove' && previous.status === 'done') continue
          if (previous.status === 'conflict' && (piece !== 'keys' || previous.owned || !this.snapshot.keyConflicts.length)) continue
          if (piece === 'owl' && previous.status === 'stale' && command.type !== 'update-owl' && command.type !== 'remove') continue
          if (piece === 'keys' && command.type === 'setup' && this.snapshot.keyConflicts.length) {
            if (command.keys !== 'give') {
              this.notes.keys = state(command.keys === 'keep' ? 'skipped' : 'conflict', command.keys === 'keep'
                ? t`Left alone. Your keys still run what they did before.` : t`Choose whether to give these keys to Sotto first.`, previous.owned)
              this.snapshot.pieces.keys = this.notes.keys
              this.publish()
              continue
            }
          }
          delete this.notes[piece]
          this.snapshot.pieces[piece] = state('working', command.type === 'remove' ? t({ message: 'Removing', comment: 'What an Omarchy setup piece is doing now, on its row in Settings › Dictation.' }) : t({ message: 'Setting up', comment: 'What an Omarchy setup piece is doing now, on its row in Settings › Dictation.' }), previous.owned)
          this.publish()
          try {
            if (command.type === 'remove') await this.remove(piece)
            else await this.install(piece, command.type === 'update-owl')
          } catch (error) { this.notes[piece] = state(piece === 'owl' && command.type === 'update-owl' && previous.owned ? 'stale' : 'failed',
            this.explain(error), !!this.receipt.pieces[piece], command.type === 'remove' ? 'remove' : 'setup') }
          this.snapshot.pieces[piece] = this.notes[piece] ?? state('done', '', true)
          this.publish()
        }
      } finally {
        this.snapshot.busy = false
        delete this.snapshot.operation
        await this.inspect()
      }
      if (command.type === 'remove' && pieces.length === 3 && keyBackup && !this.receipt.pieces.keys && this.notes.keys?.status === 'missing' &&
        (await lstat(keyBackup).catch(() => null))?.isFile()) this.snapshot.notice = t`Sotto kept the copy of bindings.lua it made at setup, in ~/.config/hypr.`
      return this.publish()
    })
  }

  /** Existing ownership authorizes only keys and theme refreshes. Restarting the bar always waits for a press. */
  refreshAtStart(): Promise<OmarchySetupState> {
    return this.enqueue(async () => {
      await this.detect()
      for (const piece of ['keys', 'theme'] as const) {
        if (this.snapshot.pieces[piece].status !== 'stale') continue
        // A newly conflicting chord is new authority: ask in Settings instead.
        if (piece === 'keys' && this.snapshot.keyConflicts.length) continue
        try {
          await this.install(piece, false, true)
          this.notes[piece] = state('done', t`Updated for Sotto ${{ version: this.options.version }}.`, true)
        } catch (error) { this.notes[piece] = state('failed', this.explain(error), true) }
      }
      await this.detect()
      return this.publish()
    })
  }

  /**
   * Rebinds Sotto's keys to these shortcuts. A save in Settings › Dictation is the user's press (ADR-0062, ADR-0097),
   * and only keys Sotto set up are rewritten. The answer, Hyprland's words included, belongs to the row, never a log.
   */
  replaceShortcuts(set: DictationShortcutSet): Promise<OmarchyShortcutsResult> {
    return this.enqueue(async (): Promise<OmarchyShortcutsResult> => {
      const next = this.bound(set)
      const unbindable = [...next.press, ...next.hold].find(chord => hyprlandChord(chord) === null)
      if (next.press.length === 0 || unbindable !== undefined) {
        return { ok: false, reason: 'invalid', ...(unbindable === undefined ? {} : { chord: unbindable }),
          message: t`Hyprland can’t bind those keys. Use a letter, a number, an F key, Space or an arrow key, with modifiers.` }
      }
      if (next.hold.some(chord => hyprlandChord(chord)!.modmask !== 0)) {
        return { ok: false, reason: 'invalid', message: t`On Linux a hold shortcut is one F key on its own, such as F9. With a modifier, Hyprland can miss the release and keep listening.` }
      }
      if (boundChords(next).length !== next.press.length + next.hold.length) {
        return { ok: false, reason: 'invalid', message: t`Each shortcut can be in only one row, once. Pick other keys.` }
      }
      const inspected = await this.inspect()
      const blocked = inspected ? shortcutsBlocked(this.snapshot.pieces.keys) : this.snapshot.pieces.keys.message
      if (blocked !== null) {
        this.publish()
        return { ok: false, reason: 'unavailable', message: blocked }
      }
      const active = await this.run('hyprctl', ['binds', '-j'])
      let binds: unknown
      try { binds = active.ok ? JSON.parse(active.stdout) : null } catch { binds = null }
      if (!Array.isArray(binds)) return { ok: false, reason: 'unavailable', message: t`Sotto could not read Hyprland’s keys. Nothing was changed. Open Sotto in your Omarchy desktop session, then try again.` }
      for (const chord of [...next.hold, ...next.press]) {
        const use = hyprlandUses(binds, chord)
        if (use !== null) return { ok: false, reason: 'conflict', chord, message: t`Hyprland already uses ${{ keys: linuxChordWords(chord) }} for “${use}”. Pick other keys.` }
      }
      const previous = await this.keyShortcuts()
      this.snapshot.busy = true
      this.publish()
      try {
        try { await this.changeKeys(false, next) } catch (error) { return { ok: false, reason: 'unavailable', message: this.explain(error) } }
        try { await this.options.commitShortcuts?.(set) } catch {
          try { await this.changeKeys(false, previous) } catch (error) {
            return { ok: false, reason: 'unavailable', message: t`Sotto could not save the shortcut or put your previous keys back. ${{ problem: this.explain(error) }}` }
          }
          return { ok: false, reason: 'unavailable', message: t`Sotto could not save the shortcut. Your previous keys are back in Hyprland.` }
        }
        return { ok: true }
      } finally {
        // The row says how it went; the Omarchy panel keeps its own notes.
        delete this.notes.keys
        this.snapshot.busy = false
        await this.inspect()
        this.publish()
      }
    })
  }

  private async install(piece: OmarchyPiece, restart: boolean, refresh = false): Promise<void> {
    if (piece === 'keys') await this.changeKeys(false)
    else if (piece === 'owl') await this.changeOwl(false, restart)
    else await this.changeTheme(false, refresh)
  }
  private async remove(piece: OmarchyPiece): Promise<void> {
    if (piece === 'keys') await this.changeKeys(true)
    else if (piece === 'owl') await this.changeOwl(true, false)
    else await this.changeTheme(true, false)
  }

  private async configErrors(): Promise<string[]> {
    return (await this.checked('hyprctl', ['configerrors'], t`Sotto could not check Hyprland’s configuration. Your keys were left alone.`))
      .split('\n').map(line => line.trim()).filter(Boolean)
  }
  private async reload(before: readonly string[]): Promise<void> {
    await this.checked('hyprctl', ['reload'], t`Hyprland could not reload. Try again in your desktop session.`)
    const added = (await this.configErrors()).filter(line => !before.includes(line))
    if (added.length) throw new Error(t`Hyprland reported an error after Sotto’s change. Hyprland said: “${{ said: added.join('\n').slice(0, 6000) }}”.`)
  }
  /** Writes Sotto's keys for the saved shortcuts, or for `change` when a shortcut is being changed, and removes them. */
  private async changeKeys(removing: boolean, change?: DictationShortcutSet): Promise<void> {
    const original = await contents(this.bindings), snippet = await contents(this.snippet), ours = this.receipt.pieces.keys
    const shortcuts = change ?? await this.keyShortcuts()
    if (snippet !== null && !ownedHash(digest(snippet), ours)) throw new Error(t`These keys were changed by hand. Sotto left them alone.`)
    if (ours && original !== null && !original.includes(REQUIRE) && digest(original) !== ours.pending?.bindingsBeforeHash && digest(original) !== ours.pending?.bindingsAfterHash) throw new Error(t`The line Sotto added changed. Your keys were left alone.`)
    const without = (original ?? '').replace(REQUIRE, '')
    // A shortcut change rewrites only Sotto's own snippet; bindings.lua keeps its require where it is.
    const next = removing ? without : change && original?.includes(REQUIRE) ? original : `${without}${without.endsWith('\n') || !without ? '' : '\n'}${REQUIRE}`
    // A shortcut change leaves bindings.lua untouched, neither written nor restored, so an edit made meanwhile stays.
    const keepBindings = !removing && change !== undefined && original !== null && original.includes(REQUIRE)
    // Removal needs no snippet, so an install missing its keys can still take them out.
    const bundled = removing ? '' : await this.renderKeys(shortcuts)
    await mkdir(this.hypr, { recursive: true })
    await mkdir(this.options.data, { recursive: true })
    const check = join(this.options.data, `.sotto-keys-${randomUUID()}.lua`)
    try {
      if (!keepBindings) {
        await writeFile(check, next, { flag: 'wx', mode: 0o600 })
        await this.checked('luac', ['-p', check], t`Sotto could not check bindings.lua with luac. Your file is as it was. Check its syntax and that Lua is installed, then try again.`)
        await rm(check)
      }
      if (!removing) {
        await writeFile(check, bundled, { flag: 'wx', mode: 0o600 })
        await this.checked('luac', ['-p', check], t`Sotto’s keys could not be checked with luac. Your file is as it was. Install Sotto again, then try again.`)
      }
    } finally { await rm(check, { force: true }) }
    const before = await this.configErrors()
    let backup = ours?.backup
    if (!removing && !ours && original !== null) {
      let epoch = Math.floor(Date.now() / 1000)
      for (;;) {
        backup = join(this.hypr, `bindings.lua.bak.${epoch++}`)
        try { await exclusiveWrite(backup, original, (await lstat(this.bindings)).mode & 0o777); break }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
    }
    // Backup first: a shortcut change keeps the snippet it replaces beside it.
    if (keepBindings && snippet !== null) await atomicWrite(this.snippetBackup, snippet, 0o600)
    const nextReceipt = { hash: removing ? ours!.hash : digest(bundled), ...(backup ? { backup } : {}), originalMissing: ours?.originalMissing ?? original === null }
    await this.savePending('keys', nextReceipt, snippet === null ? null : digest(snippet), removing, {
      bindingsBeforeHash: original === null ? null : digest(original), bindingsAfterHash: removing && ours?.originalMissing && next === '' ? null : digest(next),
    })
    try {
      if (removing) {
        if (ours?.originalMissing && next === '') await rm(this.bindings, { force: true }); else await atomicWrite(this.bindings, next)
        await rm(this.snippet, { force: true })
        await rm(this.snippetBackup, { force: true })
      } else {
        await atomicWrite(this.snippet, bundled)
        if (!keepBindings) await atomicWrite(this.bindings, next)
      }
      await this.reload(before)
      if (!removing) {
        const active = await this.checked('hyprctl', ['binds', '-j'], t`Sotto could not check the reloaded keys. Try again in your desktop session.`)
        if (!inspectDictationBindings(JSON.parse(active), false, shortcuts).manual) throw new Error(t`Hyprland did not load Sotto’s keys. Check that bindings.lua loads after Omarchy’s defaults, then try again.`)
      }
      await this.save('keys', removing ? undefined : nextReceipt)
    } catch (error) {
      try {
        if (keepBindings) { /* bindings.lua was never written */ } else if (original === null) await rm(this.bindings, { force: true }); else await atomicWrite(this.bindings, original)
        if (snippet === null) await rm(this.snippet, { force: true }); else await atomicWrite(this.snippet, snippet)
        await this.reload(before)
        await this.save('keys', ours)
      } catch { throw new Error(t`${{ problem: this.explain(error) }} Sotto could not restore the keys. Check that ~/.config/hypr is writable, then try again.`) }
      throw new Error(t`${{ problem: this.explain(error) }} Sotto restored your files. Fix the error, then try again.`, { cause: error })
    }
    if (removing) {
      let message = t`Your keys run what they did before.`
      try {
        const keys = inspectDictationBindings(JSON.parse((await this.run('hyprctl', ['binds', '-j'])).stdout), false, shortcuts)
        const list = linuxKeyList(shortcuts), count = boundChords(shortcuts).length
        if (!keys.conflicts.length) message = keys.voxtype ? plural(count, { one: `${list} is Voxtype’s again.`, other: `${list} are Voxtype’s again.` })
          : plural(count, { one: `${list} does nothing now.`, other: `${list} do nothing now.` })
      } catch { /* Do not guess a key owner after an unavailable read. */ }
      this.notes.keys = state('missing', message)
    } else this.notes.keys = state('done', this.snapshot.voxtype ? t`Hyprland reloaded with no new errors. Voxtype keeps running without these keys.` : t`Hyprland reloaded with no new errors.`, true)

  }

  private async changeOwl(removing: boolean, restart: boolean): Promise<void> {
    if (!(await this.run('omarchy-shell', ['shell', 'ping'])).ok) throw new Error(t`The Omarchy shell isn’t running, so the owl can’t go on the bar. Nothing was copied or removed. Start the shell with omarchy restart shell, then try again.`)
    const ours = this.receipt.pieces.owl
    const staging = join(dirname(this.plugin), `.${ID}.staging`)
    const previous = join(dirname(this.plugin), `.${ID}.previous`)
    await plainPath(staging); await plainPath(previous)
    if (ours?.pending) {
      const older = await treeDigest(previous)
      if (older !== null) {
        if (older !== ours.pending.previousHash) throw new Error(t`The previous owl folder changed. Sotto left it alone. Restore it before trying again.`)
        const current = await treeDigest(this.plugin)
        if (current !== null && !ownedHash(current, ours)) throw new Error(t`The owl was changed by hand. Sotto left it alone.`)
        await rm(this.plugin, { recursive: true, force: true })
        await rename(previous, this.plugin)
      }
      await rm(staging, { recursive: true, force: true }) // This pending record claimed an absent scratch folder before copying.
    }
    const leftovers = await readdir(dirname(this.plugin)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    if (leftovers.some(name => name === `.${ID}.staging` || name === `.${ID}.previous` || name.startsWith(`.${ID}.previous-`) || name.startsWith(`.${ID}.sotto-`))) {
      throw new Error(t`An earlier owl setup is still waiting. Your files were left alone. Restore or remove its temporary folder, then try again.`)
    }
    const before = await contents(this.shellConfig), hash = await treeDigest(this.plugin)
    if (hash !== null && !ownedHash(hash, ours)) throw new Error(t`The owl was changed by hand. Sotto left it alone.`)
    const source = join(this.options.resources, 'shell-plugin', ID)
    const bundledHash = removing ? null : await this.bundledHash('owl')
    const pendingOptions = ours?.pending?.owlOptions
    await this.savePending('owl', { hash: removing ? ours!.hash : bundledHash! }, hash, removing, { restart, ...(pendingOptions ? { owlOptions: pendingOptions } : {}) })
    let moved = false, placed = false
    try {
      if (removing) {
        await this.checked('omarchy', ['plugin', 'disable', ID], t`The shell could not take the owl off the bar. Nothing else was removed. Try again.`)
        await this.waitForBar(false)
      } else {
        await this.checked('omarchy', ['plugin', 'validate', source], t`Sotto’s owl did not pass Omarchy’s plugin check. Install Sotto again, then try again.`)
        await mkdir(join(this.options.home, '.config/omarchy/plugins'), { recursive: true })
        await cp(source, staging, { recursive: true, filter: path => !path.endsWith('.d.mts') })
      }
      if (hash !== null) { await rename(this.plugin, previous); moved = true }
      if (!removing) {
        await rename(staging, this.plugin); placed = true
        await this.checked('omarchy-shell', ['shell', 'rescanPlugins'], t`The shell could not find Sotto’s owl. Try again.`)
        let found = false
        for (let attempt = 0; attempt < 50; attempt++) {
          const result = await this.run('omarchy-shell', ['shell', 'listPlugins'])
          try { found = result.ok && pluginsSchema.parse(JSON.parse(result.stdout)).some(plugin => plugin.id === ID) } catch { found = false }
          if (found) break
          await wait(100)
        }
        if (!found) throw new Error(t`The shell did not pick up Sotto’s owl. Try again in your desktop session.`)
        const current = JSON.parse(await contents(this.shellConfig) ?? '{}') as {
          plugins?: Array<string | Record<string, unknown>>
          bar?: { layout?: Record<string, Array<string | Record<string, unknown>>> }
        }
        const service = current.plugins?.find(entry => typeof entry === 'object' && entry.id === ID)
        const missingBar = !await this.onBar()
        const savedOptions = typeof service === 'object' ? service : pendingOptions
        if (missingBar && current.plugins?.some(entry => entry === ID || typeof entry === 'object' && entry.id === ID)) {
          // Omarchy's put treats a top-level service as already enabled; move accepts only bar entries.
          if (savedOptions) await this.savePending('owl', { hash: bundledHash! }, hash, false, { restart, owlOptions: savedOptions })
          await this.checked('omarchy-shell', ['shell', 'reloadConfig'], t`The shell could not read its saved configuration. Try again.`)
          await this.checked('omarchy', ['plugin', 'disable', ID], t`The shell could not move Sotto’s owl from its service entry to the bar. Try again.`)
        }
        if (missingBar) await this.checked('omarchy', ['bar', 'put', ID, '--section', 'center', '--after', 'omarchy.indicators'], t`The shell could not put the owl on the bar. Try again.`)
        const barEntry = Object.values(current.bar?.layout ?? {}).flat().find(entry => typeof entry === 'object' && entry.id === ID)
        if (savedOptions && (missingBar || pendingOptions)) for (const [key, value] of Object.entries(savedOptions)) {
          // An interrupted transfer fills missing options; later saved values belong to the user.
          if (key !== 'id' && (missingBar || typeof barEntry !== 'object' || !(key in barEntry))) {
            await this.checked('omarchy', ['bar', 'set', ID, key, JSON.stringify(value), '--json'], t`The shell could not keep the owl’s saved options. Try again.`)
          }
        }
        await this.waitForBar(true)
        if (restart) await this.checked('omarchy', ['restart', 'shell'], t`The bar could not restart with the newer owl. Your previous owl was restored. Try again.`)
      }
    } catch (error) {
      try {
        if (placed) await rm(this.plugin, { recursive: true, force: true })
        if (moved) await rename(previous, this.plugin)
        await this.restoreOwlConfiguration(before)
        await this.run('omarchy-shell', ['shell', 'rescanPlugins'])
        await this.save('owl', ours)
      } catch { throw new Error(`${this.explain(error)} Sotto could not restore the bar. Restore shell.json and the previous owl folder before trying again.`) }
      throw error
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    await rm(previous, { recursive: true, force: true })
    await this.save('owl', removing ? undefined : { hash: bundledHash! })
    this.notes.owl = removing ? state('missing', t`The owl is off the bar and the floating widget is back.`)
      : state('done', restart ? t`Updated. The bar restarted with the newer owl.` : t`The owl is on the bar. The shell pill takes the floating widget’s place.`, true)
  }
  private async waitForBar(present: boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await this.onBar() === present) return
      await wait(100)
    }
    throw new Error(t`The shell did not save the owl’s place on the bar. Sotto restored the previous setup. Try again.`)
  }

  private async restoreOwlConfiguration(before: string | null): Promise<void> {
    const current = await contents(this.shellConfig)
    if (current === before) return
    if (current === null) return // A later deletion belongs to the user.
    const saved = before === null ? {} : objectSchema.parse(JSON.parse(before))
    const latest = objectSchema.parse(JSON.parse(current))
    const isOwl = (entry: unknown): boolean => entry === ID || typeof entry === 'object' && entry !== null && 'id' in entry && entry.id === ID
    const restoreEntries = (prior: unknown, now: unknown): unknown[] => {
      const result = Array.isArray(now) ? now.filter(entry => !isOwl(entry)) : []
      if (Array.isArray(prior)) prior.forEach((entry, index) => { if (isOwl(entry)) result.splice(Math.min(index, result.length), 0, entry) })
      return result
    }
    // The shell and the user can save other settings during a failed command.
    // Restore only Sotto's membership, retaining every unrelated field and entry.
    for (const key of ['plugins', 'disabledPlugins']) {
      if (key in latest || key in saved) latest[key] = restoreEntries(saved[key], latest[key])
    }
    const oldBar = objectSchema.safeParse(saved.bar), bar = objectSchema.safeParse(latest.bar)
    if (bar.success) {
      const oldLayout = objectSchema.safeParse(oldBar.success ? oldBar.data.layout : undefined)
      const layout = objectSchema.safeParse(bar.data.layout)
      if (layout.success) {
        for (const section of Object.keys(layout.data)) layout.data[section] = restoreEntries(oldLayout.success ? oldLayout.data[section] : undefined, layout.data[section])
        bar.data.layout = layout.data
      }
      latest.bar = bar.data
    }
    await atomicWrite(this.shellConfig, JSON.stringify(latest))
  }

  private async changeTheme(removing: boolean, refresh: boolean): Promise<void> {
    const original = await contents(this.template), rendered = await contents(this.rendered), ours = this.receipt.pieces.theme
    if (original !== null && !ownedHash(digest(original), ours)) throw new Error(t`The theme template was changed by hand. Sotto left it alone.`)
    const settings = await this.options.settings.get()
    const appearance = { appearance: settings.appearance, theme: settings.theme, lightTheme: settings.lightTheme, darkTheme: settings.darkTheme }
    const previous = ours?.appearance ?? appearance
    const nextReceipt = { hash: removing ? ours!.hash : await this.bundledHash('theme'), appearance: previous }
    const pending = await this.savePending('theme', nextReceipt, original === null ? null : digest(original), removing)
    try {
      if (removing) {
        // Only restore a half still following Omarchy; later choices belong to the user.
        await this.options.settings.update({ ...(settings.appearance === 'system' ? { appearance: previous.appearance } : {}), ...(settings.theme === 'system' ? { theme: previous.theme } : {}),
          ...(settings.lightTheme === OMARCHY_THEME_ID ? { lightTheme: previous.lightTheme } : {}),
          ...(settings.darkTheme === OMARCHY_THEME_ID ? { darkTheme: previous.darkTheme } : {}) })
        await plainPath(this.template); await plainPath(this.rendered)
        await this.checked('bash', [join(this.options.resources, 'install-theme.sh'), '--uninstall', '--operation', pending.pending!.token], t`Sotto could not remove the Omarchy theme. Finish any theme switch in progress, then try again. Your files and Appearance choices were restored.`)
        await this.save('theme')
      } else {
        await plainPath(this.template); await plainPath(this.rendered)
        await this.checked('bash', [join(this.options.resources, 'install-theme.sh'), '--operation', pending.pending!.token], t`Sotto could not render the Omarchy theme. Choose an Omarchy theme and finish any switch in progress, then try again.`)
        const colours = await contents(this.rendered)
        if (colours === null) throw new Error(t`Omarchy did not render Sotto’s colours. Choose another theme, then try again.`)
        try { parseOmarchyTheme(JSON.parse(colours), 'Omarchy') }
        catch { throw new Error(t`This Omarchy theme left Sotto’s colours unreadable. Choose another theme, then try again.`) }
        if (!refresh) await this.options.settings.update({ appearance: 'system', theme: 'system', lightTheme: OMARCHY_THEME_ID, darkTheme: OMARCHY_THEME_ID })
        await this.save('theme', nextReceipt)
      }
    } catch (error) {
      try {
        if (original === null) await rm(this.template, { force: true }); else await atomicWrite(this.template, original)
        if (rendered === null) await rm(this.rendered, { force: true }); else await atomicWrite(this.rendered, rendered)
        await this.options.settings.update(appearance)
        await this.save('theme', ours)
      } catch { throw new Error(`${this.explain(error)} Sotto could not restore the theme. Choose your previous themes in Settings › Appearance.`) }
      throw error
    }
    this.notes.theme = removing ? state('missing', t`Sotto wears the theme it had before.`) : state('done', t`Sotto follows the Omarchy theme.`, true)
  }
}
