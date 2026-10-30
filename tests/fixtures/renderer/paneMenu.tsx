import { fireEvent, within } from '@testing-library/react'

/**
 * Opens a pane header's More menu and returns it. Everything a pane can do to its thread beyond writing in it
 * lives there, so a test that used to click a header button opens the menu first and chooses the item by name.
 */
export function openPaneMenu(scope: HTMLElement): HTMLElement {
  fireEvent.click(within(scope).getByRole('button', { name: 'More actions' }))
  return within(scope).getByRole('menu', { name: 'More actions' })
}

/** The item a menu offers, by name; `within(openPaneMenu(pane))` reads it the same way. */
export function paneMenuItem(scope: HTMLElement, name: string): HTMLElement {
  return within(openPaneMenu(scope)).getByRole('menuitem', { name })
}

/**
 * Everything the open menu lists, in the order it lists it, by name: rows that show something (Tools, the Terminal
 * drawer) included, and a row's keys left out (ADR-0163).
 */
export function paneMenuItems(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')]
    .map(item => item.querySelector('.pane-menu__label')?.textContent ?? item.textContent ?? '')
}
