import React, { type ReactNode } from 'react'
import { ClipboardCheck, Download, Keyboard, Mic, RotateCcw, ShieldCheck } from 'lucide-react'

import type { SottoPlatform } from '../../../../shared/platform'
import { Card } from '../../components/Card'
import { ShortcutKey } from '../../components/ShortcutKey'
import { platformCopy } from '../../platformCopy'

export interface HelpViewProps {
  readonly shortcut: string
  readonly platform: SottoPlatform
}

export function HelpView({ shortcut, platform }: HelpViewProps): ReactNode {
  const copy = platformCopy(platform)
  return (
    <div className="management-view help-view">
      <h1 className="tt-visually-hidden">Help</h1>
      <div className="help-grid">
        <Card><Keyboard aria-hidden="true" /><h2>Start and stop</h2><p>Press <ShortcutKey accelerator={shortcut} platform={platform} /> anywhere to begin, then press it again to finish. Press Escape to cancel an active recording without transcribing.</p></Card>
        <Card><Mic aria-hidden="true" /><h2>Microphone access</h2><p>{copy.helpMicrophoneAccess}</p></Card>
        <Card><Keyboard aria-hidden="true" /><h2>Shortcut conflicts</h2><p>If another application owns a shortcut, Sotto keeps your previous working shortcut active. Choose a different combination in Settings and apply it again.</p></Card>
        <Card><ShieldCheck aria-hidden="true" /><h2>Offline privacy</h2><p>Speech and transcripts stay on this computer. Sotto has no account, analytics, cloud transcription, or per-use fee.</p></Card>
        <Card><Download aria-hidden="true" /><h2>Optional models</h2><p>Standard is included and works offline. Installing Multi-lingual contacts Hugging Face, which receives ordinary network metadata such as your IP address and request time. Audio and transcripts are not sent. Standard is English-only.</p></Card>
        <Card><ClipboardCheck aria-hidden="true" /><h2>Paste fallback</h2><p>{copy.helpPasteFallback}</p></Card>
        {copy.accessibilityHelp === null ? null : <Card><ShieldCheck aria-hidden="true" /><h2>Paste permissions</h2><p>{copy.accessibilityHelp}</p></Card>}
        <Card><RotateCcw aria-hidden="true" /><h2>Reset safely</h2><p>Resetting settings reopens first-run setup, but does not remove models or clear transcript history. Use the separate History controls when you want to remove saved text.</p></Card>
      </div>
    </div>
  )
}
