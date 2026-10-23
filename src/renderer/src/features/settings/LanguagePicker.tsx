import React, { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, ChevronDown, Languages } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'

import {
  INTERFACE_LANGUAGES,
  SOURCE_INTERFACE_LANGUAGE,
  type InterfaceLanguage,
  type InterfaceLanguageCode,
  type InterfaceLanguageSetting,
} from '../../../../shared/interfaceLanguages'
import { useInterfaceLanguageState } from '../../state/interfaceLanguage'
import './languagePicker.css'

interface Choice {
  readonly value: InterfaceLanguageSetting
  /** What the list shows first: the language in its own script, or "Same as this computer (…)". */
  readonly name: string
  /** The language's name in the interface language, beside it; empty when it would repeat the name. */
  readonly other: string
  readonly language?: InterfaceLanguage
}

/** A language's name in the interface language, from the system's own list; its English name where that has none. */
function nameIn(locale: string, language: InterfaceLanguage): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' }).of(language.code) ?? language.englishName
  } catch {
    return language.englishName
  }
}

const TYPEAHEAD_MS = 600

/**
 * Settings > Appearance > Language (ADR-0122): a list that starts with "Same as this computer (…)", then names each
 * language in its own script with its name in the current language beside it. The English word "Language" stays
 * beside the label whatever the interface is in, so someone who chose a language they cannot read finds the way back.
 * From the keyboard: the arrow keys, Home and End move, typed letters jump to a language, Enter or Space picks, and
 * Escape closes the list.
 */
export function LanguagePicker({ value, onChoose }: {
  readonly value: InterfaceLanguageSetting
  readonly onChoose: (value: InterfaceLanguageSetting) => void
}): ReactNode {
  const { t, i18n } = useLingui()
  const { system } = useInterfaceLanguageState()
  const locale = i18n.locale
  const labelId = useId(), valueId = useId(), descriptionId = useId(), listId = useId()
  const field = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const typed = useRef({ text: '', at: 0 })
  const keyed = useRef(0)

  const systemLanguage = INTERFACE_LANGUAGES.find(language => language.code === system) ?? INTERFACE_LANGUAGES[0]
  const computerLanguage = systemLanguage.endonym
  const sameAsComputer = t`Same as this computer (${computerLanguage})`
  const choices = useMemo<readonly Choice[]>(() => [
    { value: 'system', name: sameAsComputer, other: '' },
    ...INTERFACE_LANGUAGES.map(language => {
      const other = nameIn(locale, language)
      return { value: language.code as InterfaceLanguageCode, name: language.endonym, other: other === language.endonym ? '' : other, language }
    }),
  ], [locale, sameAsComputer])
  const chosen = Math.max(0, choices.findIndex(choice => choice.value === value))
  const current = choices[chosen]!
  const optionId = (index: number): string => `${listId}-${index}`

  useEffect(() => { if (open) document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' }) }, [open, active])
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent): void => { if (!field.current?.contains(event.target as Node)) setOpen(false) }
    const listen = window.setTimeout(() => document.addEventListener('click', outside))
    return () => { window.clearTimeout(listen); document.removeEventListener('click', outside) }
  }, [open])

  const show = (index = chosen): void => { setOpen(true); setActive(index) }
  const choose = (index: number): void => {
    setOpen(false)
    const choice = choices[index]
    if (choice !== undefined && choice.value !== value) onChoose(choice.value)
  }
  const jump = (key: string): void => {
    const at = Date.now()
    const text = (at - typed.current.at < TYPEAHEAD_MS ? typed.current.text : '') + key.toLocaleLowerCase(locale)
    typed.current = { text, at }
    const start = text.length === 1 ? active + 1 : active
    for (let step = 0; step < choices.length; step += 1) {
      const index = (start + step) % choices.length
      const choice = choices[index]!
      // A language is found by its own name, its name here, or its code.
      const names = [choice.name, choice.other, choice.language?.englishName ?? '', choice.language?.code ?? ''].map(name => name.toLocaleLowerCase(locale))
      if (names.some(name => name.startsWith(text))) { show(index); return }
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') keyed.current = Date.now()
    const letter = event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        show(event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : chosen)
      } else if (letter) {
        event.preventDefault()
        jump(event.key)
      }
      return
    }
    const last = choices.length - 1
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); return }
    if (event.key === 'Tab') { setOpen(false); return }
    if (letter) { event.preventDefault(); jump(event.key); return }
    const move: Record<string, number> = { ArrowDown: Math.min(last, active + 1), ArrowUp: Math.max(0, active - 1), Home: 0, End: last, PageDown: Math.min(last, active + 8), PageUp: Math.max(0, active - 8) }
    if (event.key in move) { event.preventDefault(); setActive(move[event.key]!); return }
    if (event.key === 'Enter' || (event.key === ' ' && Date.now() - typed.current.at >= TYPEAHEAD_MS)) { event.preventDefault(); choose(active) }
  }

  return (
    <div ref={field} className="tt-field language-picker" id="settings-language">
      <div className="language-picker__head">
        <Languages size={15} aria-hidden="true" className="language-picker__icon" />
        <span className="tt-field__label" id={labelId}>{t`Language`}</span>
        {locale === SOURCE_INTERFACE_LANGUAGE ? null : <span className="language-picker__anchor" lang="en" dir="ltr" aria-hidden="true">Language</span>}
        <span className="language-picker__badge">{t`Preview`}</span>
      </div>
      {/* A sentence runs in its own language's direction, from the right edge in Arabic and Urdu (ADR-0122). */}
      <p className="tt-field__description" id={descriptionId} dir="auto">{t`Menus, buttons and messages. What you dictate and what agents write stay as they are.`}</p>
      <button type="button" role="combobox" className="language-picker__button tt-focusable"
        aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-labelledby={`${labelId} ${valueId}`} aria-describedby={descriptionId}
        aria-activedescendant={open ? optionId(active) : undefined}
        onClick={() => {
          // The click a browser adds after Enter or Space was already handled by the key.
          if (Date.now() - keyed.current < 500) return
          if (open) setOpen(false); else show()
        }}
        onKeyDown={onKeyDown}>
        <span className="language-picker__value" id={valueId} {...(current.language ? { lang: current.language.code, dir: current.language.direction } : {})}>{current.name}</span>
        <ChevronDown size={14} aria-hidden="true" className="language-picker__chevron" />
      </button>
      {/* Pressing inside the list keeps focus on the button, which owns the keyboard. */}
      <div className="language-picker__popup" hidden={!open} onMouseDown={event => event.preventDefault()}>
        <p className="language-picker__note" dir="auto"><span className="language-picker__badge">{t`Preview`}</span> {t`Translations are new and ship on Owl first. Some words may still be in English.`}</p>
        <ul className="language-picker__list" id={listId} role="listbox" aria-labelledby={labelId}>
          {choices.map((choice, index) => (
            <li key={choice.value} id={optionId(index)} role="option" aria-selected={index === chosen}
              className={choice.value === 'system' ? 'language-picker__system' : undefined}
              data-active={open && index === active ? true : undefined}
              onMouseEnter={() => setActive(index)} onClick={() => choose(index)}>
              <Check size={15} aria-hidden="true" className="language-picker__check" />
              <span className="language-picker__name" {...(choice.language ? { lang: choice.language.code, dir: choice.language.direction } : {})}>{choice.name}</span>
              {choice.other ? <span className="language-picker__other">{choice.other}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
