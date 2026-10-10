import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThemeGallery } from '../../../src/renderer/src/features/settings/themes/ThemeGallery'
import { applyAppearance, appearancePreview, resolveAppearance } from '../../../src/renderer/src/state/appearance'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { parseOmarchyTheme } from '../../../src/shared/themes/omarchy'
import fixtures from '../../fixtures/omarchy-themes.json'
import { ThemeLivePreview } from '../../../src/renderer/src/features/settings/themes/ThemeLivePreview'

afterEach(() => { cleanup(); appearancePreview.reset() })
function gallery(system: string, light = false) {
 const theme = parseOmarchyTheme(fixtures.themes[light ? 'catppuccin-latte' : 'tokyo-night'].rendered, light ? 'Catppuccin Latte' : 'Tokyo Night')
 const shown = { ...DEFAULT_SETTINGS, appearance: 'system' as const, lightTheme: 'omarchy', darkTheme: 'omarchy', omarchyTheme: theme }
 const onSelect = vi.fn()
 const result = render(<ThemeGallery shown={shown} resolved={theme.appearance} system={system} onChooseMode={vi.fn()} onSelect={onSelect} onRemove={vi.fn()} onExport={vi.fn()} onAddTheme={vi.fn()} />)
 return { shown, theme, onSelect, result }
}

describe('Omarchy Appearance', () => {
 it.each(['Windows', 'macOS'])('%s has exactly the original six choices in each half', system => {
  gallery(system)
  for (const mode of ['Light', 'Dark']) {
   const group = within(screen.getByRole('radiogroup', {name:`${mode} theme`}))
   expect(group.getAllByRole('radio')).toHaveLength(6)
   expect(group.queryByText('Omarchy')).toBeNull()
  }
 })
 it.each(['Windows', 'macOS'])('%s treats an existing imported omarchy id as an ordinary single-mode theme', system => {
  const custom = parseOmarchyTheme(fixtures.themes['tokyo-night'].rendered)
  const shown = { ...DEFAULT_SETTINGS, customThemes: [custom] }
  render(<ThemeGallery shown={shown} resolved="dark" system={system} onChooseMode={vi.fn()} onSelect={vi.fn()} onRemove={vi.fn()} onExport={vi.fn()} onAddTheme={vi.fn()} />)
  expect(within(screen.getByRole('radiogroup', {name:'Light theme'})).getAllByRole('radio')).toHaveLength(6)
  const dark = within(screen.getByRole('radiogroup', {name:'Dark theme'}))
  expect(dark.getAllByRole('radio')).toHaveLength(7)
  expect(dark.getByRole('radio', {name:'Omarchy'})).not.toHaveClass('theme-option--omarchy')
  expect(screen.queryByText(/Waits for/)).toBeNull()
 })
 it('names the current theme, offers a waiting half, and keeps the designed keyboard path', () => {
  const { onSelect } = gallery('Linux')
  const dark = within(screen.getByRole('radiogroup', {name:'Dark theme'}))
  const omarchy = dark.getByRole('radio', {name:'Omarchy Tokyo Night'})
  expect(omarchy).toHaveAttribute('aria-checked','true')
  expect(screen.getByText('Waits for a light Omarchy theme')).toBeVisible()
  fireEvent.keyDown(omarchy, {key:'ArrowDown'})
  expect(onSelect).toHaveBeenLastCalledWith({darkTheme:'t3-code'})
  fireEvent.keyDown(dark.getByRole('radio', {name:'Sotto'}), {key:'Home'})
  expect(onSelect).toHaveBeenLastCalledWith({darkTheme:'omarchy'})
  expect(omarchy).toHaveFocus()
 })
 it('repaints across Omarchy modes under Match Linux and preserves an explicit mode or palette', () => {
  const { shown, theme } = gallery('Linux', true)
  const root = document.createElement('div')
  expect(resolveAppearance('system',true,shown)).toBe('light')
  applyAppearance(appearancePreview.effective(shown), root,true,null,false)
  expect(root.dataset.themeId).toBe('omarchy')
  expect(root.style.getPropertyValue('--theme-canvas')).toBe(theme.colors.canvas)
  applyAppearance({...shown,appearance:'dark'},root,true,null,false)
  expect(root.dataset.themeId).toBe('t3-code')
  expect(root.dataset.theme).toBe('dark')
  expect(resolveAppearance('system',true,{...shown,lightTheme:'t3-code'})).toBe('dark')
 })
 it('explains the same Omarchy mode that the live widget preview wears', () => {
  const theme = parseOmarchyTheme(fixtures.themes['catppuccin-latte'].rendered)
  const shown = { ...DEFAULT_SETTINGS, lightTheme:'omarchy', darkTheme:'omarchy', omarchyTheme:theme }
  render(<ThemeLivePreview shown={shown} systemDark={true} system="Linux" />)
  expect(screen.getByText('The widget follows the Omarchy theme’s mode.')).toBeVisible()
  expect(document.querySelector('[data-widget-mode]')).toHaveAttribute('data-widget-mode','light')
 })
})
