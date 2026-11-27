import React, { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Plus, Trash2, UserRound } from 'lucide-react'
import { plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { BROWSER_PROFILE_NAME_MAX, type BrowserBridge, type BrowserImportSource, type BrowserProfile } from '../../../shared/browser'
import './browserParity.css'

/** Says a page is open in one of the user's browser profiles (ADR-0221), beside the address, as a host's page names its machine. */
export function ProfileChip({ profile }: { readonly profile: BrowserProfile }): ReactNode {
  const { t } = useLingui()
  const name = profile.name
  return <span className="terminal-machine browser-parity__profile-chip" title={t({ message: `Open in the profile ${name}, which keeps its sign-ins. The agent sees this page only when you share it.`, comment: '{name} is the name the user gave a browser profile, such as Work.' })}>
    <UserRound size={13} aria-hidden="true" /><bdi>{name}</bdi>
  </span>
}

type Listing = { readonly profiles: readonly BrowserProfile[]; readonly sources: readonly BrowserImportSource[] }

/**
 * The user's browser profiles (ADR-0221), offered in the empty pane: which one new pages open in, Add (optionally
 * copying a Firefox or Zen profile's sign-ins once) and Remove. Only the user reaches this; no agent tool does.
 */
export function BrowserProfiles({ bridge, value, onChange, disabled }: { readonly bridge: BrowserBridge | undefined; readonly value: string | null; readonly onChange: (profileId: string | null) => void; readonly disabled: boolean }): ReactNode {
  const { t } = useLingui()
  const [listing, setListing] = useState<Listing | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const nameField = useRef<HTMLInputElement | null>(null)
  const keepButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    let current = true
    if (!bridge?.profiles) return
    void bridge.profiles().then(result => { if (current && result.ok) setListing(result.value) }, () => undefined)
    return () => { current = false }
  }, [bridge])
  useEffect(() => { if (adding) nameField.current?.focus() }, [adding])
  // Remove asks in place; focus goes to Keep, the answer that changes nothing.
  useEffect(() => { if (removing) keepButton.current?.focus() }, [removing])
  // A profile removed elsewhere, or never there, leaves new pages fresh.
  useEffect(() => { if (listing && value !== null && !listing.profiles.some(profile => profile.id === value)) onChange(null) }, [listing, value, onChange])
  if (!bridge?.profiles || !bridge.addProfile || !bridge.removeProfile || !listing) return null
  const { addProfile, removeProfile } = bridge
  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!name.trim()) { setProblem(t`Name the profile first.`); nameField.current?.focus(); return }
    setBusy(true); setProblem(null); setSaid(null)
    try {
      const result = await addProfile({ name: name.trim(), ...source ? { importFrom: source } : {} })
      if (!result.ok) { setProblem(result.error.message); return }
      const { profile, imported } = result.value
      setListing(current => current ? { ...current, profiles: [...current.profiles, profile] } : current)
      const added = profile.name
      const copied = plural(imported, { one: '# cookie', other: '# cookies' })
      setSaid(source ? t({ message: `Added ${added} and copied its sign-ins (${copied}). New pages open in it.`, comment: '{added} is the profile name; {copied} is a count of cookies, as in 12 cookies.' })
        : t({ message: `Added ${added}. New pages open in it, signed out until you sign in.`, comment: '{added} is the profile name.' }))
      setAdding(false); setName(''); setSource('')
      onChange(profile.id)
    } catch { setProblem(t`The window could not reach Sotto. Nothing was added.`) } finally { setBusy(false) }
  }
  const remove = async (profile: BrowserProfile): Promise<void> => {
    setBusy(true); setProblem(null); setSaid(null)
    try {
      const result = await removeProfile({ id: profile.id })
      if (!result.ok) { setProblem(result.error.message); return }
      setListing(result.value)
      if (value === profile.id) onChange(null)
      const removed = profile.name
      setSaid(t({ message: `Removed ${removed} and deleted its sign-ins.`, comment: '{removed} is the profile name.' }))
    } catch { setProblem(t`The window could not reach Sotto. Nothing was removed.`) } finally { setBusy(false); setRemoving(null) }
  }
  return <section className="browser-pane__opened browser-parity__profiles" aria-labelledby="browser-pane-profiles" aria-busy={busy || undefined}>
    <h2 id="browser-pane-profiles">{t({ message: 'Open new pages in', comment: 'Heads the choice of browser profile, or none, that a new browser page opens in.' })}</h2>
    <div role="radiogroup" aria-labelledby="browser-pane-profiles" className="browser-parity__profile-list">
      <label className="browser-parity__profile">
        <input type="radio" name="browser-profile" className="tt-focusable" checked={value === null} disabled={disabled || busy} onChange={() => onChange(null)} />
        <span className="browser-parity__profile-name">{t`A fresh page`}</span>
        <span className="browser-parity__profile-note">{t`Keeps nothing after Sotto closes`}</span>
      </label>
      {listing.profiles.map(profile => {
        const named = profile.name
        return <div key={profile.id} className="browser-parity__profile-row">
          <label className="browser-parity__profile">
            <input type="radio" name="browser-profile" className="tt-focusable" checked={value === profile.id} disabled={disabled || busy} onChange={() => onChange(profile.id)} />
            <span className="browser-parity__profile-name"><bdi>{named}</bdi></span>
            <span className="browser-parity__profile-note">{t`Keeps sign-ins`}</span>
          </label>
          {removing === profile.id ? <span className="browser-parity__confirm">
            <button type="button" className="tt-button tt-button--danger tt-focusable" disabled={busy} onClick={() => void remove(profile)}>{t`Delete sign-ins`}</button>
            <button ref={keepButton} type="button" className="tt-button tt-button--secondary tt-focusable" disabled={busy} onClick={() => setRemoving(null)}
              onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRemoving(null) } }}>{t`Keep`}</button>
          </span> : <button type="button" className="files-icon tt-focusable" disabled={busy || disabled}
            aria-label={t({ message: `Remove ${named}`, comment: 'Removes a browser profile; {named} is the name the user gave it, such as Work.' })} title={t`Remove this profile and delete its sign-ins`} onClick={() => setRemoving(profile.id)}><Trash2 size={14} aria-hidden="true" /></button>}
        </div>
      })}
    </div>
    {adding ? <form className="browser-parity__add" onSubmit={event => void add(event)}>
      <div className="tt-field">
        <label className="tt-field__label" htmlFor="browser-profile-name">{t`Profile name`}</label>
        <input ref={nameField} id="browser-profile-name" className="tt-input tt-focusable" value={name} maxLength={BROWSER_PROFILE_NAME_MAX} autoComplete="off" spellCheck={false}
          placeholder={t`Work`} disabled={busy} onChange={event => { setProblem(null); setName(event.currentTarget.value) }}
          onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setAdding(false); setProblem(null) } }} />
      </div>
      {listing.sources.length > 0 ? <div className="tt-field">
        <label className="tt-field__label" htmlFor="browser-profile-source">{t`Copy sign-ins from`}</label>
        <select id="browser-profile-source" className="tt-input tt-focusable" value={source} disabled={busy} onChange={event => setSource(event.currentTarget.value)}>
          <option value="">{t`Nothing. Start signed out`}</option>
          {listing.sources.map(found => <option key={found.id} value={found.id}>{`${found.browser} · ${found.name}`}</option>)}
        </select>
        <p className="tt-field__description tt-paragraph">{t`Close that browser first. Sotto copies its cookies once, and later sign-ins stay separate.`}</p>
      </div> : null}
      <div className="browser-parity__add-actions">
        <button type="submit" className="tt-button tt-button--primary tt-focusable" disabled={busy}>{t`Add profile`}</button>
        <button type="button" className="tt-button tt-button--secondary tt-focusable" disabled={busy} onClick={() => { setAdding(false); setProblem(null) }}>{t`Cancel`}</button>
      </div>
    </form> : <button type="button" className="browser-pane__recent tt-focusable" disabled={disabled || busy} onClick={() => { setAdding(true); setSaid(null) }}>
      <Plus size={15} aria-hidden="true" /><span>{t`Add a profile that keeps sign-ins`}</span></button>}
    {problem ? <p className="tt-field__error tt-paragraph" role="alert">{problem}</p> : null}
    {said ? <p className="browser-parity__none tt-paragraph" role="status">{said}</p> : null}
  </section>
}
