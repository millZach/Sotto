import React, { type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

import type { SottoPlatform } from '../../../../shared/platform'
import { releaseTrackName, type ReleaseTrack } from '../../../../shared/releaseTrack'
import { ShortcutKey } from '../../components/ShortcutKey'
import { platformCopy } from '../../platformCopy'
import { linuxKeyWords } from '../omarchy/linuxKeys'

export interface HelpViewProps {
  readonly shortcut: string
  /** Linux: the first hold shortcut, which Sotto binds in Hyprland beside the press shortcut. */
  readonly holdShortcut?: string | undefined
  readonly platform: SottoPlatform
  /** The running version, when the main process has reported it. */
  readonly version?: string | undefined
  /** The running build's track, which names it in the About line; stable when unknown. */
  readonly releaseTrack?: ReleaseTrack | undefined
}

interface Topic {
  readonly title: string
  readonly body: ReactNode
}

function TopicList({ topics }: { readonly topics: readonly Topic[] }): ReactNode {
  return topics.map((topic) => (
    <details className="help-topic" key={topic.title} open>
      <summary>
        <h2>{topic.title}</h2>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      {topic.body}
    </details>
  ))
}

export function HelpView({ shortcut, holdShortcut, platform, version, releaseTrack = 'stable' }: HelpViewProps): ReactNode {
  const copy = platformCopy(platform)
  const name = releaseTrackName(releaseTrack)
  // An Owl version is one word on the line, never broken at its hyphen; a stable version has none to break at.
  const about = version === undefined ? name
    : releaseTrack === 'owl' ? <>{name} <span className="help-about__version">{version}</span></> : `${name} ${version}`
  const mac = platform === 'darwin'
  const linux = platform === 'linux'
  const modifier = mac ? '⌘' : 'Ctrl'
  const linuxKeys = linuxKeyWords({ hotkey: shortcut, holdShortcuts: holdShortcut === undefined ? [] : [holdShortcut] })
  const linuxStart = linuxKeys.hold === undefined ? `Press ${linuxKeys.press} to start and stop` : `Hold ${linuxKeys.hold} to talk, or press ${linuxKeys.press} to start and stop`

  const gettingStarted: Topic[] = [
    { title: 'Start and stop', body: linux
      ? <p>{linuxStart}, once Sotto’s compositor bindings are installed in Hyprland. The dictation button works too. To stop without transcribing, press Cancel on the floating widget.</p>
      : <p>Press <ShortcutKey accelerator={shortcut} platform={platform} /> anywhere to begin, then press it again to finish. Press Escape to cancel an active recording without transcribing.</p> },
    linux
      ? { title: 'Global shortcut', body: <p>{copy.settingsGlobalShortcutDescription}</p> }
      : { title: 'Shortcut conflicts', body: <p>If another application owns a shortcut, Sotto keeps your previous working shortcut active. In Settings › Dictation, press the shortcut, then hold the keys you want instead and let go.</p> },
    { title: 'Transcription', body: <p>A speech model transcribes your speech on this computer. Choose it in Settings → Dictation, under Speech model: Parakeet Ultra, by Moondream, which setup suggests, or Parakeet v3 or v2, by NVIDIA, each downloaded once (about 670 MB) when you choose it, and on an Apple silicon Mac the Core ML models FluidAudio keeps are offered too. Settings shows whether the chosen one is ready.</p> },
  ]
  const privacy: Topic[] = [
    { title: 'Privacy', body: <p>Audio you dictate never leaves this computer. AI cleanup, when it is on, sends the transcript text to OpenRouter on your key. Agent prompts go to the connected coding provider. Transcripts and the numbers the Dictate room counts stay on this computer.</p> },
  ]
  const troubleshooting: Topic[] = [
    { title: 'Microphone access', body: <p>{copy.helpMicrophoneAccess}</p> },
    { title: 'Paste fallback', body: <p>{copy.helpPasteFallback}</p> },
    ...(copy.accessibilityHelp === null ? [] : [{ title: 'Paste permissions', body: <p>{copy.accessibilityHelp}</p> }]),
    { title: 'Reset safely', body: <p>Resetting settings reopens first-run setup, but does not clear transcript history. Delete a transcript, or use Clear history in the Dictate room or in Settings, when you want to remove saved text.</p> },
  ]

  return (
    <div className="management-view help-view">
      <h1>Help</h1>
      <div className="help-grid">
        <div className="tt-panel help-topics">
          <p className="tt-instrument help-topics__group">Getting started</p>
          <TopicList topics={gettingStarted} />
          <p className="tt-instrument help-topics__group">Privacy</p>
          <TopicList topics={privacy} />
          <p className="tt-instrument help-topics__group">Troubleshooting</p>
          <TopicList topics={troubleshooting} />
        </div>
        <div className="help-aside">
          <section className="tt-panel">
            <div className="tt-panel__header"><h2>Keyboard</h2></div>
            <dl className="help-keys">
              {linux ? null : <div><dt>Start or stop dictation</dt><dd><ShortcutKey accelerator={shortcut} platform={platform} /></dd></div>}
              {!linux && <div><dt>Cancel recording</dt><dd><kbd className="tt-kbd">Esc</kbd></dd></div>}
              <div><dt>Search transcripts</dt><dd><kbd className="tt-kbd">{modifier}</kbd><kbd className="tt-kbd">K</kbd></dd></div>
              <div><dt>Paste manually</dt><dd><kbd className="tt-kbd">{linux ? 'Super' : modifier}</kbd><kbd className="tt-kbd">V</kbd></dd></div>
            </dl>
          </section>
          <section className="tt-panel">
            <div className="tt-panel__header"><h2>About</h2></div>
            <p className="help-about">
              {about}, {mac ? 'macOS' : linux ? 'Linux' : 'Windows'}. No account with Sotto and no telemetry.
              <br />
              Transcription runs on this computer; AI cleanup uses your OpenRouter account.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
