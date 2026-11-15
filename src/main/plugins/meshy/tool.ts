import { isAbsolute, relative, sep } from 'node:path'
import { z } from 'zod'
import { MAKE_3D_MODEL_TOOL, PLUGIN_ACCOUNT_NAME_MAX, PLUGIN_ACCOUNTS_TOOL, type PluginAccount } from '../../../shared/plugins'
import type { ThreadToolDefinition } from '../../agents/threadToolServer'
import { MESHY_TRIANGLES_MAX, MESHY_TRIANGLES_MIN, MESHY_WORDS_MAX } from '../../tools/meshy/api'
import { PHOTO_PIXELS_MAX, PHOTO_SIDE_MAX, type CheckedPhoto, type PhotoProblem } from '../../tools/meshy/photo'
import type { ThreeDModel } from '../../tools/meshy/records'
import { MESHY_CREDITS, MODEL_FOLDER, type ModelRequest } from '../../tools/meshy/service'

/**
 * `make_3d_model` (ADR-0141; the Meshy plan's ticket 3): one 3D model with a Meshy account the user added, from words
 * the agent writes or a photo in the thread's folder, into a folder inside it. The tool's words for the agent and its
 * input are here; `pluginTools.ts` runs it.
 */

/** What a 3D model costs when it is asked for: a shape and a texture from words, or one textured task from a photo. */
export const MODEL_COST = { words: MESHY_CREDITS.preview + MESHY_CREDITS.refine, photo: MESHY_CREDITS.photo } as const
/** A 3D model's name, which its files are named after. */
export const MODEL_NAME_MAX = 80
const FOLDER_MAX = 260
const PHOTO_PATH_MAX = 1_000

export const makeModelInputSchema = z.object({
  account: z.string().trim().min(1).max(PLUGIN_ACCOUNT_NAME_MAX).optional().describe(`The Meshy account's name as ${PLUGIN_ACCOUNTS_TOOL} lists it. Leave it out when there is one account.`),
  name: z.string().trim().min(1).max(MODEL_NAME_MAX).describe('A short name for the 3D model, such as "Oak barrel". Its files are named after it.'),
  words: z.string().trim().min(1).max(MESHY_WORDS_MAX).optional().describe(`What to make, in up to ${MESHY_WORDS_MAX} characters: the object, its shape, material and style. Give this or "photo", not both.`),
  photo: z.string().min(1).max(PHOTO_PATH_MAX).optional().describe('A photo to make it from: the path of a JPEG or PNG of up to 20 MB inside the thread\'s folder, relative to it. Give this or "words", not both.'),
  folder: z.string().trim().min(1).max(FOLDER_MAX).optional().describe(`A folder inside the thread's folder for the files, relative to it. "${MODEL_FOLDER}" when left out.`),
  formats: z.array(z.literal('stl')).max(1).optional().describe('Formats beyond GLB and USDZ, which are always made: ["stl"] for an STL too.'),
  triangles: z.number().int().min(MESHY_TRIANGLES_MIN).max(MESHY_TRIANGLES_MAX).optional().describe(`About how many triangles the model should have, from ${MESHY_TRIANGLES_MIN} to ${MESHY_TRIANGLES_MAX.toLocaleString('en-US')}. Meshy picks when left out.`),
}).strict()
export type MakeModelInput = z.infer<typeof makeModelInputSchema>

/** What making a 3D model asks of Sotto. A computer whose threads cannot make one has none. */
export interface PluginMeshyHandlers {
  /** The thread's working folder on this computer, or null when Sotto cannot find one. */
  folderOf(threadId: string): Promise<string | null>
  /**
   * The credits the account's 3D models took this month, against its one monthly limit. `waiting`: a host has not yet
   * heard from the copy's desktop what the account spent. `unreadable`: what other computers said cannot be read, or
   * was not written down. Either way nothing may be spent.
   */
  monthCredits(accountId: string): Promise<number | 'waiting' | 'unreadable'>
  /** Why the account's key cannot be read for a call, or null when it can: said before the user is asked. */
  keyTrouble(account: PluginAccount): 'locked' | 'no-secret' | null
  /** The photo at a path in the thread's folder as it is now, or why it is not sent. */
  checkPhoto(root: string, path: string): Promise<CheckedPhoto | PhotoProblem>
  /** The photo once more right before it goes, redrawn without its location and camera details, as a data address. */
  photoToSend(root: string, checked: CheckedPhoto, path: string): Promise<{ readonly photo: string } | PhotoProblem>
  /** Starts one 3D model the user allowed. */
  make(request: ModelRequest): Promise<{ readonly model: ThreeDModel; readonly done: Promise<ThreeDModel | undefined> }>
  /**
   * Places a 3D model that was started in its thread, as its line (the Meshy plan's ticket 4). False when it could not
   * be placed, as with the thread's history unavailable; the 3D model is made all the same. Never rejects.
   */
  showInThread(threadId: string, model: ThreeDModel): Promise<boolean>
}

export const NOTHING_MADE = 'Nothing was sent to Meshy and nothing was charged.'

export const makeModelDefinition: ThreadToolDefinition = {
  name: MAKE_3D_MODEL_TOOL,
  description: `Make a 3D model with a Meshy account the user added, from words you write or a photo in the thread's folder, and save it as GLB and USDZ files, with a still picture, in a folder inside the thread's folder. It costs the user about ${MODEL_COST.words} Meshy credits, and Meshy may use what is sent to train its own models. Unless the user turned off asking for the account, they are shown what goes to Meshy and what it costs on a card, and it is made only if they allow it; the call waits up to five minutes for their answer. It is refused before anything is sent when it would pass the account's monthly credit limit. Making one takes a few minutes; the call waits for it while its client does, and answers with the files' paths.`,
  inputSchema: z.toJSONSchema(makeModelInputSchema, { io: 'input' }) as Record<string, unknown>,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}

/** Why a folder named for the files is not one inside the thread's folder, by its name alone. */
export function folderProblem(folder: string): boolean {
  return isAbsolute(folder) || folder.includes('\0') || folder.split(/[\\/]/u).includes('..')
}

/** What to tell an agent of a photo that is not sent. */
export function photoWords(problem: PhotoProblem, path: string): string {
  switch (problem) {
    case 'outside': return `The photo "${path}" is not inside the thread's folder. Only a photo in the thread's folder can be sent. ${NOTHING_MADE}`
    case 'missing': return `There is no photo at "${path}" in the thread's folder. ${NOTHING_MADE}`
    case 'kind': return `"${path}" is not a JPEG or PNG photo. ${NOTHING_MADE}`
    case 'too-large': return `The photo "${path}" is larger than Meshy's 20 MB. ${NOTHING_MADE}`
    case 'too-many-pixels': return `The photo "${path}" has more pixels than Sotto draws again: at most ${PHOTO_SIDE_MAX.toLocaleString('en-US')} on a side and ${(PHOTO_PIXELS_MAX / 1_000_000).toLocaleString('en-US')} million in all. Use a smaller copy of it. ${NOTHING_MADE}`
    case 'changed': return `The photo "${path}" changed or moved after it was asked for, so it was not sent. ${NOTHING_MADE} Ask again with the photo as it is now; the user will be asked again.`
    default: return `Sotto could not read the photo "${path}". ${NOTHING_MADE}`
  }
}

/** The files of a finished 3D model, as paths relative to the thread's folder. */
export function modelPaths(root: string, model: ThreeDModel): string[] {
  const folder = relative(root, model.folder)
  return model.files.map(file => (folder ? `${folder}${sep}${file}` : file).split(sep).join('/'))
}

/** What to tell an agent of a 3D model that ended without being made. */
export function endedWords(model: ThreeDModel): string {
  const credits = model.credits === 0 ? 'Nothing was charged.' : `${model.credits} credits were counted for it.`
  switch (model.failure) {
    case 'refused': return `Meshy did not accept the Meshy account's key. Ask the user to replace it in Settings > Plugins. ${credits}`
    case 'no-credits': return `The Meshy account has no credits left, or its plan has no API access. Tell the user. ${credits}`
    case 'rejected': return `Meshy would not make a 3D model from this${model.source.kind === 'photo' ? ' photo' : ''}. ${credits}`
    case 'failed': return `Meshy could not finish the 3D model, and gave back the credits of what it could not make. ${credits}`
    case 'too-large': return `A file Meshy made was larger than Sotto takes, so it was not saved. ${credits}`
    case 'folder': return `The folder would not take the files: it is not inside the thread's folder, or could not be written. ${credits}`
    case 'no-account': return `The Meshy account was removed before the 3D model was made. ${credits}`
    case 'locked': return `Sotto could not read the Meshy account's key, because this computer's credential store is locked. Ask the user to unlock it, then try again. ${credits}`
    case 'expired': return `Meshy no longer has the 3D model, so its files could not be fetched. ${credits}`
    default: return `Sotto could not tell whether Meshy took the request. Do not ask again for this one; tell the user. ${credits}`
  }
}
