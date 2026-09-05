import React, { type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

import type { SottoPlatform } from '../../../../shared/platform'
import { ShortcutKey } from '../../components/ShortcutKey'
import { platformCopy } from '../../platformCopy'

export interface HelpViewProps {
  readonly shortcut: string
  readonly platform: SottoPlatform
  /** The running version, when the main process has reported it. */
  readonly version?: string | undefined
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

export function HelpView({ shortcut, platform, version }: HelpViewProps): ReactNode {
  const copy = platformCopy(platform)
  const mac = platform === 'darwin'
  const modifier = mac ? '⌘' : 'Ctrl'

  const gettingStarted: Topic[] = [
    { title: 'Start and stop', body: <p>Press <ShortcutKey accelerator={shortcut} platform={platform} /> anywhere to begin, then press it again to finish. Press Escape to cancel an active recording without transcribing.</p> },
    { title: 'Shortcut conflicts', body: <p>If another application owns a shortcut, Sotto keeps your previous working shortcut active. Choose a different combination in Settings and apply it again.</p> },
    { title: 'Optional models', body: <p>Standard is included and works offline. Installing Multi-lingual contacts Hugging Face, which receives ordinary network metadata such as your IP address and request time. Audio and transcripts are not sent. Standard is English-only.</p> },
  ]
  const privacy: Topic[] = [
    { title: 'Offline privacy', body: <p>Speech and transcripts stay on this computer. Sotto has no account, analytics, cloud transcription, or per-use fee.</p> },
  ]
  const troubleshooting: Topic[] = [
    { title: 'Microphone access', body: <p>{copy.helpMicrophoneAccess}</p> },
    { title: 'Paste fallback', body: <p>{copy.helpPasteFallback}</p> },
    ...(copy.accessibilityHelp === null ? [] : [{ title: 'Paste permissions', body: <p>{copy.accessibilityHelp}</p> }]),
    { title: 'Reset safely', body: <p>Resetting settings reopens first-run setup, but does not remove models or clear transcript history. Use the separate History controls when you want to remove saved text.</p> },
  ]

  return (
    <div className="management-view help-view">
      <h1 className="tt-visually-hidden">Help</h1>
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
              <div><dt>Start or stop dictation</dt><dd><ShortcutKey accelerator={shortcut} platform={platform} /></dd></div>
              <div><dt>Cancel recording</dt><dd><kbd className="tt-kbd">Esc</kbd></dd></div>
              <div><dt>Search history</dt><dd><kbd className="tt-kbd">{modifier}</kbd><kbd className="tt-kbd">K</kbd></dd></div>
              <div><dt>Paste manually</dt><dd><kbd className="tt-kbd">{modifier}</kbd><kbd className="tt-kbd">V</kbd></dd></div>
            </dl>
          </section>
          <section className="tt-panel">
            <div className="tt-panel__header"><h2>About</h2></div>
            <p className="help-about">
              {version === undefined ? 'Sotto' : `Sotto ${version}`}, {mac ? 'macOS' : 'Windows'}. Free, with no account and no telemetry.
              <br />
              Speech and transcripts never leave this computer unless you turn on an optional network feature.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
