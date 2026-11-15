import React, { type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { ModelRouterSettings as Saved } from '../../../../shared/modelRouter'
import type { SettingsPatch } from '../../../../shared/settings'
import { Toggle } from '../../components/Toggle'

/** Settings → Threads, Model routing (ADR-0207): whether a routed thread keeps the model its first message got. */
export function ModelRouterSettings({ settings, onSave }: { readonly settings: Saved; readonly onSave: (patch: SettingsPatch) => unknown }): ReactNode {
  const { t } = useLingui()
  return <Toggle label={t`Stay on the first model`} setting="model-router-stay" checked={settings.stayOnFirstModel}
    description={t`A new model re-reads the whole conversation at full price, and a smaller one loses the earlier reasoning. On, a thread keeps the model its first message got and later messages change only the effort.`}
    onCheckedChange={next => { void onSave({ modelRouter: { ...settings, stayOnFirstModel: next } }) }} />
}
