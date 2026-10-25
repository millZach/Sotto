import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'

import type { OwnServerTurn, OwnServerTurnFailure } from '../../../shared/agentActivity'

/**
 * What a thread on one of the user's own model servers says while the server will not answer a turn and when it lets
 * the turn down (ADR-0124, October 24 amendment), in the interface language (ADR-0123). Main keeps the same failure in
 * English as the turn's reason, for phones, Watcher's news and older windows; the window words it here instead.
 *
 * Every helper takes the `i18n` a component's `useLingui()` gave it, so the component draws again in a new language
 * the moment the interface language changes.
 */

/** What the words say of a turn's server: its name, the model's name, and the address's host and port. */
export type OwnServerNames = Pick<OwnServerTurn, 'name' | 'model' | 'host'>

/** The live line while OpenCode tries the server again. */
export function retryingWords(i18n: I18n, server: Pick<OwnServerTurn, 'name'>, attempt: number, attempts: number): string {
  const name = server.name, tried = i18n.number(attempt), of = i18n.number(attempts)
  return i18n._(msg({ message: `${name} isn’t answering. Trying again (${tried} of ${of}).`, comment: '{name} is the user’s own model server, such as Sparks. "(3 of 10)": the try OpenCode is on, of how many it makes.' }))
}

/** The live line once the server has sent nothing for 30 seconds. */
export function stillWaitingWords(i18n: I18n, server: Pick<OwnServerTurn, 'name'>): string {
  const name = server.name
  return i18n._(msg({ message: `Still waiting for ${name} to start answering.`, comment: '{name} is the user’s own model server, such as Sparks.' }))
}
export function stillWaitingNote(i18n: I18n): string {
  const five = i18n.number(5)
  return i18n._(msg({ message: `A long prompt can take a few minutes. The turn stops waiting at ${five} minutes.`, comment: '{five} is the number 5.' }))
}

/** A failed turn's words: the first sentence says what happened and is drawn in the error colour; the rest follows it. */
export function failureWords(i18n: I18n, failure: OwnServerTurnFailure, server: OwnServerNames): { readonly title: string; readonly body: string } {
  const { name, model, host } = server
  switch (failure) {
    case 'unreachable': {
      const ten = i18n.number(10)
      return {
        title: i18n._(msg({ message: `${name} didn’t answer.`, comment: '{name} is the user’s own model server, such as Sparks.' })),
        body: i18n._(msg({ message: `OpenCode tried it ${ten} times over about a minute and a half. Nothing in the thread was lost. Check that ${name} is on and this computer can reach ${host}, then try again.`,
          comment: '{ten} is the number 10. {host} is the server’s address and port, such as spark-head:8888; keep it as it is.' })),
      }
    }
    case 'timeout': {
      const five = i18n.number(5)
      return {
        title: i18n._(msg({ message: `${name} didn’t start answering within ${five} minutes.`, comment: '{five} is the number 5.' })),
        body: i18n._(msg`It took the message but sent nothing back. It may be busy, stuck or still reading a very long prompt. Nothing in the thread was lost. Check ${name}, then try again.`),
      }
    }
    case 'key-refused': return {
      title: i18n._(msg`${name} turned down its key.`),
      body: i18n._(msg({ message: `Nothing in the thread was lost. In Settings › Providers › Your own model servers, remove ${name} and add it again with the right key, then try again.`,
        comment: 'Settings › Providers › Your own model servers is where the server is kept; translate each name as the Settings page does.' })),
    }
    case 'model-gone': return {
      title: i18n._(msg({ message: `${name} no longer has ${model}.`, comment: '{model} is a model’s name, such as DeepSeek V4.1 Flash.' })),
      body: i18n._(msg`Nothing in the thread was lost. Pick another model in the model menu below, or load ${model} on ${name} again, then try again.`),
    }
    case 'too-long': return {
      title: i18n._(msg`This thread is too long for ${model}.`),
      body: i18n._(msg`Your last message and the thread before it are more than the model takes at once. Nothing in the thread was lost. OpenCode threads can’t be compacted in Sotto, so pick a model with more context and try again, or start a new thread.`),
    }
  }
}

export const stopWords = (i18n: I18n): string => i18n._(msg({ message: 'Stop', comment: 'Button on the line of a turn that is waiting on the user’s own model server: stops the turn.' }))
export const stopName = (i18n: I18n): string => i18n._(msg`Stop agent`)
export const tryAgainWords = (i18n: I18n): string => i18n._(msg({ message: 'Try again', comment: 'Button under a failed turn: sends the user’s last message again.' }))
export function tryAgainName(i18n: I18n, server: Pick<OwnServerTurn, 'name'>): string {
  const name = server.name
  return i18n._(msg`Try again, sending your last message to ${name} again`)
}
/** Try again on a message whose images cannot be sent again: it puts the message back in the composer instead. */
export const putBackName = (i18n: I18n): string => i18n._(msg`Try again, putting your last message back in the composer`)
export const imagesNotKept = (i18n: I18n): string => i18n._(msg`The images in your last message were not kept. Attach them again, then send.`)
export const openSettingsWords = (i18n: I18n): string => i18n._(msg`Open Settings`)
export const openSettingsName = (i18n: I18n): string => i18n._(msg`Open Settings at Your own model servers`)
