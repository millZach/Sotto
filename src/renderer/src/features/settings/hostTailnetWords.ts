import type { HostAddTailnet, HostTailnetNote } from '../../../../shared/hosts'
import { mergedWhen } from '../../tools/pullRequestSurface.logic'

/**
 * Words Settings > Hosts uses about Tailscale and a host's tailnet connection (ADR-0053), kept apart from the dialogs so the
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
 * again. The operator's has the command to run on the host, which the row sets apart.
 */
export function tailnetRowNote(name: string, note: HostTailnetNote): { readonly text: string; readonly command?: string; readonly after?: string } {
  switch (note) {
    case 'operator': return { text: `${name}’s Tailscale Serve needs `, command: TAILSCALE_OPERATOR_COMMAND, after: `, run on ${name}. Sotto stays on SSH until it can, and tries again every 5 minutes.` }
    case 'no-tailscale': return { text: `Tailscale isn’t running on ${name}, so Sotto connects over SSH. It tries the tailnet again every 5 minutes.` }
    case 'no-address': return { text: `${name} hasn’t said where your tailnet reaches it yet. Sotto tries again every 5 minutes.` }
    case 'unreachable': return { text: 'Sotto tries it again every 5 minutes.' }
  }
}

/** The press on Add host's tailnet step that chooses the tailnet again. */
export const TRY_TAILNET_AGAIN = 'Try the tailnet again'

/**
 * Add host's tailnet step as its checklist shows it: still to come, under way, done, or the host kept on its SSH connection
 * with why. `error` is the sentence a press of Try the tailnet again came back with.
 */
export type TailnetStepView = { readonly state: 'todo' } | HostAddTailnet | { readonly state: 'ssh'; readonly why: 'error'; readonly error: string }

/** What the tailnet step says when the host stayed on SSH: why, that it is still connected, and what to do. Only the operator's has a command. */
export function tailnetStepNote(view: Extract<TailnetStepView, { state: 'ssh' }>, name: string, address: string | undefined): { readonly text: string; readonly command?: string } {
  const ssh = `so ${name} is connected over SSH and nothing was lost.`
  const again = `then press ${TRY_TAILNET_AGAIN}.`
  switch (view.why) {
    case 'operator': return { text: `${name}’s Tailscale Serve needs your SSH account to be Tailscale’s operator there, ${ssh} Run this on ${name}, ${again}`, command: TAILSCALE_OPERATOR_COMMAND }
    case 'no-tailscale': return { text: `Tailscale isn’t running on ${name}, ${ssh} Start Tailscale there, ${again}` }
    case 'no-address': return { text: `${name} hasn’t said where your tailnet reaches it yet, ${ssh} Sotto tries again every 5 minutes.` }
    case 'old-host': return { text: `The host on ${name} can’t be reached over your tailnet until it is updated, ${ssh} Update it from the Threads page, ${again}` }
    case 'refused': return { text: `The host on ${name} didn’t turn on its tailnet connections, ${ssh} Press ${TRY_TAILNET_AGAIN}.` }
    case 'error': return { text: view.error }
    case 'unreachable': return { text: `${name} didn’t answer at ${address ?? 'its tailnet address'}, ${ssh} Sotto tries the tailnet again every 5 minutes.` }
  }
}
