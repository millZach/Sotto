import React, { useState, type ReactNode } from 'react'
import { Bell } from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { NotificationTestResult } from '../../../../shared/desktopNotifications'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { Toggle } from '../../components/Toggle'
import { useDesktopNotifications } from '../../state/desktopNotifications'
import { SettingsGroup } from './SettingsGroup'
import './notificationSettings.css'

const TEST_ANSWERS: Record<NotificationTestResult, MessageDescriptor> = {
  shown: msg`Sent. If you did not see it, allow Sotto in System Settings → Notifications.`,
  failed: msg`macOS did not show it. Allow Sotto in System Settings → Notifications, then try again.`,
  unsupported: msg`This computer cannot show notifications.`,
}

/** Settings → Application → Notifications (ADR-0117): shown only while the window shows notifications. */
export function NotificationSettings({ settings, onSave }: {
  readonly settings: Pick<AppSettings, 'notifyNeedsYou' | 'notifyFinished'>
  readonly onSave: (patch: SettingsPatch) => unknown
}): ReactNode {
  const { t, i18n } = useLingui()
  const bridge = useDesktopNotifications()
  const [testing, setTesting] = useState(false)
  const [answer, setAnswer] = useState<MessageDescriptor | null>(null)
  if (bridge === undefined) return null

  const sendTest = async (): Promise<void> => {
    setTesting(true)
    setAnswer(null)
    const result = await bridge.test().catch((): NotificationTestResult => 'failed')
    setAnswer(TEST_ANSWERS[result])
    setTesting(false)
  }

  return <SettingsGroup title={t`Notifications`} icon={Bell} note={t`If nothing appears, allow Sotto in System Settings → Notifications.`}>
    <Toggle label={t`When a thread needs you`} checked={settings.notifyNeedsYou} onCheckedChange={checked => void onSave({ notifyNeedsYou: checked })} description={t`A question or a permission is waiting for you.`} />
    <Toggle label={t`When a thread has finished everything`} checked={settings.notifyFinished} onCheckedChange={checked => void onSave({ notifyFinished: checked })} description={t`Its turn has ended and nothing it started is still going.`} />
    <div className="notification-settings__test">
      <Button variant="secondary" disabled={testing} onClick={() => void sendTest()}>{t`Send a test notification`}</Button>
      <p role="status" aria-live="polite">{answer === null ? '' : i18n._(answer)}</p>
    </div>
  </SettingsGroup>
}
