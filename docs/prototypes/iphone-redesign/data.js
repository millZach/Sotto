// PROTOTYPE, throwaway. Shared content for the five iPhone redesign variants, so they differ only in design.
// The palettes are Sotto's six built-ins (src/shared/themes/palettes.ts), a subset of roles, light and dark.
window.SOTTO = (() => {
  const THEMES = {"sotto":{"label":"Sotto","light":{"canvas":"oklch(0.978 0.004 85)","surface":"oklch(0.99 0.003 85)","raised":"oklch(0.955 0.006 85)","overlay":"oklch(0.945 0.007 85)","ink":"oklch(0.235 0.014 75)","muted":"oklch(0.5 0.014 75)","border":"oklch(0.86 0.012 80)","accent":"oklch(0.53 0.095 186)","accent-ink":"oklch(0.99 0.003 85)","accent-surface":"oklch(0.92 0.03 186)","warning":"oklch(0.772406 0.172798 65.367)","warning-surface":"oklch(0.955 0.018 80)","danger":"oklch(0.637823 0.237287 25.436)","danger-surface":"oklch(0.94 0.02 25)","bubble":"oklch(0.93 0.012 85)","bubble-ink":"oklch(0.235 0.014 75)","code-bg":"oklch(0.96 0.005 85)","code-ink":"oklch(0.235 0.014 75)","placeholder":"oklch(0.535 0.015 78)"},"dark":{"canvas":"oklch(0.115 0.008 265)","surface":"oklch(0.145 0.008 265)","raised":"oklch(0.185 0.008 265)","overlay":"oklch(0.215 0.008 265)","ink":"oklch(0.985 0.005 280)","muted":"oklch(0.72 0.014 265)","border":"oklch(0.305 0.02 265)","accent":"oklch(0.714403 0.104089 183.092)","accent-ink":"oklch(0.16 0.012 190)","accent-surface":"oklch(0.32 0.05 185)","warning":"oklch(0.772406 0.172798 65.367)","warning-surface":"oklch(0.315 0.032 80)","danger":"oklch(0.655108 0.221148 23.473)","danger-surface":"oklch(0.29 0.04 20)","bubble":"oklch(0.205 0.014 265)","bubble-ink":"oklch(0.985 0.005 280)","code-bg":"oklch(0.155 0.008 265)","code-ink":"oklch(0.985 0.005 280)","placeholder":"oklch(0.675 0.012 270)"}},"hush":{"label":"Hush","light":{"canvas":"oklch(0.963318 0.003976 106.474)","surface":"oklch(0.948318 0.0048 162.302)","raised":"oklch(0.913318 0.0048 162.302)","overlay":"oklch(0.888318 0.0048 162.302)","ink":"oklch(0.199531 0.007316 164.145)","muted":"oklch(0.526634 0.00473 146.055)","border":"oklch(0.843318 0.005838 162.302)","accent":"oklch(0.501932 0.0278 162.302)","accent-ink":"oklch(0.990339 0.008411 325.64)","accent-surface":"oklch(0.883318 0.012232 162.302)","warning":"oklch(0.772406 0.172798 65.367)","warning-surface":"oklch(0.944923 0.021803 83.375)","danger":"oklch(0.637823 0.237287 25.436)","danger-surface":"oklch(0.92876 0.018377 25.654)","bubble":"oklch(0.863318 0.013344 162.302)","bubble-ink":"oklch(0.2 0.00695 162.302)","code-bg":"oklch(0.928318 0.00384 162.302)","code-ink":"oklch(0.199531 0.007316 164.145)","placeholder":"oklch(0.5017 0.006979 164.774)"},"dark":{"canvas":"oklch(0.219569 0.003601 164.707)","surface":"oklch(0.234569 0.0048 162.94)","raised":"oklch(0.269569 0.0048 162.94)","overlay":"oklch(0.294569 0.0048 162.94)","ink":"oklch(0.949753 0.007515 164.935)","muted":"oklch(0.636174 0.005706 164.907)","border":"oklch(0.379569 0.006419 162.94)","accent":"oklch(0.748851 0.030565 162.94)","accent-ink":"oklch(0.222003 0.03479 328.979)","accent-surface":"oklch(0.349569 0.013449 162.94)","warning":"oklch(0.772406 0.172798 65.367)","warning-surface":"oklch(0.316163 0.044594 80.423)","danger":"oklch(0.655108 0.221148 23.473)","danger-surface":"oklch(0.285543 0.04345 18.762)","bubble":"oklch(0.379569 0.014671 162.94)","bubble-ink":"oklch(0.95 0.007641 162.94)","code-bg":"oklch(0.254569 0.00384 162.94)","code-ink":"oklch(0.949753 0.007515 164.935)","placeholder":"oklch(0.64738 0.007788 162.634)"}},"linen":{"label":"Linen","light":{"canvas":"oklch(0.956283 0.014327 84.583)","surface":"oklch(0.941283 0.009703 71.67)","raised":"oklch(0.906283 0.009703 71.67)","overlay":"oklch(0.881283 0.009703 71.67)","ink":"oklch(0.199045 0.010119 67.19)","muted":"oklch(0.522279 0.011199 77.299)","border":"oklch(0.836283 0.015437 71.67)","accent":"oklch(0.509263 0.044106 71.67)","accent-ink":"oklch(0.990339 0.008411 325.64)","accent-surface":"oklch(0.876283 0.021832 71.67)","warning":"oklch(0.772406 0.172798 65.367)","warning-surface":"oklch(0.938684 0.031588 81.206)","danger":"oklch(0.637823 0.237287 25.436)","danger-surface":"oklch(0.922504 0.026012 42.989)","bubble":"oklch(0.856283 0.023817 71.67)","bubble-ink":"oklch(0.2 0.011026 71.67)","code-bg":"oklch(0.921283 0.007763 71.67)","code-ink":"oklch(0.199045 0.010119 67.19)","placeholder":"oklch(0.496687 0.009315 69.904)"},"dark":{"canvas":"oklch(0.219746 0.008934 75.148)","surface":"oklch(0.234746 0.010846 77.118)","raised":"oklch(0.269746 0.010846 77.118)","overlay":"oklch(0.294746 0.010846 77.118)","ink":"oklch(0.949363 0.013095 71.328)","muted":"oklch(0.636839 0.010914 72.491)","border":"oklch(0.379746 0.017254 77.118)","accent":"oklch(0.784819 0.054776 77.118)","accent-ink":"oklch(0.222003 0.03479 328.979)","accent-surface":"oklch(0.349746 0.027114 77.118)","warning":"oklch(0.772406 0.172798 65.367)","warning-surface":"oklch(0.317974 0.049959 75.505)","danger":"oklch(0.655108 0.221148 23.473)","danger-surface":"oklch(0.288101 0.050253 24.252)","bubble":"oklch(0.379746 0.029579 77.118)","bubble-ink":"oklch(0.95 0.013694 77.118)","code-bg":"oklch(0.254746 0.008677 77.118)","code-ink":"oklch(0.949363 0.013095 71.328)","placeholder":"oklch(0.647699 0.012258 73.997)"}},"nocturne":{"label":"Nocturne","light":{"canvas":"oklch(0.957005 0.006256 255.475)","surface":"oklch(0.942005 0.01091 253.266)","raised":"oklch(0.907005 0.01091 253.266)","overlay":"oklch(0.882005 0.01091 253.266)","ink":"oklch(0.201308 0.015141 248.584)","muted":"oklch(0.522352 0.010129 250.106)","border":"oklch(0.837005 0.017358 253.266)","accent":"oklch(0.452985 0.061992 253.266)","accent-ink":"oklch(0.990339 0.008411 325.64)","accent-surface":"oklch(0.877005 0.027277 253.266)","warning":"oklch(0.772406 0.172798 65.367)","warning-surface":"oklch(0.938873 0.01286 80.468)","danger":"oklch(0.637823 0.237287 25.436)","danger-surface":"oklch(0.922722 0.016148 355.623)","bubble":"oklch(0.857005 0.029756 253.266)","bubble-ink":"oklch(0.2 0.015498 253.266)","code-bg":"oklch(0.922005 0.008729 253.266)","code-ink":"oklch(0.201308 0.015141 248.584)","placeholder":"oklch(0.496988 0.013383 249.646)"},"dark":{"canvas":"oklch(0.199462 0.019758 262.023)","surface":"oklch(0.214462 0.010547 253.974)","raised":"oklch(0.249462 0.010547 253.974)","overlay":"oklch(0.274462 0.010547 253.974)","ink":"oklch(0.950198 0.013719 258.345)","muted":"oklch(0.625127 0.015 260.22)","border":"oklch(0.359462 0.01678 253.974)","accent":"oklch(0.720135 0.053267 253.974)","accent-ink":"oklch(0.222003 0.03479 328.979)","accent-surface":"oklch(0.329462 0.023438 253.974)","warning":"oklch(0.772406 0.172798 65.367)","warning-surface":"oklch(0.298048 0.033169 76.145)","danger":"oklch(0.655108 0.221148 23.473)","danger-surface":"oklch(0.267948 0.042217 357.742)","bubble":"oklch(0.359462 0.025568 253.974)","bubble-ink":"oklch(0.95 0.013317 253.974)","code-bg":"oklch(0.234462 0.008438 253.974)","code-ink":"oklch(0.950198 0.013719 258.345)","placeholder":"oklch(0.631529 0.012065 256.751)"}},"tropic":{"label":"Tropic","light":{"canvas":"oklch(0.962189 0.012534 149.249)","surface":"oklch(0.947189 0.025 155)","raised":"oklch(0.912189 0.025 155)","overlay":"oklch(0.887189 0.025 155)","ink":"oklch(0.200115 0.03454 4.639)","muted":"oklch(0.528612 0.011192 15.656)","border":"oklch(0.842189 0.025 155)","accent":"oklch(0.531301 0.201531 5.62)","accent-ink":"oklch(0.990339 0.008411 325.64)","accent-surface":"oklch(0.882189 0.035804 5.62)","warning":"oklch(0.772406 0.172798 65.367)","warning-surface":"oklch(0.943735 0.024815 105.276)","danger":"oklch(0.637823 0.237287 25.436)","danger-surface":"oklch(0.927344 0.01261 53.941)","bubble":"oklch(0.862189 0.042709 5.62)","bubble-ink":"oklch(0.2 0.035 5.62)","code-bg":"oklch(0.927189 0.025 155)","code-ink":"oklch(0.200115 0.03454 4.639)","placeholder":"oklch(0.500998 0.036767 3.456)"},"dark":{"canvas":"oklch(0.194797 0.030909 156.372)","surface":"oklch(0.209797 0.04 158)","raised":"oklch(0.244797 0.04 158)","overlay":"oklch(0.269797 0.04 158)","ink":"oklch(0.950595 0.02561 5.652)","muted":"oklch(0.625297 0.006353 54.03)","border":"oklch(0.354797 0.04 158)","accent":"oklch(0.72778 0.176858 5.966)","accent-ink":"oklch(0.222003 0.03479 328.979)","accent-surface":"oklch(0.324797 0.043772 160)","warning":"oklch(0.772406 0.172798 65.367)","warning-surface":"oklch(0.293431 0.050115 106.293)","danger":"oklch(0.655108 0.221148 23.473)","danger-surface":"oklch(0.258018 0.027387 45.213)","bubble":"oklch(0.354797 0.047752 160)","bubble-ink":"oklch(0.95 0.025908 5.966)","code-bg":"oklch(0.229797 0.04 158)","code-ink":"oklch(0.950595 0.02561 5.652)","placeholder":"oklch(0.632861 0.029417 5.006)"}},"citrine":{"label":"Citrine","light":{"canvas":"oklch(0.972257 0.008005 98.878)","surface":"oklch(0.957257 0.00621 91.871)","raised":"oklch(0.922257 0.00621 91.871)","overlay":"oklch(0.897257 0.00621 91.871)","ink":"oklch(0.201559 0.029562 92.844)","muted":"oklch(0.53302 0.018782 93.873)","border":"oklch(0.852257 0.009879 91.871)","accent":"oklch(0.552021 0.112909 91.871)","accent-ink":"oklch(0.990339 0.008411 325.64)","accent-surface":"oklch(0.892257 0.03726 91.871)","warning":"oklch(0.772406 0.172798 65.367)","warning-surface":"oklch(0.953265 0.025465 84.593)","danger":"oklch(0.637823 0.237287 25.436)","danger-surface":"oklch(0.937115 0.020221 35.549)","bubble":"oklch(0.872257 0.040647 91.871)","bubble-ink":"oklch(0.2 0.028227 91.871)","code-bg":"oklch(0.937257 0.004968 91.871)","code-ink":"oklch(0.201559 0.029562 92.844)","placeholder":"oklch(0.507797 0.026421 92.312)"},"dark":{"canvas":"oklch(0.181787 0.002007 106.597)","surface":"oklch(0.196787 0 0)","raised":"oklch(0.231787 0 0)","overlay":"oklch(0.256787 0 0)","ink":"oklch(0.95 0.034764 96.302)","muted":"oklch(0.616495 0.020933 96.634)","border":"oklch(0.341787 0 0)","accent":"oklch(0.861207 0.170546 96.512)","accent-ink":"oklch(0.222003 0.03479 328.979)","accent-surface":"oklch(0.311787 0.019352 96.512)","warning":"oklch(0.772406 0.172798 65.367)","warning-surface":"oklch(0.288678 0.045706 76.79)","danger":"oklch(0.655108 0.221148 23.473)","danger-surface":"oklch(0.258346 0.047311 19.613)","bubble":"oklch(0.341787 0.02119 96.512)","bubble-ink":"oklch(0.95 0.035 96.512)","code-bg":"oklch(0.216787 0 0)","code-ink":"oklch(0.95 0.034764 96.302)","placeholder":"oklch(0.618009 0.03531 96.564)"}}}

  /** Paints a theme onto an element as --canvas, --surface, --raised, --overlay, --ink, --muted, --border, --accent,
   *  --accent-ink, --accent-surface, --warning, --warning-surface, --danger, --danger-surface, --bubble, --bubble-ink,
   *  --code-bg, --code-ink, --placeholder. */
  function applyTheme(themeId = 'sotto', appearance = 'dark', el = document.documentElement) {
    const roles = (THEMES[themeId] || THEMES.sotto)[appearance]
    for (const [k, v] of Object.entries(roles)) el.style.setProperty(`--${k}`, v)
    el.dataset.appearance = appearance
    el.style.colorScheme = appearance
  }

  const computers = [
    { id: 'laptop', name: 'LAPTOP-RUSSH2J5', status: 'online', canAnswer: true },
    { id: 'forge', name: 'forge', status: 'online', canAnswer: true },
    { id: 'desktop', name: 'DESKTOP-8NPFSBM', status: 'unreachable', canAnswer: false },
  ]

  const providers = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build' }

  // state: needs-you | working | finished-unread | done | failed | settled
  const threads = [
    { id: 't1', title: 'Pick the drawer shortcut', provider: 'claude', computer: 'laptop', project: 'Talk to Text Application', state: 'needs-you', ago: '1m',
      line: 'Asks: which shortcut should open the terminal drawer?', branch: 'feat/frosted-window-and-pane-terminal' },
    { id: 't2', title: 'Allow npm ci in the new-thread-defaults worktree', provider: 'codex', computer: 'laptop', project: 'Talk to Text Application', state: 'needs-you', ago: '4m',
      line: 'Wants to run npm ci', command: 'npm ci', branch: 'fix/new-thread-defaults' },
    { id: 't3', title: 'Transparent theme and bottom-third project terminal', provider: 'claude', computer: 'laptop', project: 'Talk to Text Application', state: 'working', ago: '2m',
      line: 'Running npm test -- terminalDrawer.test.ts', started: '14m', branch: 'feat/frosted-window-and-pane-terminal', pr: 721 },
    { id: 't4', title: 'Fix the Grok connector reconnect loop', provider: 'grok', computer: 'forge', project: 'Fleet', state: 'working', ago: 'now',
      line: 'Editing src/connectors/grok.ts', started: '3m', branch: 'sotto/fix-grok-connector-bug' },
    { id: 't5', title: 'Let the iPhone send photos with a reply', provider: 'codex', computer: 'laptop', project: 'Talk to Text Application', state: 'finished-unread', ago: '18m',
      line: 'Finished: PR #719 merged into main', branch: 'feat/iphone-photos', pr: 719 },
    { id: 't6', title: 'Sidebar folders start closed', provider: 'claude', computer: 'laptop', project: 'Talk to Text Application', state: 'done', ago: '1h',
      line: 'Done: 3 files changed', branch: 'fix/sidebar-folders-start-closed' },
    { id: 't7', title: 'Release 0.1.28 notes', provider: 'claude', computer: 'laptop', project: 'Talk to Text Application', state: 'failed', ago: '3h',
      line: 'Stopped: notices:verify failed' },
    { id: 't8', title: 'Blender scene for the launch video', provider: 'codex', computer: 'forge', project: 'Launch video', state: 'done', ago: 'Yesterday',
      line: 'Done: rendered 4 shots' },
    { id: 't9', title: 'Prune old thread worktrees', provider: 'grok', computer: 'desktop', project: 'Talk to Text Application', state: 'settled', ago: '3d',
      line: 'Settled' },
  ]

  // The open thread (t3): a real review reply from that thread, with Markdown as the agent wrote it.
  const messages = [
    { role: 'user', text: 'Review the frosted window branch against the spec and tell me what’s off.' },
    { role: 'assistant', text: `**Not asked for**
- **Remembered state:** open state and height are remembered per thread across restarts.
- **The shortcut itself:** the spec named no key. The code comment calls Ctrl+\` "T3's own", and the reviewer recalls T3 uses Mod+J (unverified). Ctrl+\` is also blocked in the Tools and Terminal-mode terminals.
- **Reduce transparency:** the frost follows the system's reduce-transparency setting.

**Implemented but looks wrong**
1. **Tooltips:** they always say "(Ctrl+\`)", even when dictation owns that chord and the shortcut is off.
2. **"Whole room frosted":** the prototype had the terminal, bubbles and composer partly see-through. Here the drawer is solid, so under frost the bottom third is an opaque block.
3. **Button order:** Terminal now comes after Tools, the reverse of T3 and the prototype. That's documented, and minor.

The check I ran:

\`\`\`sh
npm test -- tests/unit/renderer/terminalDrawer.test.ts
\`\`\`` },
    { role: 'user', text: 'Fix the tooltips first, then the drawer chord.' },
    { role: 'assistant', text: 'Still working through the review fixes. Now the terminal store and view: the pass-through for the drawer’s chord, and see-through colours under frost.' },
  ]

  // kind: command | file-change | tool | reasoning | plan ; status: running | done | failed
  const activity = [
    { kind: 'reasoning', title: 'Thought for 12s', status: 'done' },
    { kind: 'tool', title: 'Read', subject: 'src/renderer/src/agents/TerminalDrawer.tsx', status: 'done', duration: '0.2s' },
    { kind: 'file-change', title: 'Edited', subject: 'src/renderer/src/agents/terminalTooltips.ts', status: 'done', added: 18, removed: 6 },
    { kind: 'file-change', title: 'Edited', subject: 'src/renderer/src/agents/TerminalDrawer.tsx', status: 'done', added: 41, removed: 12 },
    { kind: 'command', title: 'Ran', subject: 'npm run typecheck', status: 'done', duration: '38s' },
    { kind: 'command', title: 'Running', subject: 'npm test -- tests/unit/renderer/terminalDrawer.test.ts', status: 'running' },
  ]

  // What the GitHub side of the open thread looks like (for a hint in the thread; the full surface is a later prototype).
  const git = { branch: 'feat/frosted-window-and-pane-terminal', base: 'main', ahead: 4, behind: 0, files: 7, added: 212, removed: 48,
    pr: { number: 721, title: 'Let the window frost and put a terminal in the bottom third', state: 'draft', checks: { passed: 3, total: 4, running: 1 } } }

  // A question waiting in thread t1.
  const question = { thread: 't1', text: 'Which shortcut should open the terminal drawer?', options: [
    { id: 'j', label: 'Ctrl+J', description: 'T3 Code’s own. Free on Windows; dictation doesn’t use it.' },
    { id: 'tick', label: 'Ctrl+`', description: 'What the branch uses now. Clashes when dictation holds it.' },
    { id: 'none', label: 'No shortcut', description: 'Open it from the Terminal button only.' },
  ], allowFreeText: true }

  // A permission waiting in thread t2.
  const permission = { thread: 't2', command: 'npm ci', cwd: 'C:\\Users\\zache\\AppData\\Roaming\\sotto\\thread-worktrees\\92bc4282', choices: [
    { id: 'once', label: 'Allow once', kind: 'allow-once' },
    { id: 'always', label: 'Always allow npm ci', kind: 'allow-always' },
    { id: 'deny', label: 'Deny', kind: 'deny' },
  ] }

  const newThread = {
    projects: [
      { computer: 'laptop', name: 'Talk to Text Application', path: 'D:\\Talk to Text Application', threads: 14 },
      { computer: 'laptop', name: 'Fleet', path: 'D:\\Fleet', threads: 3 },
      { computer: 'forge', name: 'Fleet', path: '/home/zach/fleet', threads: 2 },
      { computer: 'forge', name: 'Launch video', path: '/home/zach/launch-video', threads: 1 },
    ],
    models: [
      { id: 'opus', label: 'Claude Code · Opus 5.5', provider: 'claude' },
      { id: 'sonnet', label: 'Claude Code · Sonnet 5.5', provider: 'claude' },
      { id: 'gpt', label: 'Codex · GPT-6.1', provider: 'codex' },
      { id: 'grok', label: 'Grok Build · Grok 5', provider: 'grok' },
    ],
    efforts: ['Low', 'Medium', 'High', 'Max'],
    permissions: [
      { id: 'ask', label: 'Ask before actions' },
      { id: 'edits', label: 'Allow edits, ask for commands' },
      { id: 'full', label: 'Full access' },
    ],
    workingCopy: [
      { id: 'shared', label: 'Shared folder', description: 'Works in the project’s own checkout.' },
      { id: 'worktree', label: 'New worktree', description: 'Its own folder on a new sotto/ branch, from main.' },
    ],
  }

  const settings = {
    appearance: ['Dark', 'Light', 'System'],
    textSizes: ['Smaller', 'Default', 'Large', 'Larger', 'Largest'],
    density: ['Comfortable', 'Compact'],
    notifications: [
      { id: 'needs', label: 'When a thread needs you', description: 'A question or permission is waiting.', on: true },
      { id: 'finished', label: 'When a thread finishes', description: 'Its turn ended while you weren’t looking.', on: true },
      { id: 'failed', label: 'When a thread stops with an error', on: false },
      { id: 'sound', label: 'Play a sound', on: false },
    ],
    notificationNote: 'Alerts arrive while Sotto is open or was in the background recently.',
  }

  // ---- Markdown: blocks first, then inline inside each block, the way the desktop's renderer treats a message. ----
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  function inline(text) {
    // A key chord such as Ctrl+` names the backtick key; it never opens a code span. Set chords aside before pairing.
    const chords = []
    const s = text.replace(/\b(?:Ctrl|Cmd|Mod|Alt|Shift|Option)\+`/g, m => `\u0001${chords.push(m) - 1}\u0002`)
    return inlineSpans(s).replace(/\u0001(\d+)\u0002/g, (_, n) => `<kbd>${esc(chords[n])}</kbd>`)
  }
  function inlineSpans(s) {
    let out = '', i = 0
    while (i < s.length) {
      if (s[i] === '`') {
        let n = 1; while (s[i + n] === '`') n++
        const fence = '`'.repeat(n); let j = s.indexOf(fence, i + n)
        while (j !== -1 && (s[j + n] === '`' || s[j - 1] === '`')) j = s.indexOf(fence, j + 1)
        if (j !== -1) { out += '<code>' + esc(s.slice(i + n, j)) + '</code>'; i = j + n; continue }
        out += esc(fence); i += n; continue
      }
      let k = s.indexOf('`', i); if (k === -1) k = s.length
      out += esc(s.slice(i, k)).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      i = k
    }
    return out
  }
  /** Markdown to HTML: headings, lists, fenced code, paragraphs; a paragraph that is only bold reads as a heading. */
  function markdown(src) {
    const lines = src.split('\n'); let html = '', i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (/^```/.test(line)) { const lang = line.slice(3).trim(); let j = i + 1; const body = []; while (j < lines.length && !/^```/.test(lines[j])) body.push(lines[j++]); html += `<pre data-lang="${esc(lang)}"><code>${esc(body.join('\n'))}</code></pre>`; i = j + 1; continue }
      if (/^#{1,6} /.test(line)) { html += `<h4>${inline(line.replace(/^#+ /, ''))}</h4>`; i++; continue }
      if (/^\*\*[^*]+\*\*$/.test(line.trim())) { html += `<h4>${inline(line.trim().slice(2, -2))}</h4>`; i++; continue }
      if (/^[-*] /.test(line)) { html += '<ul>'; while (i < lines.length && /^[-*] /.test(lines[i])) html += `<li>${inline(lines[i++].slice(2))}</li>`; html += '</ul>'; continue }
      if (/^\d+\. /.test(line)) { html += '<ol>'; while (i < lines.length && /^\d+\. /.test(lines[i])) html += `<li>${inline(lines[i++].replace(/^\d+\. /, ''))}</li>`; html += '</ol>'; continue }
      if (!line.trim()) { i++; continue }
      const para = []; while (i < lines.length && lines[i].trim() && !/^(```|#{1,6} |[-*] |\d+\. )/.test(lines[i])) para.push(lines[i++])
      html += `<p>${inline(para.join(' '))}</p>`
    }
    return html
  }

  return { THEMES, applyTheme, computers, providers, threads, messages, activity, git, question, permission, newThread, settings, markdown, esc }
})()
