import React, { type ReactNode } from 'react'
import type { ThreadUsage as Usage } from '../../../shared/threadUsage'
import './threadUsage.css'

const number = (value: number): string => value.toLocaleString('en-US')
export function ThreadUsage({ usage, modelId }: { readonly usage?: Usage | undefined; readonly modelId?: string | undefined }): ReactNode {
  const currentModel = modelId === undefined || usage?.modelId === undefined || usage.modelId === modelId
  const current = currentModel ? usage : undefined
  const tokens = current?.latest
  const activity = [tokens?.input === undefined ? null : `${number(tokens.input)} in`, tokens?.output === undefined ? null : `${number(tokens.output)} out`].filter(Boolean).join(' / ')
  const context = current?.contextUsed === undefined ? 'Context unavailable'
    : current.contextWindow ? `Context ${Math.round(current.contextUsed / current.contextWindow * 100)}%` : `Context ${number(current.contextUsed)} tokens`
  const cost = usage?.estimatedUsd === undefined ? 'Estimate unavailable' : `Est. ${usage.partial ? '≥ ' : ''}$${usage.estimatedUsd.toFixed(4)}`
  return <div className="thread-usage" aria-label="Native usage">
    <span>{activity ? `${activity} tokens` : 'Tokens unavailable'}</span>
    <span title={current?.contextWindow && current.contextUsed !== undefined ? `${number(current.contextUsed)} / ${number(current.contextWindow)} tokens in the latest reported context` : undefined}>{context}</span>
    {usage?.elapsedMs !== undefined ? <span>{(usage.elapsedMs / 1000).toFixed(1)}s {usage.elapsedKind === 'api' ? 'API time' : 'elapsed'}</span> : null}
    <details className="thread-usage__estimate">
      <summary className="tt-focusable">{cost}</summary>
      <p>Estimated thread cost at standard API text-token rates, not subscription billing. Includes observed supported usage; tools and unreported work are excluded.{usage?.partial ? ' Some usage could not be priced.' : ''}{usage?.rateVersions.length ? ` Rate inputs: ${usage.rateVersions.join(', ')}.` : ' No supported priced usage yet.'}{usage?.persistenceError ? ' Usage could not be saved; this estimate may be lost after restart.' : ''}</p>
    </details>
  </div>
}
