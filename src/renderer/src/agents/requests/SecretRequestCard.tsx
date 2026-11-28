import React, { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowUpRight, LockKeyhole } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import type { AgentRequest } from '../../../../shared/agents'
import type { SecretRequestCard as SecretCard } from '../../../../shared/secretRequests'
import { Button } from '../../components/Button'
import { LinkedText } from './LinkedText'
import './requests.css'

export interface SecretRequestCardProps {
  /** The thread the card is in, as the window names it. */
  readonly ownerId: string
  readonly request: AgentRequest & { readonly secretRequest: SecretCard }
  /** Why the card cannot be answered right now (disconnected, busy); null when it can. */
  readonly blocked: string | null
}

/** A sign-in page's site as the card names it: its host, with a port if it has one. */
function siteOf(url: string): string | null {
  try { return new URL(url).host || null } catch { return null }
}

/**
 * A **secret request** (ADR-0219): the agent asks for values it must not see. They are typed here, held in this card
 * alone while it shows, and sent to main once on the card's own channel, never as the request's answer, a draft or
 * anything the window keeps. Save securely and Decline are the only ways out; the sign-in page opens in the user's
 * browser. A paired phone shows the request's words and Decline, so the values are always typed on this computer.
 */
export function SecretRequestCard({ ownerId, request, blocked }: SecretRequestCardProps): ReactNode {
  const { t, i18n } = useLingui()
  const card = request.secretRequest
  const baseId = useId()
  const titleId = `${baseId}-title`, privacyId = `${baseId}-privacy`, errorId = `${baseId}-error`
  // The values live in this card's state only, and go with it. A map, so a field named like `toString` is only a key.
  const [values, setValues] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [sending, setSending] = useState<'save' | 'decline' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // Enter and a click can both send before a render.
  const inFlight = useRef(false)
  const firstField = useRef<HTMLInputElement>(null)
  const bridge = window.sotto?.secretRequests
  const disabled = sending !== null || blocked !== null || !bridge
  const missing = card.fields.filter(field => !(values.get(field.name) ?? '').trim())
  const send = async (answer: 'save' | 'decline'): Promise<void> => {
    if (!bridge || inFlight.current || disabled) return
    if (answer === 'save' && missing.length) { setProblem(t({ message: `Enter ${missing[0]!.label}, or decline the card.`, comment: '{0} is what the agent asked for, such as API key.' })); firstEmpty()?.focus(); return }
    inFlight.current = true; setSending(answer); setProblem(null)
    try {
      const result = await bridge.answer(answer === 'save' ? { answer, threadId: ownerId, requestId: request.id, values: Object.fromEntries(values) } : { answer, threadId: ownerId, requestId: request.id })
      if (result.ok) setValues(new Map())
      else setProblem(result.message)
    } catch { setProblem(t`Sotto did not answer. Nothing was saved; try again.`) }
    finally { inFlight.current = false; setSending(null) }
  }
  const firstEmpty = (): HTMLInputElement | null => {
    const empty = missing[0]
    return empty ? document.getElementById(`${baseId}-${empty.name}`) as HTMLInputElement | null : firstField.current
  }
  const submit = (event: FormEvent): void => { event.preventDefault(); void send('save') }
  const openPage = (): void => { if (card.url) void window.sotto?.openExternalLink?.(card.url) }
  const until = new Intl.DateTimeFormat(i18n.locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(card.expiresAt))
  const several = card.fields.length > 1
  // A reference is typed only on the sign-in page's site, or where the user says yes (ADR-0219, decision 7). A file is
  // read by the agent's own commands, which it is told never to print, so the card does not say the agent never sees it.
  const site = card.url ? siteOf(card.url) : null
  const privacy = card.delivery === 'file'
    ? several ? t`Sotto writes each to a file only you can read, for the agent’s commands, and deletes them within an hour. They stay out of the chat, but anything those commands print reaches the agent and its provider.`
      : t`Sotto writes it to a file only you can read, for the agent’s commands, and deletes it within an hour. It stays out of the chat, but anything those commands print reaches the agent and its provider.`
    : site
      ? several ? t({ message: `Sotto keeps them for the agent’s own Sotto tools to use once each, and types them only on ${site}. The agent and its provider never see them.`, comment: '{site} is the site of the sign-in page, such as dashboard.stripe.com.' })
        : t({ message: `Sotto keeps it for the agent’s own Sotto tools to use once, and types it only on ${site}. The agent and its provider never see it.`, comment: '{site} is the site of the sign-in page, such as dashboard.stripe.com.' })
      : several ? t`Sotto keeps them for the agent’s own Sotto tools to use once each, and asks you before typing them on any page. The agent and its provider never see them.`
        : t`Sotto keeps it for the agent’s own Sotto tools to use once, and asks you before typing it on any page. The agent and its provider never see it.`
  const describedBy = problem ? `${privacyId} ${errorId}` : privacyId
  return <section className="agent-request secret-request" data-kind="secret" aria-labelledby={titleId} aria-busy={sending !== null || undefined}>
    <div className="agent-request__head">
      <strong id={titleId}>{card.label}</strong>
      <span className="agent-request__tag secret-request__tag"><LockKeyhole size={12} aria-hidden="true" />{t({ message: 'Private', comment: 'Tags a card whose values the agent never sees.' })}</span>
    </div>
    <p className="agent-request__text"><LinkedText text={card.reason} /></p>
    <form className="secret-request__form" onSubmit={submit} autoComplete="off" noValidate>
      {card.fields.map((field, index) => {
        const id = `${baseId}-${field.name}`
        return <div key={field.name} className="secret-request__field">
          <label htmlFor={id}>{card.fields.length === 1 && field.label === card.label ? t({ message: 'Value', comment: 'Labels the one field of a secret request whose title already names it.' }) : field.label}</label>
          <input ref={index === 0 ? firstField : undefined} id={id} className="tt-input tt-focusable" name={`secret-${field.name}`}
            // A masked field keeps the value from a screen reader too; a shown one is for a user name or an address.
            type={field.secret ? 'password' : 'text'} autoComplete={field.secret ? 'new-password' : 'off'} autoCorrect="off" autoCapitalize="off" spellCheck={false}
            data-1p-ignore="true" data-lpignore="true" data-bwignore="true" placeholder={field.placeholder}
            value={values.get(field.name) ?? ''} disabled={disabled} aria-describedby={describedBy}
            aria-invalid={problem !== null && missing.some(item => item.name === field.name) || undefined}
            onChange={event => { const value = event.currentTarget.value; setProblem(null); setValues(current => new Map(current).set(field.name, value)) }} />
        </div>
      })}
      <p id={privacyId} className="secret-request__privacy tt-paragraph">{privacy}</p>
      <div className="agent-request__actions">
        <Button type="submit" disabled={disabled}>{sending === 'save' ? t`Saving…` : t({ message: 'Save securely', comment: 'Sends the values a secret request asked for to Sotto, not to the agent.' })}</Button>
        {card.url ? <Button variant="secondary" onClick={openPage} title={card.url}>{t({ message: 'Open sign-in page', comment: 'Opens the page the agent named for getting a secret, in the user’s browser.' })}<ArrowUpRight size={14} aria-hidden="true" /></Button> : null}
        <Button variant="secondary" disabled={disabled} onClick={() => void send('decline')}>{t({ message: 'Decline', comment: 'Refuses a secret request; the agent is told and goes on without it.' })}</Button>
      </div>
      {problem ? <p id={errorId} className="agent-request__error tt-paragraph" role="alert">{problem}</p>
        : blocked ? <p className="agent-request__status tt-paragraph">{blocked}</p>
          : <p className="agent-request__status tt-paragraph">{t({ message: `Waiting until ${until}`, comment: '{until} is a time of day, such as 14:32, when the card closes unanswered.' })}</p>}
    </form>
  </section>
}

/**
 * Whether this window shows a request as a secret request's card: the request carries one, the Owl feature is on and
 * the window has the card's channel, which only the main window does. Anywhere else, the request shows its words and
 * Decline, as a phone does.
 */
export function showsSecretCard(request: AgentRequest, enabled: boolean): request is AgentRequest & { readonly secretRequest: SecretCard } {
  return enabled && request.secretRequest !== undefined && window.sotto?.secretRequests !== undefined
}
