import React, { useSyncExternalStore, type ReactElement } from 'react'
import { i18n, type I18n } from '@lingui/core'
import { TransNoContext, type TransProps } from '@lingui/react/server'

/**
 * What Lingui's `useLingui` and `<Trans>` macros compile to in Sotto (`runtimeConfigModule` in lingui.config.ts). They read
 * the window's one `i18n` directly instead of a provider, so a component renders its words the same in a test as in a
 * window, and every component that shows a message draws again when the interface language changes (ADR-0123).
 */
interface InterfaceLingui {
  readonly i18n: I18n
  readonly _: I18n['_']
}

const contextOf = (): InterfaceLingui => ({ i18n, _: i18n._.bind(i18n) })
let current = contextOf()
// A new `_` at every change, so a component that only holds `t` still draws again. Registered first, so it has run
// before any component's listener reads the snapshot.
i18n.on('change', () => { current = contextOf() })
const subscribe = (listener: () => void): (() => void) => i18n.on('change', listener)
const snapshot = (): InterfaceLingui => current

export function useLingui(): InterfaceLingui {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function Trans(props: TransProps): ReactElement | null {
  return <TransNoContext {...props} lingui={useLingui()} />
}
