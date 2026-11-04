import React, { type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { localeFormatter } from '../agents/localeFormat'
import type { TeamAsk, TeammateMessage, TeamRefusal } from '../../../shared/teams'
import './teams.css'

const timeOfDay = localeFormatter({ hour: 'numeric', minute: '2-digit' })

/** A teammate's message: what it asks and what it says. It starts nothing and answers nothing (ADR-0187). */
export function useTeamWords(): { readonly weAsked: (name: string, ask: TeamAsk) => string; readonly theyAsked: (name: string, ask: TeamAsk) => string; readonly refusal: (name: string, reason: TeamRefusal | undefined) => string } {
  const { t } = useLingui()
  return {
    weAsked: (name, ask) => ask === 'merge-priority' ? t`You asked ${name} about merge priority.` : t`You asked ${name} what they are working on.`,
    theyAsked: (name, ask) => ask === 'merge-priority' ? t`${name}'s Watcher asked about merge priority.` : t`${name}'s Watcher asked what you are working on.`,
    refusal: (name, reason) => {
      switch (reason) {
        case 'daily-cap': return t`${name}'s computer has answered as many asks as it takes today. Nothing was run. Ask again tomorrow.`
        case 'too-many': return t`${name}'s computer has taken a lot of asks in the last few minutes. Nothing was run. Ask again in ten minutes.`
        case 'busy': return t`${name}'s computer is still answering another ask. Nothing was run. Ask again in a minute.`
        case 'expired': return t`This link has run out on ${name}'s computer. Press Link again on the Teams tab.`
        case 'not-linked': return t`${name}'s computer no longer has this link. Nothing was asked. Make a new code on the Teams tab to link again.`
        default: return t`${name}'s computer turned this ask down. Nothing was run.`
      }
    },
  }
}

function TeammateMessageRow({ message }: { readonly message: TeammateMessage }): ReactNode {
  const { t } = useLingui()
  const words = useTeamWords(), name = message.teammate, at = timeOfDay(new Date(message.answeredAt ?? message.at))
  if (message.direction === 'they-asked') {
    return <div className="teammate-message" data-direction="they-asked" data-state={message.state}>
      <p className="teammate-message__who">{words.theyAsked(name, message.ask)} <time>{at}</time></p>
      {message.askWords ? <p className="teammate-message__words">{message.askWords}</p> : null}
      {message.state === 'asking' ? <p className="teammate-message__fine">{t`Your computer is answering from your thread list.`}</p> : null}
      {message.state === 'answered' ? <p className="teammate-message__words"><span className="teammate-message__said">{message.plain ? t`Your computer answered with a plain list:` : t`Your computer answered:`}</span> {message.answer}</p> : null}
      {message.state === 'refused' ? <p className="teammate-message__fine">{t`Your computer turned this down and ran nothing.`}</p> : null}
    </div>
  }
  if (message.state === 'asking') return <div className="teammate-message" data-direction="we-asked" data-state="asking"><p className="teammate-message__fine" role="status">{t`Asking ${name}'s computer…`}</p></div>
  if (message.state === 'failed') return <div className="teammate-message" data-direction="we-asked" data-state="failed"><p className="teammate-message__fine">{t`${name}'s computer did not answer. Nothing is waiting to send. Ask again when it is on.`}</p></div>
  if (message.state === 'refused') return <div className="teammate-message" data-direction="we-asked" data-state="refused"><p className="teammate-message__fine">{words.refusal(name, message.refusal)}</p></div>
  return <div className="teammate-message" data-direction="we-asked" data-state="answered">
    <p className="teammate-message__who">{t`${name}'s Watcher`} <time>{at}</time></p>
    <p className="teammate-message__words">{message.answer}</p>
    <p className="teammate-message__fine">{t`A teammate's message. It changes nothing here. Your Watcher reads it with your next message.`}</p>
  </div>
}

export function TeammateMessages({ messages }: { readonly messages: readonly TeammateMessage[] }): ReactNode {
  return <>{messages.map(message => <TeammateMessageRow key={message.id} message={message} />)}</>
}
