import React, { type ReactNode } from 'react'
import { ClipboardCheck, Download, Keyboard, Mic, RotateCcw, ShieldCheck } from 'lucide-react'

import { Card } from '../../components/Card'
import { ShortcutKey } from '../../components/ShortcutKey'

export interface HelpViewProps { readonly shortcut: string }

export function HelpView({ shortcut }: HelpViewProps): ReactNode {
  return (
    <div className="management-view help-view">
      <header className="management-view__header"><div><p className="management-eyebrow">Guides and troubleshooting</p><h1>Help</h1><p>Everything you need to dictate confidently.</p></div></header>
      <div className="help-grid">
        <Card><Keyboard aria-hidden="true" /><h2>Start and stop</h2><p>Press <ShortcutKey accelerator={shortcut} /> anywhere to begin, then press it again to finish. Press Escape to cancel an active recording without transcribing.</p></Card>
        <Card><Mic aria-hidden="true" /><h2>Microphone access</h2><p>If recording cannot start, open Windows Settings, then Privacy or Privacy &amp; security, then Microphone, and allow desktop apps. Choose an available input in TalkType Settings.</p></Card>
        <Card><Keyboard aria-hidden="true" /><h2>Shortcut conflicts</h2><p>If another application owns a shortcut, TalkType keeps your previous working shortcut active. Choose a different combination in Settings and apply it again.</p></Card>
        <Card><ShieldCheck aria-hidden="true" /><h2>Offline privacy</h2><p>Speech and transcripts stay on this computer. TalkType has no account, analytics, cloud transcription, or per-use fee.</p></Card>
        <Card><Download aria-hidden="true" /><h2>Optional models</h2><p>Balanced is included and works offline. Installing Fast or Accurate contacts Hugging Face, which receives ordinary network metadata such as your IP address and request time. Audio and transcripts are not sent.</p></Card>
        <Card><ClipboardCheck aria-hidden="true" /><h2>Paste fallback</h2><p>TalkType is clipboard first: successful text is always copied. Automatic paste may be blocked in elevated, protected, or password fields and applications with custom input handling. When that happens, paste manually with Ctrl+V.</p></Card>
        <Card><RotateCcw aria-hidden="true" /><h2>Reset safely</h2><p>Resetting settings reopens first-run setup, but does not remove models or clear transcript history. Use the separate History controls when you want to remove saved text.</p></Card>
      </div>
    </div>
  )
}
