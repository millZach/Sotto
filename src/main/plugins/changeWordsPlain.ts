import { dollarFigure, dollarLimit, type PluginChange } from '../../shared/plugins'
import type { PluginChangeCard } from './pendingChanges'

type GitHubChange = Extract<PluginChange, { readonly kind: 'github-comment' | 'github-open-issue' | 'github-close-issue' | 'github-reopen-issue' }>
type VercelChange = Extract<PluginChange, { readonly kind: 'vercel-cancel' | 'vercel-promote' | 'vercel-rollback' }>
type MailRead = Extract<PluginChange, { readonly kind: 'mail-read' }>
type MailSend = Extract<PluginChange, { readonly kind: 'mail-send' }>
type MeshyModel = Extract<PluginChange, { readonly kind: 'meshy-model' }>
type ElevenLabsSound = Extract<PluginChange, { readonly kind: 'elevenlabs-sound' }>

/**
 * A plugin change's card in English, for a headless host (ADR-0205, decision 7). A host has no interface language and
 * cannot load Lingui (ADR-0123), so what it sends to be shown is its English, as its refusals are, until the host
 * protocol carries a change a client can word for itself. `changeWords.ts` is the desktop's, in the interface
 * language; the two say the same thing, and `changeWordsPlain.test.ts` holds them to it, so a sentence changed in one
 * is changed in the other.
 */
export function wordPluginChangeInEnglish(change: PluginChange): PluginChangeCard {
  if (change.kind === 'mail-read') return wordMailRead(change)
  if (change.kind === 'mail-send') return wordMailSend(change)
  if (change.kind === 'meshy-model') return wordMeshyModel(change)
  if (change.kind === 'elevenlabs-sound') return wordElevenLabsSound(change)
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
  // Watcher's own card (#2565, Zach's pick on November 13, 2026): it names Watcher, which is never settled, so the
  // grant lasts until the user stops it, from the ··· menu in Watcher's strip.
  if (change.watcher) return {
    plugin,
    text: provider ? `Let Watcher read the ${plugin} account ${named}? What it reads goes to ${provider}.`
      : `Let Watcher read the ${plugin} account ${named}? What it reads goes to Watcher’s provider.`,
    action: `Read ${plugin} mail`,
    target: named,
    details: [
      'Watcher can search this account’s mail and read its messages, until you stop it.',
      provider ? `What it reads goes to ${provider}, as everything Watcher reads does.` : `What it reads goes to Watcher’s provider, as everything Watcher reads does.`,
      'It cannot send, move or delete mail. Every thread asks for itself.',
    ].join('\n'),
    allow: 'Let Watcher read it',
    deny: 'Don’t allow',
  }
  return {
    plugin,
    text: provider ? `Let this thread read the ${plugin} account ${named}? What it reads goes to ${provider}.`
      : `Let this thread read the ${plugin} account ${named}? What it reads goes to this thread’s provider.`,
    action: `Read ${plugin} mail`,
    target: named,
    details: [
      'This thread can search this account’s mail and read its messages, until you stop it or the thread is settled.',
      provider ? `What it reads goes to ${provider}, as everything a thread reads does.` : `What it reads goes to this thread’s provider, as everything a thread reads does.`,
      'This does not let it send: each email it wants to send asks you first. It cannot move or delete mail. Every other thread asks for itself.',
    ].join('\n'),
    allow: 'Let this thread read it',
    deny: 'Don’t allow',
  }
}

/**
 * One email from a mail account (slice 9). It asks every time: a mail grant never covers it. The card names the
 * account as the user named it, not by its address (Zach's pick on November 14, 2026), and shows everything that is
 * sent: who it goes to, the Bcc too, the subject and the whole text.
 */
function wordMailSend(change: MailSend): PluginChangeCard {
  const { plugin } = change
  const named = change.account
  const everyone = [...change.to, ...change.cc, ...change.bcc]
  const first = change.to.slice(0, 2).join(', ')
  const more = everyone.length - Math.min(change.to.length, 2)
  const who = more > 0 ? `${first} and ${more} more` : first
  const to = change.to.join(', '), cc = change.cc.join(', '), bcc = change.bcc.join(', ')
  const subject = change.subject
  return {
    plugin,
    text: `Send this email from the ${plugin} account ${named} to ${who}?`,
    action: `Send an email as ${named}`,
    target: who,
    details: [
      `To: ${to}`,
      ...(cc ? [`Cc: ${cc}`] : []),
      ...(bcc ? [`Bcc: ${bcc}`] : []),
      `Subject: ${subject}`,
      '',
      change.text,
    ].join('\n'),
    allow: 'Send the email',
    deny: 'Don’t send it',
  }
}

/**
 * One 3D model with Meshy (ADR-0141): what goes to Meshy, the words or the photo, that Meshy may train on it, and what
 * it costs beside the month's credits so far. The card and its buttons are the ones Zach chose in the mock-up
 * `docs/prototypes/meshy-models-prototype.html`: Make the model and Deny.
 */
function wordMeshyModel(change: MeshyModel): PluginChangeCard {
  const { name, folder } = change
  const named = change.account
  const credits = change.credits.toLocaleString('en-US'), month = change.monthCredits.toLocaleString('en-US'), limit = change.monthlyLimit.toLocaleString('en-US')
  const words = change.words ?? '', photo = change.photo ?? ''
  return {
    plugin: 'Meshy',
    text: `Make the 3D model ${name} with the Meshy account ${named}? About ${credits} credits.`,
    action: `Make a 3D model with Meshy`,
    target: name,
    details: [
      change.photo !== undefined ? `Sends Meshy the photo ${photo} from this thread’s folder, redrawn without its location and camera details.` : `Sends Meshy these words: “${words}”`,
      `Meshy may use what it is sent, and the 3D models it makes, to train its own models.`,
      `About ${credits} credits on the Meshy account ${named}; ${month} of its ${limit} credits used this month.`,
      `The files go to ${folder} in this thread’s folder.`,
    ].join('\n'),
    allow: `Make the model`,
    deny: `Deny`,
  }
}

/**
 * One sound with ElevenLabs (ADR-0205; the plugins plan's slice 12): everything that goes to ElevenLabs, the words and
 * for speech the voice, that ElevenLabs may train on it, and what it costs at the published prices beside what the
 * account spent this month. The words and buttons are the ones Zach chose in the mock-up on #2498 (the tag
 * prototype/elevenlabs): Make the sound and Deny. Nothing plays on its own (ADR-0068).
 */
function wordElevenLabsSound(change: ElevenLabsSound): PluginChangeCard {
  const { name, folder, words } = change
  const named = change.account
  const money = (amount: number): string => dollarFigure(amount) ?? `under $0.01`
  const cost = money(change.cost), spent = money(change.monthSpent), limit = dollarLimit(change.monthlyLimit)
  const seconds = (change.seconds ?? 0).toLocaleString('en-US')
  const voice = change.voice ?? ''
  const characters = words.length.toLocaleString('en-US')
  const target = change.sound === 'speech' ? `Speech · ${name}` : change.sound === 'effect' ? `Sound effect · ${name}` : `Music · ${name}`
  const what = change.sound === 'speech' ? `Speaks these words in the voice ${voice} (${characters} characters):`
    : change.sound === 'effect'
      ? change.seconds === undefined ? `Makes a sound effect, as long as ElevenLabs judges, up to 30 seconds, from these words:`
        : change.seconds === 1 ? `Makes a sound effect, 1 second long, from these words:` : `Makes a sound effect, ${seconds} seconds long, from these words:`
      : change.instrumental ? `Makes music, ${seconds} seconds long, with no singing, from these words:` : `Makes music, ${seconds} seconds long, from these words:`
  return {
    plugin: 'ElevenLabs',
    text: `Make the sound ${name} with the ElevenLabs account ${named}? About ${cost}.`,
    action: `Make a sound with ElevenLabs`,
    target,
    details: [
      what,
      `“${words}”`,
      `ElevenLabs may use what it is sent to train its own models, unless that is turned off in the ElevenLabs account.`,
      `About ${cost} on the ElevenLabs account ${named}; ${spent} of its ${limit} used this month.`,
      `The file goes to ${folder} in this thread’s folder. Nothing plays on its own.`,
    ].join('\n'),
    allow: `Make the sound`,
    deny: `Deny`,
  }
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
