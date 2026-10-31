import React, { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

import { COMPOSER_STYLES, type ComposerStyle } from '../../../../../shared/composerStyle'
import './composerStyleChoice.css'

const STYLE_NAMES = {
  rows: msg({ message: 'Zach’s composer', comment: 'A style of the thread composer, named for the person who chose it' }),
  pill: msg({ message: 'Drake’s composer', comment: 'A style of the thread composer, named for the person who made it' }),
} as const satisfies Record<ComposerStyle, unknown>

const STYLE_WORDS = {
  rows: msg`The prompt on its own row, with the model, effort and permissions in words under it.`,
  pill: msg`One pill: the shield, the prompt and a chip of the model and effort on one line.`,
} as const satisfies Record<ComposerStyle, unknown>

/**
 * Settings → Appearance → Composer (ADR-0168): which of the two styles draws the thread and Watcher composers, as a card
 * for each with a small drawing of it. A radio group: one Tab stop; the arrows, Home and End move to a style and choose it.
 */
export function ComposerStyleChoice({ value, onChoose }: {
  readonly value: ComposerStyle
  /** Saves the style; resolves false when it was not saved. */
  readonly onChoose: (style: ComposerStyle) => Promise<boolean>
}): ReactNode {
  const { t, i18n } = useLingui()
  const headingId = useId()
  const hintId = useId()
  // The choice shows at once; the saved value takes over when it arrives, and comes back when the save fails.
  const [chosen, setChosen] = useState(value)
  const saved = useRef(value)
  useEffect(() => { saved.current = value; setChosen(value) }, [value])
  const buttons = useRef(new Map<ComposerStyle, HTMLButtonElement>())

  const choose = (style: ComposerStyle, focus: boolean): void => {
    if (focus) buttons.current.get(style)?.focus()
    if (style === chosen) return
    setChosen(style)
    void onChoose(style).then(ok => { if (!ok) setChosen(saved.current) }, () => setChosen(saved.current))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const from = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-composer-style]')?.dataset.composerStyle : undefined
    const at = COMPOSER_STYLES.indexOf((COMPOSER_STYLES as readonly string[]).includes(from ?? '') ? from as ComposerStyle : chosen), last = COMPOSER_STYLES.length - 1
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (at + 1) % COMPOSER_STYLES.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (at + last) % COMPOSER_STYLES.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : null
    if (next === null) return
    event.preventDefault()
    choose(COMPOSER_STYLES[next]!, true)
  }

  return (
    <div className="composer-style-choice" data-setting="composer-style">
      <h3 className="theme-settings__subheading" id={headingId}><Trans>Composer</Trans></h3>
      <p className="theme-settings__assignment-hint tt-paragraph" id={hintId}><Trans>How the box you write to threads and Watcher in is laid out.</Trans></p>
      <div className="composer-style-choice__grid" role="radiogroup" aria-labelledby={headingId} aria-describedby={hintId} onKeyDown={onKeyDown}>
        {COMPOSER_STYLES.map(id => {
          const active = id === chosen
          const name = i18n._(STYLE_NAMES[id])
          return (
            <button
              key={id}
              ref={button => { if (button === null) buttons.current.delete(id); else buttons.current.set(id, button) }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              data-composer-style={id}
              className="composer-style-option tt-focusable"
              aria-label={active ? t`Use ${name}, in use` : t`Use ${name}`}
              onClick={() => choose(id, false)}
            >
              <StylePicture style={id} />
              <span className="composer-style-option__name">
                {name}{active ? <span className="composer-style-option__now"> · <Trans>In use</Trans></span> : null}
              </span>
              <span className="composer-style-option__words">{i18n._(STYLE_WORDS[id])}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** A small drawing of the style: blocks for the words and controls, in the theme's own colours. */
function StylePicture({ style }: { readonly style: ComposerStyle }): ReactNode {
  return <span className="composer-style-option__picture" aria-hidden="true">
    {style === 'rows'
      ? <span className="composer-style-sketch" data-sketch="rows">
        <i className="composer-style-sketch__text" />
        <span className="composer-style-sketch__foot"><i className="composer-style-sketch__dot" /><span /><i className="composer-style-sketch__word" data-short /><i className="composer-style-sketch__word" /><i className="composer-style-sketch__disc" /></span>
      </span>
      : <span className="composer-style-sketch" data-sketch="pill">
        <i className="composer-style-sketch__dot" /><i className="composer-style-sketch__dot" data-shield /><i className="composer-style-sketch__text" /><i className="composer-style-sketch__chip" /><i className="composer-style-sketch__disc" />
      </span>}
  </span>
}
