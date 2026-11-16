import { relative, sep } from 'node:path'
import { z } from 'zod'
import { dollarFigure, MAKE_SOUND_TOOL, PLUGIN_ACCOUNT_NAME_MAX, PLUGIN_ACCOUNTS_TOOL, type PluginAccount } from '../../../shared/plugins'
import type { ThreadToolDefinition } from '../../agents/threadToolServer'
import { EFFECT_SECONDS_MAX, EFFECT_SECONDS_MIN, MUSIC_SECONDS_MAX, MUSIC_SECONDS_MIN, SOUND_KINDS, SOUND_WORDS_MAX, SPEECH_CHARACTERS_MAX, type ElevenLabsProblem, type ElevenLabsVoice } from '../../tools/elevenlabs/api'
import type { SoundFailure, SoundRecord } from '../../tools/elevenlabs/records'
import { SOUND_FOLDER } from '../../tools/elevenlabs/save'
import type { SoundRequest } from '../../tools/elevenlabs/service'

/**
 * `make_sound` (ADR-0205; the plugins plan's slice 12, part 2): one sound with an ElevenLabs account the user added,
 * speech, a sound effect or music (Zach's pick on #2498), saved as an MP3 in a folder inside the thread's folder. The
 * tool's words for the agent and its input are here; `pluginTools.ts` runs it, the way it runs `make_3d_model`.
 */

/** A sound's name, which its file is named after. */
export const SOUND_NAME_MAX = 80
const FOLDER_MAX = 260
const VOICE_NAME_MAX = 200
/** How many of the account's voices an agent is told of when it names one the account does not have. */
export const VOICES_LISTED = 20

export const makeSoundInputSchema = z.object({
  kind: z.enum(SOUND_KINDS).describe('What to make: "speech" speaks your words in one of the account\'s voices, "effect" makes a sound effect, and "music" makes music.'),
  name: z.string().trim().min(1).max(SOUND_NAME_MAX).describe('A short name for the sound, such as "Welcome video". Its file is named after it.'),
  words: z.string().trim().min(1).max(SPEECH_CHARACTERS_MAX).describe(`For speech, the text to speak, up to ${SPEECH_CHARACTERS_MAX.toLocaleString('en-US')} characters. For an effect or music, what it should sound like, up to ${SOUND_WORDS_MAX.toLocaleString('en-US')} characters.`),
  voice: z.string().trim().min(1).max(VOICE_NAME_MAX).optional().describe('For speech only: the name of one of the account\'s voices, such as "Rachel". The account\'s first voice when left out.'),
  seconds: z.number().min(EFFECT_SECONDS_MIN).max(MUSIC_SECONDS_MAX).optional().describe(`For an effect, ${EFFECT_SECONDS_MIN} to ${EFFECT_SECONDS_MAX} seconds, or leave it out for ElevenLabs to judge. For music, ${MUSIC_SECONDS_MIN} to ${MUSIC_SECONDS_MAX}, which it needs. Not for speech.`),
  instrumental: z.boolean().optional().describe('For music only: true for music with no singing. False when left out.'),
  account: z.string().trim().min(1).max(PLUGIN_ACCOUNT_NAME_MAX).optional().describe(`The ElevenLabs account's name as ${PLUGIN_ACCOUNTS_TOOL} lists it. Leave it out when there is one account.`),
  folder: z.string().trim().min(1).max(FOLDER_MAX).optional().describe(`A folder inside the thread's folder for the file, relative to it. "${SOUND_FOLDER}" when left out.`),
}).strict()
export type MakeSoundInput = z.infer<typeof makeSoundInputSchema>

/** What making a sound asks of Sotto. A computer whose threads cannot make one has none. */
export interface PluginElevenLabsHandlers {
  /** The thread's working folder on this computer, or null when Sotto cannot find one. */
  folderOf(threadId: string): Promise<string | null>
  /** What the account's sounds cost this month, in US dollars at ElevenLabs' published prices. */
  monthSpent(accountId: string): Promise<number>
  /** Why the account's key cannot be read for a call, or null when it can: said before the user is asked. */
  keyTrouble(account: PluginAccount): 'locked' | 'no-secret' | null
  /** The account's voices, by name. Throws an `ElevenLabsApiError` or a `SoundAccountError`; nothing is made. */
  voices(accountId: string): Promise<readonly ElevenLabsVoice[]>
  /** Starts one sound the user allowed, its record kept, counting its cost, before anything is sent. */
  make(request: SoundRequest): Promise<{ readonly sound: SoundRecord; readonly done: Promise<SoundRecord | undefined> }>
}

export const NOTHING_SOUNDED = 'Nothing was sent to ElevenLabs, and nothing was counted.'
/** Said of a sound ElevenLabs was asked for and did not make, or Sotto did not save. */
const NOTHING_SAVED = 'Nothing was saved, and nothing was counted against this month\'s limit.'

export const makeSoundDefinition: ThreadToolDefinition = {
  name: MAKE_SOUND_TOOL,
  description: [
    'Make a sound with an ElevenLabs account the user added: speech in one of the account\'s voices, a sound effect, or music. It is saved as one MP3 in a folder inside the thread\'s folder.',
    'It costs the user money on their ElevenLabs account, and ElevenLabs may use what is sent to train its own models.',
    'Unless the user turned off asking for the account, they are shown everything that goes to ElevenLabs and what it costs on a card, and it is made only if they allow it; the call waits up to five minutes for their answer.',
    'It is refused before anything is sent when it would pass the account\'s monthly limit.',
    'Nothing plays aloud: the call answers with the file\'s path in the thread\'s folder and what it cost, and the user plays it when they choose.',
  ].join(' '),
  inputSchema: z.toJSONSchema(makeSoundInputSchema, { io: 'input' }) as Record<string, unknown>,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}

/** What to tell an agent of a sound's input that the schema alone does not catch, or null when it may be made. */
export function soundInputProblem(input: MakeSoundInput): string | null {
  const { kind, words, voice, seconds, instrumental } = input
  if (kind === 'speech') {
    if (seconds !== undefined || instrumental !== undefined) return `Speech takes no "seconds" or "instrumental": it is as long as its words. ${NOTHING_SOUNDED}`
    return null
  }
  if (voice !== undefined) return `Only speech takes a "voice". ${NOTHING_SOUNDED}`
  if (words.length > SOUND_WORDS_MAX) return `The words for ${kind === 'effect' ? 'a sound effect' : 'music'} are at most ${SOUND_WORDS_MAX.toLocaleString('en-US')} characters. ${NOTHING_SOUNDED}`
  if (kind === 'effect') {
    if (instrumental !== undefined) return `Only music takes "instrumental". ${NOTHING_SOUNDED}`
    if (seconds !== undefined && (seconds < EFFECT_SECONDS_MIN || seconds > EFFECT_SECONDS_MAX)) return `A sound effect is ${EFFECT_SECONDS_MIN} to ${EFFECT_SECONDS_MAX} seconds long, or leave "seconds" out for ElevenLabs to judge. ${NOTHING_SOUNDED}`
    return null
  }
  if (seconds === undefined || seconds < MUSIC_SECONDS_MIN || seconds > MUSIC_SECONDS_MAX) return `Music needs "seconds", from ${MUSIC_SECONDS_MIN} to ${MUSIC_SECONDS_MAX}. ${NOTHING_SOUNDED}`
  return null
}

/**
 * The voice speech is spoken in: the one whose name is the one asked for, whatever its case, or the account's first
 * when none is asked for (Zach's pick on #2498). A name the account does not have is told with up to 20 that it does.
 */
export function pickVoice(voices: readonly ElevenLabsVoice[], asked: string | undefined): ElevenLabsVoice | string {
  if (voices.length === 0) return `The ElevenLabs account has no voices to speak in. Ask the user to add one in their ElevenLabs account. ${NOTHING_SOUNDED}`
  if (asked === undefined) return voices[0]!
  const wanted = asked.toLocaleLowerCase('en-US')
  const found = voices.find(voice => voice.name.toLocaleLowerCase('en-US') === wanted)
  if (found) return found
  const names = voices.slice(0, VOICES_LISTED).map(voice => `"${voice.name}"`).join(', ')
  const more = voices.length > VOICES_LISTED ? `, and ${voices.length - VOICES_LISTED} more` : ''
  return `The ElevenLabs account has no voice called "${asked}". Its voices: ${names}${more}. Give "voice" as one of them, or leave it out for the first. ${NOTHING_SOUNDED}`
}

/** A sum in dollars, for the agent. */
export const dollarWords = (amount: number): string => dollarFigure(amount) ?? 'under $0.01'
/** An estimate in dollars, for the agent: "about $0.03", or "under $0.01". */
export const aboutDollars = (amount: number): string => { const figure = dollarFigure(amount); return figure ? `about ${figure}` : 'under $0.01' }

/** What to tell an agent when the account's voices could not be read. Nothing was sent: a read of voices makes nothing. */
export function voicesWords(problem: ElevenLabsProblem | 'no-account' | 'locked'): string {
  const reason = problem === 'refused' ? 'ElevenLabs did not accept the account\'s key. Ask the user to replace it in Settings > Plugins.'
    : problem === 'busy' ? 'ElevenLabs is turning requests away for now. Try again in a few minutes.'
      : problem === 'no-account' ? 'The ElevenLabs account was removed.'
        : problem === 'locked' ? 'Sotto could not read the account\'s key, because this computer\'s credential store is locked. Ask the user to unlock it, then try again.'
          : 'ElevenLabs could not be reached, or gave an answer Sotto could not read. Try again.'
  return `Sotto could not read the ElevenLabs account's voices. ${reason} ${NOTHING_SOUNDED}`
}

/** What to tell an agent of a sound ElevenLabs was asked for that did not end in a saved MP3. */
export function soundFailedWords(failure: SoundFailure | undefined, kind: SoundRecord['kind']): string {
  switch (failure) {
    case 'refused': return `ElevenLabs did not accept the account's key, or the key may not do this. Ask the user to replace it in Settings > Plugins. ${NOTHING_SAVED}`
    case 'no-credits': return `The ElevenLabs account has no credits left for this. Tell the user. ${NOTHING_SAVED}`
    case 'rejected': return `ElevenLabs would not make this ${kind === 'speech' ? 'speech from these words in this voice' : kind === 'effect' ? 'sound effect from these words' : 'music from these words'}. ${NOTHING_SAVED}`
    case 'busy': return `ElevenLabs is turning requests away for now. ${NOTHING_SAVED} Call ${MAKE_SOUND_TOOL} again in a few minutes if it is still wanted.`
    case 'unreadable': return `ElevenLabs gave an answer Sotto could not read. ${NOTHING_SAVED}`
    case 'folder': return `The folder would not take the file: it is not inside the thread's folder, or could not be written. ${NOTHING_SAVED}`
    case 'too-large': return `The sound ElevenLabs sent back was larger than Sotto takes. ${NOTHING_SAVED}`
    case 'no-account': return `The ElevenLabs account was removed before the sound was made. ${NOTHING_SAVED}`
    case 'locked': return `Sotto could not read the ElevenLabs account's key, because this computer's credential store is locked. Ask the user to unlock it, then try again. ${NOTHING_SAVED}`
    case 'stopped': return 'Sotto stopped while the sound was being made, so it cannot tell whether ElevenLabs made it. Nothing was saved, and its cost stays counted. Do not ask for it again now; tell the user.'
    default: return `ElevenLabs could not be reached, or stopped before the whole sound came back. ${NOTHING_SAVED}`
  }
}

/**
 * Why a sound ElevenLabs made and charged for was not saved, and that its cost is counted: the answer cut off, too
 * large, or a folder that would not take it (Bug Bot on #2648, L1).
 */
export function soundUnsavedWords(failure: SoundFailure | undefined, cost: string): string {
  const why = failure === 'folder' ? 'the folder would not take the file: it is not inside the thread\'s folder, or could not be written'
    : failure === 'too-large' ? 'it was larger than Sotto saves'
      : 'its answer stopped before the whole file arrived'
  return `ElevenLabs made it and charged for it, but ${why}. Nothing was saved. Its cost, ${cost}, is counted against this month's limit. Tell the user before asking for it again.`
}

/** A saved sound's file, as a path relative to the thread's folder. */
export function soundPath(root: string, sound: SoundRecord): string {
  const folder = relative(root, sound.folder)
  const fileName = sound.fileName ?? ''
  return (folder ? `${folder}${sep}${fileName}` : fileName).split(sep).join('/')
}
