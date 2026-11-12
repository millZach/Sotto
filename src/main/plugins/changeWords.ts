import { t } from '@lingui/core/macro'
import type { PluginChange } from '../../shared/plugins'
import type { PluginChangeCard } from './pendingChanges'

/**
 * A plugin change's card, in the interface language (ADR-0205, decision 7; ADR-0185): what will happen in plain words,
 * what it acts on, and everything that will be sent. Each button says what a press does, so a card that cancels
 * something never offers a button called Cancel. Worded when the change is asked for.
 */
export function wordPluginChange(change: PluginChange): PluginChangeCard {
  if (change.kind === 'github-comment') {
    const where = `${change.owner}/${change.repo} #${change.number}`
    const login = change.account
    return {
      plugin: 'GitHub',
      text: login ? t`Post this comment on ${where} on GitHub, as ${login}?` : t`Post this comment on ${where} on GitHub, as the account gh is signed in to?`,
      action: login ? t`Comment on GitHub as ${login}` : t`Comment on GitHub`,
      target: where,
      details: change.body,
      allow: t`Post the comment`,
      deny: t`Don’t post it`,
    }
  }
  const account = change.account, id = change.deploymentId, team = change.teamId
  const named = change.project ?? id
  const lines = [
    change.project ? t`Project: ${change.project}` : null,
    change.target ? t`Kind: ${change.target}` : null,
    change.url ? t`Address: ${change.url}` : null,
    change.state ? t`Its build now: ${change.state}` : null,
    t`Deployment: ${id}`,
    team ? t`Team: ${team}` : null,
    t`Vercel account: ${account}`,
    t`A cancelled build cannot be picked up again. It has to be deployed again.`,
  ].filter((line): line is string => line !== null)
  return {
    plugin: 'Vercel',
    text: t`Cancel the build of ${named} on Vercel?`,
    action: t`Cancel a deployment on Vercel`,
    target: named,
    details: lines.join('\n'),
    allow: t`Cancel the build`,
    deny: t`Leave it running`,
  }
}
