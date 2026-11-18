import React, { useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { Button } from '../../components/Button'

export function HermesChatGptSource({ signedIn, onSignIn, signOut, compact = false }: {
  readonly signedIn: boolean
  readonly onSignIn: () => void
  readonly signOut: () => Promise<unknown>
  readonly compact?: boolean
}): ReactNode {
  const { t } = useLingui()
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState(false)
  const end = async (): Promise<void> => {
    setSigningOut(true); setError(false)
    try { await signOut() }
    catch { setError(true) }
    finally { setSigningOut(false) }
  }
  return <div className={compact ? 'host-provider__detail' : 'provider-client'}>
    <div>
      <strong>ChatGPT</strong>
      <p className="tt-paragraph">{signedIn ? t`Signed in · Uses your ChatGPT subscription` : t`Use your ChatGPT subscription for Hermes threads.`}</p>
      {error ? <p className="tt-paragraph" role="alert">{t`Hermes could not finish signing out. Try again.`}</p> : null}
    </div>
    <div className={compact ? 'host-provider__act' : 'provider-client__actions'}>
      {signedIn
        ? <Button variant="secondary" disabled={signingOut} onClick={() => void end()}>{signingOut ? t`Signing out…` : t`Sign out`}</Button>
        : <Button variant="secondary" onClick={onSignIn}>{t`Sign in with ChatGPT`}</Button>}
    </div>
  </div>
}
