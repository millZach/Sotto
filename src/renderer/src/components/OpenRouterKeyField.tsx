import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CircleAlert } from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

import type { OpenRouterKeyCheck } from '../../../shared/contracts'
import { STORED_CREDENTIAL_PLACEHOLDER, type SettingsPatch } from '../../../shared/settings'
import { Button } from './Button'
import { Field } from './Field'

/** What a check found, as a message read in the interface language when it is shown. */
function openRouterKeyStatusCopy(result: OpenRouterKeyCheck): MessageDescriptor {
  if (result.ok) return msg`Key verified.`
  switch (result.reason) {
    case 'unauthorized': return msg`OpenRouter rejected this key.`
    case 'unconfigured': return msg`Enter your OpenRouter API key first.`
    case 'network':
    case 'timeout': return msg`Could not reach OpenRouter.`
    default: return msg`OpenRouter returned an error.`
  }
}

export function OpenRouterKeyField({ apiKey, migrationFailed = false, onUpdateSettings, onCheckOpenRouterKey }: {
  readonly migrationFailed?: boolean
  readonly apiKey: string
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly onCheckOpenRouterKey: () => Promise<OpenRouterKeyCheck>
}): ReactNode {
  const { t: say, i18n } = useLingui()
  const [draft, setDraft] = useState(apiKey)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ text: MessageDescriptor; error: boolean } | null>(null)
  const editVersion = useRef(0)
  const submittedVersion = useRef(0)
  const authoritativeKey = useRef(apiKey)
  const pendingSave = useRef<{ value: string; promise: Promise<boolean> } | null>(null)
  authoritativeKey.current = apiKey
  useEffect(() => {
    if (submittedVersion.current === editVersion.current) setDraft(apiKey)
  }, [apiKey])

  const save = (): Promise<boolean> => {
    const value = draft.trim()
    if (pendingSave.current?.value === value) return pendingSave.current.promise
    if (value === apiKey) return Promise.resolve(true)
    const version = editVersion.current
    submittedVersion.current = version
    const promise = onUpdateSettings({ llmApiKey: value }).catch(() => false)
    const submission = { value, promise }
    pendingSave.current = submission
    void promise.then((saved) => {
      if (pendingSave.current !== submission) return
      pendingSave.current = null
      if (version !== editVersion.current) return
      if (!saved) setStatus({ text: msg`The API key could not be saved.`, error: true })
      else if (authoritativeKey.current) setDraft(authoritativeKey.current)
    })
    return promise
  }

  const verify = async (): Promise<void> => {
    if (busy) return
    const version = editVersion.current
    setBusy(true)
    setStatus(null)
    try {
      if (!await save() || version !== editVersion.current) return
      const result = await onCheckOpenRouterKey().catch((): OpenRouterKeyCheck => ({ ok: false, reason: 'network' }))
      if (version === editVersion.current) setStatus({ text: openRouterKeyStatusCopy(result), error: !result.ok })
    } finally { setBusy(false) }
  }

  return <div className="key-field">
    <div className="settings-input-action">
      <Field label={say`OpenRouter API key`} description={say`Used only for AI cleanup and kept in your system’s credential store.`}>
        {/* An already-saved key is a state, not 47 characters of prose to show
            as dots in a field the user is meant to be able to read. */}
        <input className="tt-input" type="password" autoComplete="off"
          value={draft === STORED_CREDENTIAL_PLACEHOLDER ? '' : draft}
          placeholder={draft === STORED_CREDENTIAL_PLACEHOLDER ? say`Key saved` : undefined}
          onBlur={() => { void save() }}
          onChange={(event) => { editVersion.current += 1; setStatus(null); setDraft(event.currentTarget.value) }} />
      </Field>
      <Button variant="secondary" disabled={busy} onClick={() => void verify()}>{busy ? say`Verifying...` : say`Verify key`}</Button>
    </div>
    {migrationFailed && !apiKey ? <p className="settings-remote-status settings-remote-status--error tt-paragraph" role="status">
      <CircleAlert size={16} aria-hidden="true" /><Trans>The OpenRouter key could not be stored securely. Enter it again.</Trans>
    </p> : null}
    {status === null ? null : <p className={`settings-remote-status${status.error ? ' settings-remote-status--error' : ''} tt-paragraph`} role="status">
      {status.error ? <CircleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{i18n._(status.text)}
    </p>}
  </div>
}
