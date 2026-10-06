/**
 * Words Settings > Hosts uses about a host's tailnet connection (ADR-0053), kept apart from the dialogs so the row, Add host's
 * checklist, Edit connection and the Phones dialog all say the same thing.
 */

/** What a Linux host's owner runs there so Tailscale Serve may change its settings. Sotto never runs it. */
export const TAILSCALE_OPERATOR_COMMAND = 'sudo tailscale set --operator=$USER'

/** When this computer last reached a host over its tailnet: the time today, and the day and time before that. */
export function lastReached(seen: number, now: number = Date.now()): string {
  const at = new Date(seen)
  const today = new Date(now).toDateString() === at.toDateString()
  return today ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
