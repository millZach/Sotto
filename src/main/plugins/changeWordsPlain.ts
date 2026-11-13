import type { PluginChange } from '../../shared/plugins'
import type { PluginChangeCard } from './pendingChanges'

type GitHubChange = Extract<PluginChange, { readonly kind: 'github-comment' | 'github-open-issue' | 'github-close-issue' | 'github-reopen-issue' }>
type VercelChange = Extract<PluginChange, { readonly kind: 'vercel-cancel' | 'vercel-promote' | 'vercel-rollback' }>

/**
 * A plugin change's card in English, for a headless host (ADR-0205, decision 7). A host has no interface language and
 * cannot load Lingui (ADR-0123), so what it sends to be shown is its English, as its refusals are, until the host
 * protocol carries a change a client can word for itself. `changeWords.ts` is the desktop's, in the interface
 * language; the two say the same thing, and `changeWordsPlain.test.ts` holds them to it, so a sentence changed in one
 * is changed in the other.
 */
export function wordPluginChangeInEnglish(change: PluginChange): PluginChangeCard {
  // Only a Vercel change names a deployment.
  return 'deploymentId' in change ? wordVercelChange(change) : wordGitHubChange(change)
}

function wordGitHubChange(change: GitHubChange): PluginChangeCard {
  const login = change.account
  const repository = `${change.owner}/${change.repo}`
  if (change.kind === 'github-comment') {
    const where = `${repository} #${change.number}`
    return {
      plugin: 'GitHub',
      text: login ? `Post this comment on ${where} on GitHub, as ${login}?` : `Post this comment on ${where} on GitHub, as the account gh is signed in to?`,
      action: login ? `Comment on GitHub as ${login}` : `Comment on GitHub`,
      target: where,
      details: change.body,
      allow: `Post the comment`,
      deny: `Don’t post it`,
    }
  }
  if (change.kind === 'github-open-issue') {
    const title = change.title
    return {
      plugin: 'GitHub',
      text: login ? `Open this issue in ${repository} on GitHub, as ${login}?` : `Open this issue in ${repository} on GitHub, as the account gh is signed in to?`,
      action: login ? `Open an issue on GitHub as ${login}` : `Open an issue on GitHub`,
      target: repository,
      // The title and the body are everything that is sent: no labels, and nobody assigned.
      details: [`Title: ${title}`, ...(change.body ? ['', change.body] : [])].join('\n'),
      allow: `Open the issue`,
      deny: `Don’t open it`,
    }
  }
  const where = `${repository} #${change.number}`
  const title = change.title
  if (change.kind === 'github-close-issue') {
    return {
      plugin: 'GitHub',
      text: login ? `Close issue ${where} on GitHub, as ${login}?` : `Close issue ${where} on GitHub, as the account gh is signed in to?`,
      action: login ? `Close an issue on GitHub as ${login}` : `Close an issue on GitHub`,
      target: where,
      details: [`Issue: ${title}`, change.reason === 'not_planned' ? `Closed as: not planned` : `Closed as: completed`].join('\n'),
      allow: `Close the issue`,
      deny: `Leave it open`,
    }
  }
  return {
    plugin: 'GitHub',
    text: login ? `Reopen issue ${where} on GitHub, as ${login}?` : `Reopen issue ${where} on GitHub, as the account gh is signed in to?`,
    action: login ? `Reopen an issue on GitHub as ${login}` : `Reopen an issue on GitHub`,
    target: where,
    details: `Issue: ${title}`,
    allow: `Reopen the issue`,
    deny: `Leave it closed`,
  }
}

function wordVercelChange(change: VercelChange): PluginChangeCard {
  const account = change.account, id = change.deploymentId, team = change.teamId, projectId = change.projectId
  const named = change.project ?? id
  const project = change.project
  const about = [
    project ? (projectId ? `Project: ${project} (${projectId})` : `Project: ${project}`) : projectId ? `Project: ${projectId}` : null,
    change.target ? `Kind: ${change.target}` : null,
    change.url ? `Address: ${change.url}` : null,
    change.state ? `Its build now: ${change.state}` : null,
    `Deployment: ${id}`,
    team ? `Team: ${team}` : null,
    `Vercel account: ${account}`,
  ].filter((line): line is string => line !== null)
  if (change.kind === 'vercel-promote') {
    return {
      plugin: 'Vercel',
      text: `Promote this deployment of ${named} to production on Vercel?`,
      action: `Promote a deployment to production on Vercel`,
      target: named,
      details: [...about, `The project’s production addresses will serve this deployment. It is not built again.`].join('\n'),
      allow: `Promote to production`,
      deny: `Leave production as it is`,
    }
  }
  if (change.kind === 'vercel-rollback') {
    return {
      plugin: 'Vercel',
      text: `Roll production of ${named} back to this deployment on Vercel?`,
      action: `Roll production back on Vercel`,
      target: named,
      details: [...about, `The project’s production addresses will serve this deployment again, at once.`,
        `After a rollback, Vercel keeps new pushes to the production branch out of production until a deployment is promoted.`].join('\n'),
      allow: `Roll production back`,
      deny: `Leave production as it is`,
    }
  }
  return {
    plugin: 'Vercel',
    text: `Cancel the build of ${named} on Vercel?`,
    action: `Cancel a deployment on Vercel`,
    target: named,
    details: [...about, `A cancelled build cannot be picked up again. It has to be deployed again.`].join('\n'),
    allow: `Cancel the build`,
    deny: `Leave it running`,
  }
}
