import { t } from '@lingui/core/macro'
import { join } from 'node:path'
import { z } from 'zod'
import {
  MODS_CHANGED, MODS_LIST, MODS_MAKE, MODS_OPEN_FOLDER, MODS_REMOVE, MODS_REVEAL, modIdRequestSchema, modMakeRequestSchema, modMakeResultSchema,
  modsListSchema, type ModMakeResult,
} from '../../shared/mods'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import { prepareModsFolder, readMods, startModThread, watchMods, type ModsCoordinator } from './mods'

/** Argument tuple schemas built once at module scope (`zodSchemaSites.test.ts`). */
const makeArguments = z.tuple([modMakeRequestSchema])
const idArguments = z.tuple([modIdRequestSchema])

export interface ModsIpcOptions {
  readonly folder: string
  readonly coordinator: ModsCoordinator
  readonly senders: () => readonly TrustedIpcSender[]
  readonly send: (channel: string, payload: unknown) => void
  /** The window's ID for a thread on this computer. */
  readonly windowId: (threadId: string) => string
  readonly openPath: (path: string) => Promise<string>
  readonly reveal: (path: string) => void
  readonly trash?: ((path: string) => Promise<void>) | undefined
}

/**
 * Settings › Mods' channels and the mods folder's watch (ADR-0217). Registered only while the `mods` Owl feature is on;
 * off, nothing is registered and nothing reads or watches the folder.
 */
export function registerModsIpc(ipc: IpcMainAdapter, enabled: boolean, options: ModsIpcOptions): () => void {
  if (!enabled) return () => undefined
  const { folder } = options
  const fromMain = (event: Parameters<Parameters<IpcMainAdapter['handle']>[1]>[0]): void => {
    if (!isAuthorizedIpcSender(event, options.senders(), ['main'])) throw new Error(t`Open Settings › Mods in the main Sotto window.`)
  }

  ipc.handle(MODS_LIST, async event => {
    fromMain(event)
    return modsListSchema.parse(await readMods(folder))
  })
  ipc.handle(MODS_MAKE, async (event, ...args) => {
    fromMain(event)
    const [request] = makeArguments.parse(args)
    let result: ModMakeResult
    try { result = { threadId: options.windowId(await startModThread(options.coordinator, folder, request.words)) } }
    catch (failure) { result = { error: failure instanceof Error && failure.message ? failure.message : t`The thread could not start. Nothing was started. Try again.` } }
    return modMakeResultSchema.parse(result)
  })
  ipc.handle(MODS_OPEN_FOLDER, async event => {
    fromMain(event)
    // The guide goes in first, so someone writing a mod by hand finds it there.
    await prepareModsFolder(folder)
    if (await options.openPath(folder)) throw new Error(t`The mods folder could not be opened.`)
  })
  ipc.handle(MODS_REVEAL, async (event, ...args) => {
    fromMain(event)
    const [request] = idArguments.parse(args)
    options.reveal(join(folder, request.id))
  })
  ipc.handle(MODS_REMOVE, async (event, ...args) => {
    fromMain(event)
    const [request] = idArguments.parse(args)
    if (!options.trash) return false
    try { await options.trash(join(folder, request.id)); return true } catch { return false }
  })

  let closed = false
  let stopWatch: (() => void) | null = null
  const sendList = (): void => {
    void readMods(folder).then(list => { if (!closed) options.send(MODS_CHANGED, modsListSchema.parse(list)) }, () => undefined)
  }
  void watchMods(folder, sendList).then(stop => { if (closed) stop(); else stopWatch = stop }, () => undefined)

  return () => {
    closed = true
    stopWatch?.()
    for (const channel of [MODS_LIST, MODS_MAKE, MODS_OPEN_FOLDER, MODS_REVEAL, MODS_REMOVE]) ipc.removeHandler(channel)
  }
}
