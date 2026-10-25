import React, { useId, type ReactNode } from 'react'
import { AppWindow } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentThread } from '../../../../shared/agents'
import { isThreadClosed } from '../../../../shared/threadActivity'
import { MessageLinks } from './AgentRequestCard'

/**
 * A prototype the thread made waits for the user to review (ADR-0108, variant A): a slim strip above the composer with an
 * Open the prototype row for each page, opened through main by the thread and the page's token. The host's mark is the
 * only thing that shows it, and the host clears it once a page is opened or the user replies. A waiting question's card
 * that carries pages offers them above the composer, so the strip gives way to it; beside one that offers none it stays.
 */
export function PrototypeReady({ thread }: { readonly thread: AgentThread }): ReactNode {
  const { t } = useLingui()
  const titleId = useId()
  const ready = thread.prototypeReady
  if (ready === undefined || isThreadClosed(thread) || thread.requests.some(request => request.kind === 'question' && (request.pages?.length ?? 0) > 0)) return null
  return <section className="prototype-ready" aria-labelledby={titleId}>
    <span className="prototype-ready__title" id={titleId}><AppWindow size={16} aria-hidden="true" /><Trans>Prototype ready for review</Trans></span>
    <MessageLinks links={[]} pages={ready.pages} owner={{ threadId: thread.id }} label={t`Pages to review`} />
  </section>
}
