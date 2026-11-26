/**
 * The part names a mod's look targets (ADR-0217): each main-window surface carries one as `data-part`, and these names
 * hold across Sotto's releases where class names do not. The guide main writes into the mods folder lists them, and
 * `modParts.test.ts` holds each one to an element in the renderer. A rename keeps the old name beside the new one for a
 * release, with its reason in the pull request.
 */
export const MOD_PARTS = [
  { name: 'window', says: 'The whole main window, under everything else.' },
  { name: 'strip', says: 'The thin strip along the top of the window, on the pages that show it. Threads has none; its sidebar holds its own links to the other rooms.' },
  { name: 'room-switch', says: 'The room switch in the strip (Dictate, Threads, Watcher and the rest), where the strip shows.' },
  { name: 'sidebar', says: 'The sidebar on the left of Threads and the other rooms that have one. data-mode says whose it is, such as "threads".' },
  { name: 'sidebar-row', says: 'One thread\'s row in the Threads sidebar. The open thread\'s row also has data-current.' },
  { name: 'thread', says: 'A thread\'s pane: its header, conversation and composer. Threads side by side have one pane each.' },
  { name: 'message', says: 'One message in a thread. data-author is "user" for yours and "agent" for a reply.' },
  { name: 'composer', says: 'The box you type a prompt in, with its model and effort chips and Send.' },
  { name: 'tools', says: 'The Tools pane beside a thread: Changes, Files, Browser, Terminal and the rest.' },
  { name: 'settings', says: 'The Settings page, its rail and the open page.' },
] as const satisfies readonly { readonly name: string; readonly says: string }[]

export type ModPart = (typeof MOD_PARTS)[number]['name']

/** `data-part={modPart('composer')}`: the attribute's value, checked against the list where it is written. */
export const modPart = (name: ModPart): ModPart => name
