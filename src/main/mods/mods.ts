import { t } from '@lingui/core/macro'
import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, open, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defaultNewThreadModelId, type AgentCommand, type AgentState } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import { modelInForce } from '../../shared/modelLineup'
import { MOD_PARTS } from '../../shared/modParts'
import {
  MOD_CSS_BYTES_MAX, MOD_ID_PATTERN, MOD_LIMIT, MOD_LOOK_FILE, MOD_MANIFEST_FILE, modLookReachesOutside, modManifestSchema,
  type ModListed, type ModsList,
} from '../../shared/mods'

/** The mods folder's name in Sotto's data folder (ADR-0217). */
export const MODS_FOLDER = 'mods'
/** The project Make a mod's threads go in, at the mods folder. */
export const MODS_PROJECT_TITLE = 'Mods'
/** How long the watch waits for a burst of file changes to settle before it reads the folder again. */
const SETTLE_MS = 150
/** The most of a `mod.json` read. */
const MANIFEST_BYTES_MAX = 8 * 1024

export const modsFolder = (userDataPath: string): string => resolve(join(userDataPath, MODS_FOLDER))

/** Reads at most `limit` bytes of a file as UTF-8, and says whether the file was longer. Missing files read as null. */
async function readCapped(path: string, limit: number): Promise<{ text: string; longer: boolean } | null> {
  let handle
  try { handle = await open(path, 'r') } catch { return null }
  try {
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0)
    return { text: buffer.subarray(0, Math.min(bytesRead, limit)).toString('utf8'), longer: bytesRead > limit }
  } catch {
    // A folder by that name opens on Linux and fails on the read: it is no file, so the mod reads as unreadable alone.
    return null
  } finally { await handle.close().catch(() => undefined) }
}

/** One mod's folder, read and checked. A mod that cannot be read is still listed, with why, and paints nothing. */
export async function readMod(folder: string, id: string): Promise<ModListed> {
  const manifestFile = await readCapped(join(folder, id, MOD_MANIFEST_FILE), MANIFEST_BYTES_MAX)
  let manifest: ReturnType<typeof modManifestSchema.safeParse> | null = null
  if (manifestFile && !manifestFile.longer) {
    try { manifest = modManifestSchema.safeParse(JSON.parse(manifestFile.text.replace(/^\uFEFF/, ''))) } catch { manifest = null }
  }
  const lookFile = await readCapped(join(folder, id, MOD_LOOK_FILE), MOD_CSS_BYTES_MAX)
  const look = lookFile?.text ?? ''
  const named = manifest?.success ? manifest.data : null
  const problem = named === null ? 'manifest' as const
    : lookFile?.longer ? 'too-large' as const
      : modLookReachesOutside(look) ? 'outside' as const
        : undefined
  return {
    id,
    name: named?.name ?? id,
    ...(named?.description ? { description: named.description } : {}),
    look: lookFile?.longer ? '' : look,
    ...(problem ? { problem } : {}),
  }
}

/** Every mod in the folder, by id, at most `MOD_LIMIT`. A missing folder has none. */
export async function readMods(folder: string): Promise<ModsList> {
  let entries
  try { entries = await readdir(folder, { withFileTypes: true }) } catch { return { mods: [] } }
  const ids = entries.filter(entry => entry.isDirectory() && MOD_ID_PATTERN.test(entry.name)).map(entry => entry.name).sort().slice(0, MOD_LIMIT)
  return { mods: await Promise.all(ids.map(id => readMod(folder, id))) }
}

/**
 * The guide Sotto keeps in the mods folder as AGENTS.md and CLAUDE.md, so the agent of any provider learns how a mod is
 * laid out from its working folder. It is written again each time a mod is made, so it follows Sotto's part names.
 */
export function modsGuide(): string {
  const parts = MOD_PARTS.map(part => `- \`[data-part="${part.name}"]\`: ${part.says}`).join('\n')
  return `# Sotto mods

This folder holds the user's mods for Sotto, the desktop app this thread runs in. A mod changes how Sotto's main window
looks. Sotto watches this folder and repaints the window as soon as a mod's files change, so the user sees each edit.
Sotto writes this file and rewrites it; don't edit it.

## A mod

Make one folder per mod, named with lowercase letters, digits and dashes, such as \`oak-sidebar\`. It holds:

- \`mod.json\`: \`{ "name": "Oak sidebar", "description": "A warm wood look for the sidebar." }\`. The name shows on
  Settings › Mods. Keep it short and say what the mod does.
- \`look.css\`: CSS painted over the main window after Sotto's own stylesheets.

To change a mod the user names, edit that mod's files. To make a new one, make a new folder; don't fold it into another
mod, since each mod has its own switch.

## What to target

Target these part names. They stay the same across Sotto's updates. Class names change without notice, so a mod that
uses them breaks.

${parts}

Sotto's colours come from the user's theme as CSS variables. Use them where a mod should follow the theme, light and
dark: \`--tt-canvas\`, \`--tt-surface\`, \`--tt-card\`, \`--tt-card-inset\`, \`--tt-field\`, \`--tt-sidebar\`,
\`--tt-text\`, \`--tt-text-2\`, \`--tt-text-muted\`, \`--tt-accent\`, \`--tt-accent-text\`, \`--tt-hairline\`,
\`--tt-danger\`, \`--tt-success\`. Fonts are \`--tt-font-ui\` and \`--tt-font-mono\`; corners \`--tt-radius-control\` and
\`--tt-radius-card\`.

A mod's rules come after Sotto's, so they win a tie. Where Sotto's own rule is more specific, add \`!important\`.

## What a look cannot do

Sotto refuses a whole look, and paints none of it, if it loads anything: no \`@import\`, no \`image-set()\`, no
\`src()\`, and no \`url()\` other than a \`data:\` address or a \`#fragment\`. Put a picture in as a \`data:\` address.
The window cannot reach the internet anyway.

A look only restyles what is there. It cannot add a pane, a band or a button yet, and it cannot change what Sotto sends
to an agent or answer anything for the user.

## If something goes wrong

The user can switch any mod off on Settings › Mods, and Ctrl+Alt+Shift+M (Cmd+Option+Shift+M on a Mac) switches every
mod off even when a look has hidden Sotto's controls. Tell the user that when a mod hides or moves something.
`
}

/** Makes the mods folder and writes the guide into it. */
export async function prepareModsFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true })
  const guide = modsGuide()
  await Promise.all([writeFile(join(folder, 'AGENTS.md'), guide, 'utf8'), writeFile(join(folder, 'CLAUDE.md'), guide, 'utf8')])
}

/**
 * Watches the mods folder and calls `changed` once a burst of changes settles. The folder is made first, so a watch
 * always has something to watch. Closing stops the watch and any read still waiting.
 */
export async function watchMods(folder: string, changed: () => void): Promise<() => void> {
  await mkdir(folder, { recursive: true })
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null
  const settle = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; changed() }, SETTLE_MS)
  }
  try {
    watcher = watch(folder, { recursive: true }, settle)
    watcher.on('error', () => undefined)
  } catch { watcher = null }
  return () => {
    if (timer !== null) clearTimeout(timer)
    watcher?.close()
  }
}

/** What Make a mod needs of the coordinator: its shell and its commands. */
export interface ModsCoordinator {
  shell(): AgentState
  command(command: AgentCommand): Promise<unknown>
}

const sameFolder = (left: string, right: string): boolean =>
  process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)

/**
 * Make a mod: a thread in the Mods project, at the mods folder, on the user's default model for new threads, whose
 * first message is the user's own words. The guide in the folder tells its agent the rest, so the words are sent as
 * written. The thread is an ordinary one, sharing the folder and asking as its permission mode says. Returns its ID.
 */
export async function startModThread(coordinator: ModsCoordinator, folder: string, words: string): Promise<string> {
  await prepareModsFolder(folder)
  const state = coordinator.shell()
  const models = state.host.models.filter(model => model.ready)
  const model = resolveModel(models, modelInForce(models, defaultNewThreadModelId(state.configuration, models, state.reasoningAccounts)))
  if (!model) throw new Error(t`No model is ready to make a mod. Connect a provider in Settings › Providers first.`)
  const project = (from: AgentState) => from.host.projects.find(item => sameFolder(item.path, folder) && (!item.providerId || !model.providerId || item.providerId === model.providerId))
  let home = project(state)
  if (!home) {
    await coordinator.command({ type: 'create-project', ...(model.providerId ? { provider: model.providerId } : {}), title: MODS_PROJECT_TITLE, path: folder, useExisting: true })
    home = project(coordinator.shell())
  }
  if (!home) throw new Error(t`The Mods project could not be made. Nothing was started. Try again.`)
  const threadId = randomUUID()
  await coordinator.command({ type: 'create-thread', threadId, projectId: home.id, title: 'Make a mod', titleSource: 'default', modelId: model.id, workingCopy: 'shared' })
  await coordinator.command({ type: 'manual-send', threadId, text: words })
  return threadId
}
