import React, { type ReactNode } from 'react'
import type { ThreadUsage as Usage } from '../../../shared/threadUsage'
import './threadUsage.css'

const number = (value: number): string => value.toLocaleString('en-US')
/** Cents for anything a cent or more, four places below that, so a fraction of a cent never reads as nothing. */
const money = (value: number): string => `$${value.toFixed(value === 0 || value >= 0.01 ? 2 : 4)}`

/**
 * What this thread has spent, in the two numbers worth a glance: how full the context window is, and what the
 * work would have cost at API rates. Everything else about the usage record lives in the two titles, which
 * keep saying what the numbers do and do not include.
 */
export function ThreadUsage({ usage, modelId }: { readonly usage?: Usage | undefined; readonly modelId?: string | undefined }): ReactNode {
  // Context belongs to the model that reported it: after a switch the old figure describes a window this thread no longer uses.
  const currentModel = modelId === undefined || usage?.modelId === undefined || usage.modelId === modelId
  const current = currentModel ? usage : undefined
  const used = current?.contextUsed
  const limit = current?.contextWindow
  // A window the provider never named leaves the raw count as the only honest figure.
  const percent = used !== undefined && limit ? Math.round(used / limit * 100) : null
  const contextTitle = used === undefined ? undefined
    : percent === null || !limit ? `${number(used)} tokens in the context window`
      : `${number(used)} of ${number(limit)} tokens in the context window (${percent}%)`
  const costTitle = 'Estimated at standard API text-token rates, not subscription billing. Tools and unreported work are excluded.'
    + (usage?.partial ? ' Some usage could not be priced, so the thread may have cost more.' : '')
    + (usage?.rateVersions.length ? ` Rate inputs: ${usage.rateVersions.join(', ')}.` : ' No supported priced usage yet.')
    + (usage?.persistenceError ? ' Usage could not be saved; this estimate may be lost after restart.' : '')
  return <div className="thread-usage" aria-label="Native usage">
    {used === undefined
      ? <span title="This model has not reported how full the context window is.">Context unavailable</span>
      : <span title={contextTitle}><b>{percent === null ? `${number(used)} tokens` : `${percent}%`}</b> context</span>}
    <span title={costTitle}>{usage?.estimatedUsd === undefined ? 'Estimate unavailable' : `${usage.partial ? '≥ ' : ''}${money(usage.estimatedUsd)}`}</span>
  </div>
}
