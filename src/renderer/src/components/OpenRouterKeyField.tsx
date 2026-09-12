import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CircleAlert } from 'lucide-react'

import type { TranscriptionKeyCheck } from '../../../shared/contracts'
import { STORED_CREDENTIAL_PLACEHOLDER, type SettingsPatch } from '../../../shared/settings'
import { Button } from './Button'
import { Field } from './Field'

export function transcriptionKeyStatusCopy(result: TranscriptionKeyCheck): string {
  if (result.ok) return 'Key verified.'
  switch (result.reason) {
    case 'unauthorized': return 'OpenRouter rejected this key.'
    case 'unconfigured': return 'Enter your OpenRouter API key first.'
    case 'network':
    case 'timeout': return 'Could not reach OpenRouter.'
    default: return 'OpenRouter returned an error.'
  }
}

export function OpenRouterKeyField({ apiKey, onUpdateSettings, onCheckTranscriptionKey }: {
  readonly apiKey: string
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly onCheckTranscriptionKey: () => Promise<TranscriptionKeyCheck>
}): ReactNode {
  const [draft, setDraft] = useState(apiKey)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null)
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
      if (!saved) setStatus({ text: 'The API key could not be saved.', error: true })
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
      const result = await onCheckTranscriptionKey().catch((): TranscriptionKeyCheck => ({ ok: false, reason: 'network' }))
      if (version === editVersion.current) setStatus({ text: transcriptionKeyStatusCopy(result), error: !result.ok })
    } finally { setBusy(false) }
  }

  return <div className="key-field">
    <div className="settings-input-action">
      <Field label="OpenRouter API key" description="Used for transcription, AI cleanup and Kokoro voice. Stored in your operating system credential store.">
        {/* An already-saved key is a state, not 47 characters of prose to show
            as dots in a field the user is meant to be able to read. */}
        <input className="tt-input" type="password" autoComplete="off"
          value={draft === STORED_CREDENTIAL_PLACEHOLDER ? '' : draft}
          placeholder={draft === STORED_CREDENTIAL_PLACEHOLDER ? 'Key saved' : undefined}
          onBlur={() => { void save() }}
          onChange={(event) => { editVersion.current += 1; setStatus(null); setDraft(event.currentTarget.value) }} />
      </Field>
      <Button variant="secondary" disabled={busy} onClick={() => void verify()}>{busy ? 'Verifying...' : 'Verify key'}</Button>
    </div>
    {status === null ? null : <p className={`settings-remote-status${status.error ? ' settings-remote-status--error' : ''}`} role="status">
      {status.error ? <CircleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{status.text}
    </p>}
  </div>
}
