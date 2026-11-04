import React, { type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { PRODUCT_EVENTS_DOCS_URL } from '../../../../shared/productEvents'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import './productEvents.css'

/** Every product event, in the words the user can check against docs/product-events.md (ADR-0179). The notice and the switch both open it. */
export function ProductEventsDialog({ onClose }: { readonly onClose: () => void }): ReactNode {
  const { t } = useLingui()
  const rows: readonly (readonly [string, ReactNode])[] = [
    ['install.owner_observed', <Trans key="owner">Once per start, for each account signed in. It links one person’s computers.</Trans>],
    ['app.started', <Trans key="app">Once per start. It counts active installs by version and system.</Trans>],
    ['thread.started', <Trans key="thread">A thread begins its first turn. It shows which providers and ways of starting get used.</Trans>],
    ['turn.completed', <Trans key="turn">A turn ends. It shows reliability, speed and token use by provider and model.</Trans>],
    ['feature.used', <Trans key="feature">You start a feature from a fixed list, at most once a day per feature while Sotto runs. It shows what gets used and what to fix or remove.</Trans>],
  ]
  return <ConfirmationDialog withoutConfirm danger={false} title={t`Every product event`} cancelLabel={t`Close`} onCancel={onClose} onConfirm={async () => undefined} confirmLabel="" description={<>
    <p className="tt-paragraph"><Trans>Fields are checked against a fixed list for each event. An event with anything else on it is dropped before it can leave.</Trans></p>
    <table className="product-events-list">
      <tbody>{rows.map(([name, when]) => <tr key={name}><th scope="row"><code>{name}</code></th><td className="tt-paragraph">{when}</td></tr>)}</tbody>
    </table>
    <button type="button" className="product-events-link tt-focusable" data-outside-link="" onClick={() => void window.sotto?.openExternalLink?.(PRODUCT_EVENTS_DOCS_URL)}><Trans>Read every field on the docs page</Trans></button>
  </>} />
}
