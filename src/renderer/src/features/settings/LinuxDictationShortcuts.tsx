import React, { type ReactNode } from 'react'

import type { DictationShortcutsChange, DictationShortcutsResult, HotkeyChangeResult } from '../../../../shared/contracts'
import type { DictationShortcutSet } from '../../../../shared/dictationShortcuts'
import { shortcutsBlocked } from '../../../../shared/omarchySetup'
import type { AppSettings } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { useOwlFeature } from '../../state/owlFeature'
import { OmarchySetupPanel, useOmarchySetup } from '../omarchy/OmarchySetup'
import { DictationShortcuts } from './DictationShortcuts'

export interface LinuxDictationShortcutsProps {
  readonly settings: Pick<AppSettings, 'hotkey' | 'pressShortcuts' | 'holdShortcuts'>
  readonly visible: boolean
  readonly onReplaceHotkey: (accelerator: string) => Promise<HotkeyChangeResult>
  readonly onReplaceDictationShortcuts?: ((change: DictationShortcutsChange) => Promise<DictationShortcutsResult>) | undefined
}

/**
 * Linux's shortcut rows: the same rows as macOS and Windows, saved as Hyprland bindings in the file Sotto's Omarchy
 * setup owns (ADR-0062, ADR-0094). Until Sotto's keys are set up, the rows say so and offer that setup.
 */
export function LinuxDictationShortcuts({ settings, visible, onReplaceHotkey, onReplaceDictationShortcuts }: LinuxDictationShortcutsProps): ReactNode {
  const omarchy = useOmarchySetup(visible)
  const owl = useOwlFeature('dictation-hold-shortcuts')
  const keys = omarchy.state?.pieces.keys
  // While the setup is unread, main answers a save itself.
  const blocked = keys === undefined ? null : shortcutsBlocked(keys)
  const conflicts = (omarchy.state?.keyConflicts.length ?? 0) > 0
  const offerSetup = keys !== undefined && !keys.owned && !conflicts &&
    (keys.status === 'missing' || keys.status === 'skipped' || keys.status === 'failed' && keys.retry === 'setup')
  const locked = blocked === null ? null : {
    message: conflicts && !keys?.owned ? `${blocked} Choose what to do with those keys under Omarchy, below.` : blocked,
    action: offerSetup
      ? <Button variant="secondary" disabled={omarchy.busy} onClick={() => void omarchy.command({ type: 'setup', pieces: ['keys'], keys: 'unconfirmed' })}>Set up the keys</Button>
      : undefined,
  }
  const bound: DictationShortcutSet = owl
    ? { press: [settings.hotkey, ...settings.pressShortcuts], hold: settings.holdShortcuts }
    : { press: [settings.hotkey], hold: settings.holdShortcuts.slice(0, 1) }
  return (
    <>
      <DictationShortcuts settings={settings} platform="linux" onReplaceHotkey={onReplaceHotkey} onReplaceDictationShortcuts={onReplaceDictationShortcuts} locked={locked} />
      <div className="settings-input-action"><OmarchySetupPanel controller={omarchy} shortcuts={bound} /></div>
    </>
  )
}
