import React, { useState, type ReactNode } from 'react'
import { Bell } from 'lucide-react'
import type { NotificationTestResult } from '../../../../shared/desktopNotifications'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { Toggle } from '../../components/Toggle'
import { useDesktopNotifications } from '../../state/desktopNotifications'
import { SettingsGroup } from './SettingsGroup'
import './notificationSettings.css'

const TEST_ANSWERS: Record<NotificationTestResult, string> = {
  shown: 'Sent. If you did not see it, allow Sotto in System Settings → Notifications.',
  failed: 'macOS did not show it. Allow Sotto in System Settings → Notifications, then try again.',
  unsupported: 'This computer cannot show notifications.',
}

/** Settings → Application → Notifications (ADR-0117): shown only while the window shows notifications. */
export function NotificationSettings({ settings, onSave }: {
  readonly settings: Pick<AppSettings, 'notifyNeedsYou' | 'notifyFinished'>
  readonly onSave: (patch: SettingsPatch) => unknown
}): ReactNode {
  const bridge = useDesktopNotifications()
  const [testing, setTesting] = useState(false)
  const [answer, setAnswer] = useState('')
  if (bridge === undefined) return null

  const sendTest = async (): Promise<void> => {
    setTesting(true)
    setAnswer('')
    const result = await bridge.test().catch((): NotificationTestResult => 'failed')
    setAnswer(TEST_ANSWERS[result])
    setTesting(false)
  }

  return <SettingsGroup title="Notifications" icon={Bell} note="If nothing appears, allow Sotto in System Settings → Notifications.">
    <Toggle label="When a thread needs you" checked={settings.notifyNeedsYou} onCheckedChange={checked => void onSave({ notifyNeedsYou: checked })} description="A question or a permission is waiting for you." />
    <Toggle label="When a thread has finished everything" checked={settings.notifyFinished} onCheckedChange={checked => void onSave({ notifyFinished: checked })} description="Its turn has ended and nothing it started is still going." />
    <div className="notification-settings__test">
      <Button variant="secondary" disabled={testing} onClick={() => void sendTest()}>Send a test notification</Button>
      <p role="status" aria-live="polite">{answer}</p>
    </div>
  </SettingsGroup>
}
