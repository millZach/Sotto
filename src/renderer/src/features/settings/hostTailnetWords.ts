import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/core/macro'

import type { HostAddTailnet, HostTailnetNote } from '../../../../shared/hosts'
import { shownWords, type LaterWords } from './laterWords'
import { mergedWhen } from '../../tools/pullRequestSurface.logic'

/**
 * Words Settings > Hosts & phones uses about Tailscale and a host's tailnet connection (ADR-0053), kept apart from the dialogs so the
 * row, Add host's checklist, Edit connection and the Phones dialog find them in one place.
 */

/** What a Linux host's owner runs there so Tailscale Serve may change its settings. Sotto never runs it. */
export const TAILSCALE_OPERATOR_COMMAND = 'sudo tailscale set --operator=$USER'

/** Where "Why Tailscale asks" leads: the guide's section on a tailnet policy's `check` and `accept`. */
export const TAILSCALE_GUIDE_URL = 'https://github.com/millZach/Sotto/blob/main/docs/guide.md#hosts-over-tailscale-ssh'

/** When this computer last reached a host over its tailnet: the time today, and the day and time before that. */
export function lastReached(seen: number, now: number = Date.now()): string {
  return mergedWhen(new Date(seen).toISOString(), new Date(now)) ?? ''
}

/**
 * The line under a row whose host is on its SSH connection although its owner chose the tailnet: why, and that Sotto tries
 * again. The operator's has the command to run on the host, which the row sets apart: it is written as one sentence, so a
 * language may move the command, and split around it.
 */
export function tailnetRowNote(name: string, note: HostTailnetNote): { readonly text: string; readonly command?: string; readonly after?: string } {
  switch (note) {
    case 'operator': {
      const command = TAILSCALE_OPERATOR_COMMAND
      const sentence = t({ message: `${name}’s Tailscale Serve needs ${command}, run on ${name}. Sotto stays on SSH until it can, and tries again every 5 minutes.`, comment: '{command} is a terminal command, shown apart from the sentence. {name} is a computer.' })
      const at = sentence.indexOf(command)
      return at < 0 ? { text: sentence } : { text: sentence.slice(0, at), command, after: sentence.slice(at + command.length) }
    }
    case 'no-tailscale': return { text: t`Tailscale isn’t running on ${name}, so Sotto connects over SSH. It tries the tailnet again every 5 minutes.` }
    case 'no-address': return { text: t`${name} hasn’t said where your tailnet reaches it yet. Sotto tries again every 5 minutes.` }
    case 'unreachable': return { text: t`Sotto tries it again every 5 minutes.` }
  }
}

/** The press on Add host's tailnet step that chooses the tailnet again. */
export const TRY_TAILNET_AGAIN = msg`Try the tailnet again`

/**
 * Add host's tailnet step as its checklist shows it: still to come, under way, done, or the host kept on its SSH connection
 * with why. `error` is the sentence a press of Try the tailnet again came back with.
 */
export type TailnetStepView = { readonly state: 'todo' } | HostAddTailnet | { readonly state: 'ssh'; readonly why: 'error'; readonly error: LaterWords }

/** What the tailnet step says when the host stayed on SSH: why, that it is still connected, and what to do. Only the operator's has a command. */
export function tailnetStepNote(view: Extract<TailnetStepView, { state: 'ssh' }>, name: string, address: string | undefined): { readonly text: string; readonly command?: string } {
  // The name of the button the sentence asks for, as the button shows it.
  const button = i18n._(TRY_TAILNET_AGAIN)
  switch (view.why) {
    case 'operator': return { text: t`${name}’s Tailscale Serve needs your SSH account to be Tailscale’s operator there, so ${name} is connected over SSH and nothing was lost. Run this on ${name}, then press ${button}.`, command: TAILSCALE_OPERATOR_COMMAND }
    case 'no-tailscale': return { text: t`Tailscale isn’t running on ${name}, so ${name} is connected over SSH and nothing was lost. Start Tailscale there, then press ${button}.` }
    case 'no-address': return { text: t`${name} hasn’t said where your tailnet reaches it yet, so ${name} is connected over SSH and nothing was lost. Sotto tries again every 5 minutes.` }
    case 'not-reached': return { text: t`Sotto couldn’t reach the host on ${name} to turn on its tailnet connections, so ${name} is connected over SSH and nothing was lost. Press ${button}.` }
    case 'old-host': return { text: t`The host on ${name} can’t be reached over your tailnet until it is updated, so ${name} is connected over SSH and nothing was lost. Update it from the Threads page, then press ${button}.` }
    case 'refused': {
      // The host's own sentence, in the host's words.
      const error = view.error
      return { text: error ? t`${error} ${name} is connected over SSH and nothing was lost. Press ${button}.` : t`The host on ${name} didn’t turn on its tailnet connections, so ${name} is connected over SSH and nothing was lost. Press ${button}.` }
    }
    case 'error': return { text: shownWords(view.error) }
    case 'unreachable': return { text: address === undefined
      ? t`${name} didn’t answer at its tailnet address, so ${name} is connected over SSH and nothing was lost. Sotto tries the tailnet again every 5 minutes.`
      : t`${name} didn’t answer at ${address}, so ${name} is connected over SSH and nothing was lost. Sotto tries the tailnet again every 5 minutes.` }
  }
}
