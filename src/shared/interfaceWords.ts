import { plural, t } from '@lingui/core/macro'

import { HOST_CANNOT_STAGE_SCREENSHOTS, PROVIDER_CONNECTION_NOTICES, PROVIDER_LABELS, SCREENSHOT_NOT_ITS_TYPE, SCREENSHOT_TOO_LARGE, SCREENSHOT_WRONG_TYPE, SCREENSHOTS_TOO_LARGE_IN_TOTAL, type ProviderId } from './agents'
import type { BootUnsupportedReason } from './bootStart'
import type { TranscriptionErrorCode } from './dictation'
import type { OwnServerRefusal } from './ownModelServers'
import { HOST_BUSY, hostIsNewer, hostIsOlder, LEGACY_MANAGEMENT_UPDATE, MANAGEMENT_REMOVED } from './hostProtocol'
import type { HostProviderJobCase } from './hostProviders'
import type { EffortColor, GitMergeMethod } from './settings'
import { THREAD_STARTS_UNSUPPORTED } from './threadStarts'
import type { WorkerRoleId } from './workerRoles'

/**
 * The words shared modules keep in English, as the desktop shows them in the interface language (ADR-0123).
 *
 * The modules that hold the English (`agents.ts`, `settings.ts`, `dictation.ts` and the rest) are also built into the
 * headless host and the preload scripts, which have no Lingui macro transform and no interface language: the host sends
 * its words in English, and some of these sentences are compared by value, kept as thread titles or read by a model. So
 * the English stays where it is, and this module, which only main and the windows import, says the same words as
 * messages. Never import it from a module the host or a preload script builds. `interfaceWords.test.ts` holds each
 * message to its English twin, so the two never drift apart.
 */

/** An effort colourway's name, as Settings > Appearance lists it (`EFFORT_COLOR_LABELS`). */
export function effortColorLabel(color: EffortColor): string {
  switch (color) {
    case 'ember': return t({ message: 'Ember', comment: 'The name of an effort colourway: the colour a thread’s effort control turns at the highest level.' })
    case 'cyberpunk': return t({ message: 'Cyberpunk', comment: 'The name of an effort colourway.' })
    case 'rainbow': return t({ message: 'Rainbow', comment: 'The name of an effort colourway.' })
    case 'aurora': return t({ message: 'Aurora', comment: 'The name of an effort colourway.' })
    case 'plasma': return t({ message: 'Plasma', comment: 'The name of an effort colourway.' })
    case 'accent': return t({ message: 'Theme accent', comment: 'The name of an effort colourway that takes the theme’s accent colour.' })
  }
}

/** How a pull request is merged, as Settings and the merge control name it (`GIT_MERGE_METHOD_LABELS`). */
export function gitMergeMethodLabel(method: GitMergeMethod): string {
  switch (method) {
    case 'merge': return t({ message: 'Merge', context: 'merge method', comment: 'GitHub’s “Create a merge commit” method.' })
    case 'squash': return t({ message: 'Squash and merge', comment: 'GitHub’s merge method of the same name.' })
    case 'rebase': return t({ message: 'Rebase and merge', comment: 'GitHub’s merge method of the same name.' })
  }
}

/** A worker role's name and its line of work, as Settings > Watcher shows them (`WORKER_ROLES`). */
export function workerRoleWords(role: WorkerRoleId): { readonly name: string; readonly what: string } {
  switch (role) {
    case 'orchestrating': return { name: t({ message: 'Orchestrating', comment: 'A worker role: the kind of work Watcher itself does.' }), what: t`Watcher itself.` }
    case 'building': return { name: t({ message: 'Building', comment: 'A worker role: the kind of work a thread is started for.' }), what: t`Writing and changing code.` }
    case 'ui': return { name: t({ message: 'UI', comment: 'A worker role: work on user interfaces.' }), what: t`Screens, styles and how they look.` }
    case 'code-review': return { name: t({ message: 'Code review', comment: 'A worker role.' }), what: t`Reading a change and saying what is wrong with it.` }
    case 'research': return { name: t({ message: 'Research', comment: 'A worker role.' }), what: t`Reading code, docs and the web, and reporting back.` }
    case 'computer-use': return { name: t({ message: 'Computer use', comment: 'A worker role: clicking and typing in apps.' }), what: t`Clicking and typing in apps and the browser.` }
  }
}

/** Every word a provider job's case puts in the app (`HOST_PROVIDER_JOB_WORDS`) but its title, which is `hostProviderJobHeading`. */
export function hostProviderJobWords(jobCase: HostProviderJobCase): { readonly does: string; readonly doing: string; readonly button: string; readonly start: string; readonly working: string } {
  switch (jobCase) {
    case 'install': return {
      does: t({ message: 'installs', comment: 'What an agent does to a provider: “An agent {does} {name} on {hostName}”.' }),
      doing: t({ message: 'installing', comment: 'What an agent is doing to a provider.' }),
      button: t`Have my agent install it`, start: t`Start install`, working: t`Agent is installing it`,
    }
    case 'update': return {
      does: t({ message: 'updates', comment: 'What an agent does to a provider: “An agent {does} {name} on {hostName}”.' }),
      doing: t({ message: 'updating', comment: 'What an agent is doing to a provider.' }),
      button: t`Have my agent update it`, start: t`Start update`, working: t`Agent is updating it`,
    }
    case 'fix': return {
      does: t({ message: 'fixes', comment: 'What an agent does to a provider: “An agent {does} {name} on {hostName}”.' }),
      doing: t({ message: 'fixing', comment: 'What an agent is doing to a provider.' }),
      button: t`Have my agent fix it`, start: t`Start fix`, working: t`Agent is fixing it`,
    }
  }
}

/**
 * A provider job's dialog title: "Install Devin on forge". The job's thread keeps the English title
 * (`hostProviderJobTitle`), since a thread's title is the thread's own and is shown as written.
 */
export function hostProviderJobHeading(jobCase: HostProviderJobCase, provider: ProviderId, host: string): string {
  const name = PROVIDER_LABELS[provider]
  switch (jobCase) {
    case 'install': return t`Install ${name} on ${host}`
    case 'update': return t`Update ${name} on ${host}`
    case 'fix': return t`Fix ${name} on ${host}`
  }
}

/** The plain sentence a host that cannot start at boot gets (`bootUnsupportedSentence`). */
export function bootUnsupportedWords(reason: BootUnsupportedReason | undefined): string {
  return reason === 'macos'
    ? t`This host runs macOS, where a program starts at boot only with an administrator’s help, so Sotto cannot start it at boot.`
    : t`This host has no systemd user manager, so Sotto cannot start it at boot.`
}

/** A host with no OpenCode tile, and what would give it one (`opencodeNotOnHost`). */
export function opencodeNotOnHostWords(host: string): string {
  return t`OpenCode does not run on ${host}’s host. To use it there, put this computer’s version of the host on ${host}, stop the host and connect again.`
}

/** A host too old to sign OpenCode in from here (`opencodeHostNeedsUpdate`). */
export function opencodeHostNeedsUpdateWords(host: string): string {
  return t`The host on ${host} cannot sign OpenCode in to model sources from here. Nothing was changed. Put this computer’s version of the host on ${host}, stop the host and connect again.`
}

/** A host whose answer to a sign-in call was lost, as this computer says it (`HOST_ANSWER_LOST`). */
export const HOST_ANSWER_LOST_WORDS = {
  took: (host: string, source: string, signedIn: boolean): string => signedIn
    ? t`${host} did not answer at first, so Sotto read its model sources again: ${source} is signed in there.`
    : t`${host} did not answer at first, so Sotto read its model sources again: ${source} is signed out there.`,
  notTaken: (host: string, source: string, signingIn: boolean): string => signingIn
    ? t`${host} did not answer, so Sotto read its model sources again: ${source} is not signed in there, so nothing was saved. Try again.`
    : t`${host} did not answer, so Sotto read its model sources again: ${source} is still signed in there. Try again.`,
  untold: (host: string): string =>
    t`${host} did not answer, so Sotto could not tell whether anything was signed in or out there. It is reading ${host}’s model sources again; look under them before you try again.`,
  unknown: (host: string): string =>
    t`${host} did not answer, so Sotto could not tell whether anything was signed in or out there, and could not read its model sources to find out. Check that ${host} is connected, then look under its model sources before you try again.`,
  unread: (host: string): string => t`${host} did not answer, so Sotto could not read its model sources. Nothing was changed. Check that ${host} is connected, then try again.`,
  code: (host: string): string => t`${host} did not answer, so Sotto could not tell whether it took the code. The sign-in is still waiting. Paste the code again.`,
  page: (host: string): string => t`${host} did not answer, so the sign-in page did not open. Nothing was saved. Press Open the page again.`,
} as const

/**
 * A host of another Sotto version, and which side to bring up to date (`hostVersionMismatch`): one whole sentence for
 * each case, so each language can word it.
 */
export function hostVersionMismatchWords(clientVersion: string, hostVersion: string | undefined, owned: boolean, newer = hostIsNewer(hostVersion, clientVersion)): string {
  if (newer) return t`This host is running a newer version of Sotto than this computer. Nothing on the host was lost. Update Sotto on this computer, then connect again.`
  const version = clientVersion
  // A host that said which older Sotto it runs is offered an update on the Threads page (ADR-0040).
  if (hostIsOlder(hostVersion, clientVersion)) return owned
    ? t`This host is running a different version of Sotto. Nothing on the host was lost. Update it from the Threads page, or put the Sotto ${version} host in its installation folder, press Stop host, then connect again.`
    : t`This host is running a different version of Sotto. Nothing on the host was lost. Update it from the Threads page, or put the Sotto ${version} host in its installation folder, stop the host on that machine, then connect again.`
  return owned
    ? t`This host is running a different version of Sotto. Nothing on the host was lost. Put the Sotto ${version} host in its installation folder, press Stop host, then connect again.`
    : t`This host is running a different version of Sotto. Nothing on the host was lost. Put the Sotto ${version} host in its installation folder, stop the host on that machine, then connect again.`
}

/** The host answered that it is busy (`HOST_BUSY`). */
export function hostBusyWords(): string {
  return t`The host is busy. Nothing was lost. Try again in a moment.`
}

/** A host too old to start a thread from another (`THREAD_STARTS_UNSUPPORTED`). */
export function threadStartsUnsupportedWords(): string {
  return t`This host can’t start a thread from another yet, and nothing was made. Update Sotto on the host, then try again.`
}

/** A host that cannot keep screenshots (`HOST_CANNOT_STAGE_SCREENSHOTS`). */
export function hostCannotStageScreenshotsWords(): string {
  return t`This host cannot keep screenshots. Update Sotto there, then attach them again. Nothing was attached.`
}

/** Watcher held on a stable build (`WATCHER_DISABLED`, in src/main/agents/watcherLaunchProfiles.ts, which the host builds). */
export function watcherDisabledWords(): string {
  return t`Watcher is available in Sotto Owl. Open an Owl build to continue. Nothing was sent.`
}

/**
 * The words each OpenCode sign-in outcome is told in (`SIGN_IN_WORDS`), as the desktop shows them. The host keeps the
 * English, which it sends; main and the windows show these.
 */
export const SIGN_IN_INTERFACE_WORDS = {
  notRunning: (): string => t`Sotto’s OpenCode is not running, so nothing was signed in. Connect OpenCode, then try again.`,
  keyRefused: (source: string): string => t`OpenCode could not sign in to ${source} with that key, so nothing was saved. Check the key in your ${source} account and paste it again.`,
  expired: (source: string): string => t`The ${source} sign-in page expired before you finished, so nothing was saved. Open the sign-in page again to start over.`,
  failed: (source: string): string => t`The ${source} sign-in did not finish, so nothing was saved. Open the sign-in page again to start over.`,
  startFailed: (source: string): string => t`OpenCode could not start the ${source} sign-in, so nothing was saved. Try again in a moment, or choose another way to sign in.`,
  codeRefused: (source: string): string => t`${source} did not accept that code, so nothing was saved. Copy the code from the ${source} page and paste it again.`,
  formRefused: (source: string): string => t`OpenCode needs every question answered before it signs in to ${source}. Nothing was saved. Fill them in and try again.`,
  unsafePage: (): string => t`OpenCode gave a sign-in page that is not a secure https address, so Sotto did not open it and nothing was saved.`,
  pageNotOpened: (): string => t`Your browser did not open the sign-in page. Nothing was saved. Open this address in your browser yourself, or press Open the page again.`,
  keyNotSaved: (source: string): string => t`Sotto could not tell whether OpenCode saved the ${source} key, so it read OpenCode’s sign-ins again: ${source} is not signed in, so nothing was saved. Paste the key again.`,
  keyUnknown: (source: string): string => t`Sotto could not tell whether OpenCode saved the ${source} key, and could not read OpenCode’s sign-ins to find out. Close this and look under Model sources: ${source} is listed there if it was saved. If it is not, paste the key again.`,
  catalogUnread: (): string => t`Sotto could not read OpenCode’s model list again, so the model menu may be out of date. Each thread still moves to the new sign-ins when it next goes idle. Press Refresh OpenCode to read the list again.`,
  signOutFailed: (source: string): string => t`Sotto could not sign out of ${source}, so it is still signed in. Try again.`,
  unknownSource: (): string => t`OpenCode no longer lists that model source, so nothing was signed in. Close this and open it again.`,
  // The count is written as it always was, never grouped, so English reads the same at any size.
  signedIn: (source: string, models: number): string => { const count = String(models); return plural(models, {
    0: `Signed in to ${source}. OpenCode lists none of its models yet, so none are in the model menu.`,
    one: `Signed in to ${source}. Its model is in the model menu, under OpenCode.`,
    other: `Signed in to ${source}. Its ${count} models are in the model menu, under OpenCode.`,
  }) },
  keyUnchecked: (source: string): string => t`OpenCode tries the key the first time a thread uses one of its models. If ${source} refuses it then, sign out here and paste the key again.`,
  signedOut: (source: string, key: boolean): string => key
    ? t`Signed out of ${source}. Its key is gone from Sotto’s OpenCode.`
    : t`Signed out of ${source}. Its sign-in is gone from Sotto’s OpenCode.`,
} as const

/**
 * A refusal about one of the user's own model servers (`ownServerRefusalWords`), by its reason, in the interface
 * language. Main and the host answer with the reason and the English; a window says it with these.
 */
export function ownServerRefusalInterfaceWords(reason: OwnServerRefusal, host: string, serverName = host): string {
  const name = serverName
  switch (reason) {
    case 'bad-address': return t`That is not an address Sotto can reach. Type it like http://localhost:11434 or http://spark-head:8888.`
    case 'public-http': return t`${host} is on the internet, so Sotto needs https:// to send it a key and your code. Use the server’s https address, or reach it over your tailnet.`
    case 'unreachable': return t`Nothing answered at ${host}. Nothing was saved. Check the server is on and this computer can reach it, over the tailnet if it is there, then try again.`
    case 'key-needed': return t`${host} asks for a key. Nothing was saved. Paste the key whoever runs the server gave you, then check again.`
    case 'key-refused': return t`${host} turned down the key. Nothing was saved. Check the key with whoever runs the server, then try again.`
    case 'no-models': return t`${host} answered but has no models loaded. Nothing was saved. Load a model on the server, then check again.`
    case 'not-openai': return t`Something answered at ${host}, but not as an OpenAI-compatible server. Nothing was saved. Check the port and the path, such as http://localhost:11434/v1, then try again.`
    case 'opencode-not-running': return t`Your own servers run with OpenCode, and Sotto’s OpenCode is not running, so nothing was saved. Connect OpenCode under Providers, then add the server again.`
    case 'sign-in-failed': return t`OpenCode did not take the key for ${name}, so nothing was saved. Try adding the server again.`
    case 'not-found': return t`That server is no longer saved. Nothing was changed.`
    case 'full': return t`Sotto keeps up to 32 servers. Remove one you no longer use, then add this one.`
    case 'already-added': return t`${host} is already added. Nothing was saved. To change its key or its models, remove it and add it again.`
    case 'failed': return t`Sotto could not finish that, so nothing was changed. Try again.`
    case 'removed-partly': return t`OpenCode no longer has the key for ${name}, but Sotto could not take ${name} off its list. Remove it again.`
    case 'added-partly': return t`OpenCode did not take the key for ${name}, and Sotto could not take ${name} back off its list, so it is saved without its key. Remove it, then add it again.`
  }
}

/** Cursor's sign-in outcomes (`CURSOR_SIGN_IN_WORDS`), as main and the windows show them. */
export const CURSOR_SIGN_IN_INTERFACE_WORDS = {
  waiting: (): string => t`Finish signing in on cursor.com in your browser.`,
  notRunning: (): string => t`Cursor’s sign-in is not available right now. Nothing was changed.`,
  pageRefused: (): string => t`Cursor asked to sign in on a page Sotto does not open. Nothing was signed in. Run agent login in a terminal instead.`,
  signedOut: (): string => t`Cursor is signed out on this computer.`,
  signOutFailed: (): string => t`Cursor could not sign out. Nothing was changed. Run agent logout in a terminal to try again.`,
} as const

/** What an interactive visual is called on its card (`INTERACTIVE_VISUAL_LABEL`, which the tool's reply keeps in English). */
export function interactiveVisualLabel(): string {
  return t({ message: 'Interactive page', comment: 'The kind of a visual an agent drew: an HTML page of its own.' })
}

/** What went wrong transcribing when nothing was kept (`TRANSCRIPTION_ERROR_DETAIL`). */
export function transcriptionErrorDetail(code: TranscriptionErrorCode): string {
  return code === 'TRANSCRIPTION_MODEL_NOT_READY'
    ? t`The speech model stopped before it could transcribe. The recording was not kept. Check the speech model in Settings → Dictation, then dictate again.`
    : t`The speech model could not transcribe this recording. The recording was not kept. Dictate again.`
}

/** What a transcription failure that kept the recording says (`TRANSCRIPTION_KEPT_DETAIL`). */
export function transcriptionKeptDetail(code: TranscriptionErrorCode): string {
  return code === 'TRANSCRIPTION_MODEL_NOT_READY'
    ? t`The speech model is not ready. Your recording is kept until you try again or discard it. Check the speech model in Settings → Dictation, then try again.`
    : t`The speech model could not transcribe this recording. Your recording is kept until you try again or discard it.`
}

/** Dictation started before the speech model was ready (`SPEECH_MODEL_NOT_READY_DETAIL`). */
export function speechModelNotReadyDetail(): string {
  return t`The speech model is not ready yet, so nothing was recorded. Choose one, or see where it stands, in Settings → Dictation.`
}

/** Setup was finished without a microphone (`MICROPHONE_NOT_SET_UP_DETAIL`). */
export function microphoneNotSetUpDetail(): string {
  return t`Run the microphone test in Settings to set one up.`
}

/**
 * A fixed English sentence a host or a shared module sends, in the interface language; any other text as it came. A
 * window passes a host's refusal or notice through this where it shows it, so the sentence stays English on the wire,
 * where it is compared and where an older client reads it, and is translated only on screen. Text a provider or a
 * person wrote never matches, so it is shown as written.
 */
export function inInterfaceLanguage(sentence: string): string {
  switch (sentence) {
    case SCREENSHOT_WRONG_TYPE: return t`Only PNG, JPEG, GIF, and WebP screenshots can be attached. Nothing was attached. Choose files of those types.`
    case SCREENSHOT_TOO_LARGE: return t`Each screenshot must be 10 MB or smaller. Nothing was attached. Choose a smaller file.`
    case SCREENSHOTS_TOO_LARGE_IN_TOTAL: return t`Screenshots must total 20 MB or less. Nothing was attached. Remove an image or choose smaller files.`
    case SCREENSHOT_NOT_ITS_TYPE: return t`This screenshot’s content does not match its file type. Nothing was attached. Save it again as PNG, JPEG, GIF, or WebP, then attach it.`
    case MANAGEMENT_REMOVED: return t`Voice control and thread management are no longer available. Your threads and drafts are kept. Use the thread composer to continue.`
    case LEGACY_MANAGEMENT_UPDATE: return t`This host still has thread management running. Its history and drafts are kept. Update the host from the Threads page before continuing.`
    case HOST_BUSY: return hostBusyWords()
    case THREAD_STARTS_UNSUPPORTED: return threadStartsUnsupportedWords()
    case HOST_CANNOT_STAGE_SCREENSHOTS: return hostCannotStageScreenshotsWords()
  }
  if (!PROVIDER_CONNECTION_NOTICES.includes(sentence)) return sentence
  const provider = (Object.keys(PROVIDER_LABELS) as ProviderId[]).find(id => sentence === `${PROVIDER_LABELS[id]} connected`)
  if (provider === undefined) return t`Thread providers connected`
  const name = PROVIDER_LABELS[provider]
  return t({ message: `${name} connected`, comment: 'A notice once a provider connects: “Codex connected”.' })
}
