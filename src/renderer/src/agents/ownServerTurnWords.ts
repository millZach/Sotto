import { i18n } from '@lingui/core'
import { t } from '@lingui/core/macro'

import type { OwnServerTurnFailure } from '../../../shared/agentActivity'

/**
 * What a thread on one of the user's own model servers says while the server will not answer a turn and when it lets
 * the turn down (ADR-0124, October 24 amendment), in the interface language (ADR-0123). Main keeps the same failure in
 * English as the turn's reason, for phones, Watcher's news and older windows; the window words it here instead.
 */

/** The live line while OpenCode tries the server again. */
export function retryingWords(name: string, attempt: number, attempts: number): string {
  const tried = i18n.number(attempt), of = i18n.number(attempts)
  return t({ message: `${name} isn’t answering. Trying again (${tried} of ${of}).`, comment: '{name} is the user’s own model server, such as Sparks. "(3 of 10)": the try OpenCode is on, of how many it makes.' })
}

/** The live line once the server has sent nothing for 30 seconds. */
export const stillWaitingWords = (name: string): string =>
  t({ message: `Still waiting for ${name} to start answering.`, comment: '{name} is the user’s own model server, such as Sparks.' })
export function stillWaitingNote(): string {
  const five = i18n.number(5)
  return t({ message: `A long prompt can take a few minutes. The turn stops waiting at ${five} minutes.`, comment: '{five} is the number 5.' })
}

/** A failed turn's words: the first sentence says what happened and is drawn in the error colour; the rest follows it. */
export function failureWords(failure: OwnServerTurnFailure, name: string, model: string, host: string): { readonly title: string; readonly body: string } {
  switch (failure) {
    case 'unreachable': {
      const ten = i18n.number(10)
      return {
        title: t({ message: `${name} didn’t answer.`, comment: '{name} is the user’s own model server, such as Sparks.' }),
        body: t({ message: `OpenCode tried it ${ten} times over about a minute and a half. Nothing in the thread was lost. Check that ${name} is on and this computer can reach ${host}, then try again.`,
          comment: '{ten} is the number 10. {host} is the server’s address and port, such as spark-head:8888; keep it as it is.' }),
      }
    }
    case 'timeout': {
      const five = i18n.number(5)
      return {
        title: t({ message: `${name} didn’t start answering within ${five} minutes.`, comment: '{five} is the number 5.' }),
        body: t`It took the message but sent nothing back. It may be busy, stuck or still reading a very long prompt. Nothing in the thread was lost. Check ${name}, then try again.`,
      }
    }
    case 'key-refused': return {
      title: t`${name} turned down its key.`,
      body: t({ message: `Nothing in the thread was lost. In Settings › Providers › Your own model servers, remove ${name} and add it again with the right key, then try again.`,
        comment: 'Settings › Providers › Your own model servers is where the server is kept; translate each name as the Settings page does.' }),
    }
    case 'model-gone': return {
      title: t({ message: `${name} no longer has ${model}.`, comment: '{model} is a model’s name, such as DeepSeek V4.1 Flash.' }),
      body: t`Nothing in the thread was lost. Pick another model in the model menu below, or load ${model} on ${name} again, then try again.`,
    }
    case 'too-long': return {
      title: t`This thread is too long for ${model}.`,
      body: t`Your last message and the thread before it are more than the model takes at once. Nothing in the thread was lost. OpenCode threads can’t be compacted in Sotto, so pick a model with more context and try again, or start a new thread.`,
    }
  }
}

export const stopWords = (): string => t({ message: 'Stop', comment: 'Button on the line of a turn that is waiting on the user’s own model server: stops the turn.' })
export const stopName = (): string => t`Stop agent`
export const tryAgainWords = (): string => t({ message: 'Try again', comment: 'Button under a failed turn: sends the user’s last message again.' })
export const tryAgainName = (name: string): string => t`Try again, sending your last message to ${name} again`
export const openSettingsWords = (): string => t`Open Settings`
export const openSettingsName = (): string => t`Open Settings at Your own model servers`
