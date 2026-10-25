import React, { useLayoutEffect, useRef, type ReactNode } from 'react'
import { ArrowRight, Check, CircleHelp, Flag, type LucideIcon } from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { NextPrompt, NextPromptIntent } from '../../../shared/nextPrompt'
import './nextPrompt.css'

/** One row of the Next list: an answer to the agent's question, the next prompt itself, or one of four suggestions. */
export interface NextRow {
  readonly kind: 'answer' | 'ghost' | 'suggestion'
  /** What the row's key column shows: Enter for an answer, Tab for the next prompt, 1 to 4 for a suggestion. */
  readonly key: string
  readonly label: string
  readonly text: string
  readonly intent?: NextPromptIntent
}

const INTENTS: Record<NextPromptIntent, { readonly name: MessageDescriptor; readonly icon: LucideIcon }> = {
  continue: { name: msg({ message: 'Continue', comment: 'A kind of suggested next prompt: carry on with the work.' }), icon: ArrowRight },
  verify: { name: msg({ message: 'Verify', comment: 'A kind of suggested next prompt: check the work.' }), icon: Check },
  challenge: { name: msg({ message: 'Challenge', comment: 'A kind of suggested next prompt: question the work.' }), icon: CircleHelp },
  wrap: { name: msg({ message: 'Wrap up', comment: 'A kind of suggested next prompt: finish the work.' }), icon: Flag },
}

/** The list's rows in the order they are shown: answers first, then the next prompt, then the four suggestions. */
export function nextRows(prompt: NextPrompt): NextRow[] {
  return [
    ...prompt.answers.map((answer): NextRow => ({ kind: 'answer', key: '↵', label: answer.label, text: answer.text })),
    ...(prompt.ghost ? [{ kind: 'ghost', key: 'Tab', label: prompt.ghost, text: prompt.ghost } satisfies NextRow] : []),
    ...prompt.suggestions.map((item, index): NextRow => ({ kind: 'suggestion', key: String(index + 1), label: item.label, text: item.text, intent: item.intent })),
  ]
}

export const nextOptionId = (listId: string, index: number): string => `${listId}-option-${index}`

/**
 * The Next list (ADR-0132): over the transcript, above the composer, like the skills list, so it never takes height
 * from the composer. Focus stays in the prompt, which moves through the rows; a press or Enter chooses one.
 */
export function NextList({ prompt, listId, activeIndex, sends, onHighlight, onChoose }: {
  readonly prompt: NextPrompt
  readonly listId: string
  readonly activeIndex: number
  /** An answer sends at once only into an empty prompt; otherwise it joins what is written. */
  readonly sends: boolean
  readonly onHighlight: (index: number) => void
  readonly onChoose: (row: NextRow) => void
}): ReactNode {
  const { t } = useLingui()
  const list = useRef<HTMLUListElement>(null)
  const rows = nextRows(prompt)
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(`#${CSS.escape(nextOptionId(listId, activeIndex))}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, listId])
  const active = rows[activeIndex]
  const suggestions = prompt.suggestions.length
  return <div className="composer-picker next-list" data-kind="next">
    {prompt.headline ? <p className="next-list__headline tt-paragraph" id={`${listId}-headline`}>{prompt.headline}</p> : null}
    <ul ref={list} className="composer-picker__list next-list__rows" role="listbox" id={listId} aria-label={t`Next prompts`}
      aria-describedby={prompt.headline ? `${listId}-headline` : undefined}>
      {rows.map((row, index) => {
        const intent = row.intent ? INTENTS[row.intent] : undefined
        const Icon = intent?.icon
        return <li key={`${row.kind}-${index}`} id={nextOptionId(listId, index)} role="option" aria-selected={index === activeIndex}
          className="composer-picker__option next-list__row" data-kind={row.kind} data-active={index === activeIndex || undefined}
          onMouseDown={event => event.preventDefault()} onMouseMove={() => { if (index !== activeIndex) onHighlight(index) }} onClick={() => onChoose(row)}>
          <span className="next-list__key" aria-hidden="true">{row.key}</span>
          <span className="next-list__label">
            {Icon ? <Icon size={13} aria-hidden="true" /> : null}
            {intent ? <span className="tt-visually-hidden">{t({ message: `${{ intentName: t(intent.name) }}: `, comment: 'Read before a suggested next prompt: its kind, such as Verify.' })}</span> : null}
            {row.kind === 'answer' ? <span className="tt-visually-hidden">{sends ? t({ message: 'Send answer: ', comment: 'Read before an answer to the agent\'s question that sends at once.' }) : t({ message: 'Answer: ', comment: 'Read before an answer to the agent\'s question.' })}</span> : null}
            {row.label}
          </span>
          {row.kind === 'ghost' ? null : <span className="next-list__text">{row.text}</span>}
        </li>
      })}
    </ul>
    <div className="composer-picker__foot next-list__foot">
      <span className="composer-picker__notes">
        <span>{t({ message: '↑ ↓ choose', comment: 'A keyboard hint: the arrow keys move through the list.' })}</span>
        <span>{active?.kind === 'answer' && sends ? t`Enter sends this answer` : t`Enter puts it in the prompt`}</span>
        {suggestions > 0 ? <span>{suggestions === 1 ? t({ message: '1 picks it', comment: 'A keyboard hint: the 1 key picks the suggestion.' }) : t({ message: `1–${suggestions} pick`, comment: 'A keyboard hint: the number keys pick a suggestion; {suggestions} is how many there are.' })}</span> : null}
        <span>{t({ message: 'Escape closes', comment: 'A keyboard hint: Escape closes the list.' })}</span>
      </span>
    </div>
  </div>
}
