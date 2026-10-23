import React, { type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'

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
  const { t } = useLingui()
  const copy = platformCopy(platform)
  const name = releaseTrackName(releaseTrack)
  // An Owl version is one word on the line, never broken at its hyphen; a stable version has none to break at.
  const about = version === undefined ? name
    : releaseTrack === 'owl' ? <>{name} <span className="help-about__version">{version}</span></> : `${name} ${version}`
  const mac = platform === 'darwin'
  const linux = platform === 'linux'
  const modifier = mac ? '⌘' : 'Ctrl'
  const linuxKeys = linuxKeyWords({ hotkey: shortcut, holdShortcuts: holdShortcut === undefined ? [] : [holdShortcut] })
  const press = linuxKeys.press
  const hold = linuxKeys.hold
  const linuxStart = hold === undefined
    ? t`Press ${press} to start and stop, once Sotto’s compositor bindings are installed in Hyprland. The dictation button works too. To stop without transcribing, press Cancel on the floating widget.`
    : t`Hold ${hold} to talk, or press ${press} to start and stop, once Sotto’s compositor bindings are installed in Hyprland. The dictation button works too. To stop without transcribing, press Cancel on the floating widget.`
  const system = mac ? 'macOS' : linux ? 'Linux' : 'Windows'

  const gettingStarted: Topic[] = [
    { title: t`Start and stop`, body: linux
      ? <p>{linuxStart}</p>
      : <p><Trans>Press <ShortcutKey accelerator={shortcut} platform={platform} /> anywhere to begin, then press it again to finish. Press Escape to cancel an active recording without transcribing.</Trans></p> },
    linux
      ? { title: t`Global shortcut`, body: <p>{copy.settingsGlobalShortcutDescription}</p> }
      : { title: t`Shortcut conflicts`, body: <p><Trans>If another application owns a shortcut, Sotto keeps your previous working shortcut active. In Settings › Dictation, press the shortcut, then hold the keys you want instead and let go.</Trans></p> },
    { title: t`Transcription`, body: <p><Trans>A speech model transcribes your speech on this computer. Choose it in Settings → Dictation, under Speech model: Parakeet Ultra, by Moondream, which setup suggests, or Parakeet v3 or v2, by NVIDIA, each downloaded once (about 670 MB) when you choose it, and on an Apple silicon Mac the Core ML models FluidAudio keeps are offered too. Settings shows whether the chosen one is ready.</Trans></p> },
  ]
  const privacy: Topic[] = [
    { title: t`Privacy`, body: <p><Trans>Audio you dictate never leaves this computer. AI cleanup, when it is on, sends the transcript text to OpenRouter on your key. Agent prompts go to the connected coding provider. Transcripts and the numbers the Dictate room counts stay on this computer.</Trans></p> },
  ]
  const troubleshooting: Topic[] = [
    { title: t`Microphone access`, body: <p>{copy.helpMicrophoneAccess}</p> },
    { title: t`Paste fallback`, body: <p>{copy.helpPasteFallback}</p> },
    ...(copy.accessibilityHelp === null ? [] : [{ title: t`Paste permissions`, body: <p>{copy.accessibilityHelp}</p> }]),
    { title: t`Reset safely`, body: <p><Trans>Resetting settings reopens first-run setup, but does not clear transcript history. Delete a transcript, or use Clear history in the Dictate room or in Settings, when you want to remove saved text.</Trans></p> },
  ]

  return (
    <div className="management-view help-view">
      <h1><Trans>Help</Trans></h1>
      <div className="help-grid">
        <div className="tt-panel help-topics">
          <p className="tt-instrument help-topics__group"><Trans>Getting started</Trans></p>
          <TopicList topics={gettingStarted} />
          <p className="tt-instrument help-topics__group"><Trans>Privacy</Trans></p>
          <TopicList topics={privacy} />
          <p className="tt-instrument help-topics__group"><Trans>Troubleshooting</Trans></p>
          <TopicList topics={troubleshooting} />
        </div>
        <div className="help-aside">
          <section className="tt-panel">
            <div className="tt-panel__header"><h2><Trans>Keyboard</Trans></h2></div>
            <dl className="help-keys">
              {linux ? null : <div><dt><Trans>Start or stop dictation</Trans></dt><dd><ShortcutKey accelerator={shortcut} platform={platform} /></dd></div>}
              {!linux && <div><dt><Trans>Cancel recording</Trans></dt><dd><kbd className="tt-kbd">Esc</kbd></dd></div>}
              <div><dt><Trans>Search transcripts</Trans></dt><dd><kbd className="tt-kbd">{modifier}</kbd><kbd className="tt-kbd">K</kbd></dd></div>
              <div><dt><Trans>Paste manually</Trans></dt><dd><kbd className="tt-kbd">{linux ? 'Super' : modifier}</kbd><kbd className="tt-kbd">V</kbd></dd></div>
            </dl>
          </section>
          <section className="tt-panel">
            <div className="tt-panel__header"><h2><Trans comment="Heading over the running version and what Sotto sends where">About</Trans></h2></div>
            <p className="help-about">
              <Trans>
                {about}, {system}. No account with Sotto and no telemetry.
                <br />
                Transcription runs on this computer; AI cleanup uses your OpenRouter account.
              </Trans>
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
