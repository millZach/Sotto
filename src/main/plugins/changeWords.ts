import { t } from '@lingui/core/macro'
import type { PluginChange } from '../../shared/plugins'
import type { PluginChangeCard } from './pendingChanges'

type GitHubChange = Extract<PluginChange, { readonly kind: 'github-comment' | 'github-open-issue' | 'github-close-issue' | 'github-reopen-issue' }>
type VercelChange = Extract<PluginChange, { readonly kind: 'vercel-cancel' | 'vercel-promote' | 'vercel-rollback' }>
type MailRead = Extract<PluginChange, { readonly kind: 'mail-read' }>

/**
 * A plugin change's card, in the interface language (ADR-0205, decision 7; ADR-0185): what will happen in plain words,
 * what it acts on, as which account, and everything that will be sent. Each button says what a press does, so a card
 * that cancels something never offers a button called Cancel. Worded when the change is asked for.
 */
export function wordPluginChange(change: PluginChange): PluginChangeCard {
  if (change.kind === 'mail-read') return wordMailRead(change)
  // Only a Vercel change names a deployment.
  return 'deploymentId' in change ? wordVercelChange(change) : wordGitHubChange(change)
}

/**
 * A thread's first read of a mail account (decision 8). Not a change: the user's yes lets this thread, and no other,
 * search and read the account until they stop it or the thread is settled. The card says where what is read goes.
 */
function wordMailRead(change: MailRead): PluginChangeCard {
  const { plugin, provider } = change
  // The account as the user named it, and never its address: these words can be handed on with the card.
  const named = change.account
  return {
    plugin,
    text: provider ? t`Let this thread read the ${plugin} account ${named}? What it reads goes to ${provider}.`
      : t`Let this thread read the ${plugin} account ${named}? What it reads goes to this thread’s provider.`,
    action: t`Read ${plugin} mail`,
    target: named,
    details: [
      t`This thread can search this account’s mail and read its messages, until you stop it or the thread is settled.`,
      provider ? t`What it reads goes to ${provider}, as everything a thread reads does.` : t`What it reads goes to this thread’s provider, as everything a thread reads does.`,
      t`It cannot send, move or delete mail. Every other thread asks for itself.`,
    ].join('\n'),
    allow: t`Let this thread read it`,
    deny: t`Don’t allow`,
  }
}

function wordGitHubChange(change: GitHubChange): PluginChangeCard {
  const login = change.account
  const repository = `${change.owner}/${change.repo}`
  if (change.kind === 'github-comment') {
    const where = `${repository} #${change.number}`
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
  if (change.kind === 'github-open-issue') {
    const title = change.title
    return {
      plugin: 'GitHub',
      text: login ? t`Open this issue in ${repository} on GitHub, as ${login}?` : t`Open this issue in ${repository} on GitHub, as the account gh is signed in to?`,
      action: login ? t`Open an issue on GitHub as ${login}` : t`Open an issue on GitHub`,
      target: repository,
      // The title and the body are everything that is sent: no labels, and nobody assigned.
      details: [t`Title: ${title}`, ...(change.body ? ['', change.body] : [])].join('\n'),
      allow: t`Open the issue`,
      deny: t`Don’t open it`,
    }
  }
  const where = `${repository} #${change.number}`
  const title = change.title
  if (change.kind === 'github-close-issue') {
    return {
      plugin: 'GitHub',
      text: login ? t`Close issue ${where} on GitHub, as ${login}?` : t`Close issue ${where} on GitHub, as the account gh is signed in to?`,
      action: login ? t`Close an issue on GitHub as ${login}` : t`Close an issue on GitHub`,
      target: where,
      details: [t`Issue: ${title}`, change.reason === 'not_planned' ? t`Closed as: not planned` : t`Closed as: completed`].join('\n'),
      allow: t`Close the issue`,
      deny: t`Leave it open`,
    }
  }
  return {
    plugin: 'GitHub',
    text: login ? t`Reopen issue ${where} on GitHub, as ${login}?` : t`Reopen issue ${where} on GitHub, as the account gh is signed in to?`,
    action: login ? t`Reopen an issue on GitHub as ${login}` : t`Reopen an issue on GitHub`,
    target: where,
    details: t`Issue: ${title}`,
    allow: t`Reopen the issue`,
    deny: t`Leave it closed`,
  }
}

function wordVercelChange(change: VercelChange): PluginChangeCard {
  const account = change.account, id = change.deploymentId, team = change.teamId, projectId = change.projectId
  const named = change.project ?? id
  const project = change.project
  const about = [
    project ? (projectId ? t`Project: ${project} (${projectId})` : t`Project: ${project}`) : projectId ? t`Project: ${projectId}` : null,
    change.target ? t`Kind: ${change.target}` : null,
    change.url ? t`Address: ${change.url}` : null,
    change.state ? t`Its build now: ${change.state}` : null,
    t`Deployment: ${id}`,
    team ? t`Team: ${team}` : null,
    t`Vercel account: ${account}`,
  ].filter((line): line is string => line !== null)
  if (change.kind === 'vercel-promote') {
    return {
      plugin: 'Vercel',
      text: t`Promote this deployment of ${named} to production on Vercel?`,
      action: t`Promote a deployment to production on Vercel`,
      target: named,
      details: [...about, t`The project’s production addresses will serve this deployment. It is not built again.`].join('\n'),
      allow: t`Promote to production`,
      deny: t`Leave production as it is`,
    }
  }
  if (change.kind === 'vercel-rollback') {
    return {
      plugin: 'Vercel',
      text: t`Roll production of ${named} back to this deployment on Vercel?`,
      action: t`Roll production back on Vercel`,
      target: named,
      details: [...about, t`The project’s production addresses will serve this deployment again, at once.`,
        t`After a rollback, Vercel keeps new pushes to the production branch out of production until a deployment is promoted.`].join('\n'),
      allow: t`Roll production back`,
      deny: t`Leave production as it is`,
    }
  }
  return {
    plugin: 'Vercel',
    text: t`Cancel the build of ${named} on Vercel?`,
    action: t`Cancel a deployment on Vercel`,
    target: named,
    details: [...about, t`A cancelled build cannot be picked up again. It has to be deployed again.`].join('\n'),
    allow: t`Cancel the build`,
    deny: t`Leave it running`,
  }
}
