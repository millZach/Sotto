/*
 * The main-window bridge for theme files and Open VSX (ADR-0011).
 *
 * The renderer's content security policy allows no network, and it has no file
 * system, so saving an exported theme to disk and talking to Open VSX happen
 * in the main process. Theme files are read in the renderer from a file input
 * or a drop, which needs no bridge. Every request and result is parsed on
 * both sides of IPC; installed themes come back as full, canonical
 * definitions and are validated again before they reach settings.
 */

import { z } from 'zod'

import { customThemeSchema } from './library'
import type { ThemeDefinition } from './palettes'

const THEMES_CHANNEL = 'themes:'
export const THEMES_EXPORT = `${THEMES_CHANNEL}export`
export const THEMES_SEARCH = `${THEMES_CHANNEL}searchOpenVsx`
export const THEMES_INSTALL = `${THEMES_CHANNEL}installOpenVsx`

/** A full theme export is a few KB; anything larger is not a theme file. */
export const MAX_THEME_FILE_BYTES = 256 * 1024

export const OPEN_VSX_SORTS = ['downloadCount', 'rating', 'timestamp', 'relevance'] as const
export type OpenVsxThemeSort = (typeof OPEN_VSX_SORTS)[number]

export const themesErrorSchema = z.object({
  code: z.enum(['invalid-request', 'unavailable', 'too-large', 'network', 'rejected', 'cancelled']),
  message: z.string().max(2000),
}).strict()
export type ThemesError = z.infer<typeof themesErrorSchema>
export type ThemesResult<T> = { ok: true; value: T } | { ok: false; error: ThemesError }

export function themesResultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), error: themesErrorSchema }).strict(),
  ])
}

export const themeExportRequestSchema = z.object({
  fileName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}\.json$/u),
  contents: z.string().min(2).max(MAX_THEME_FILE_BYTES),
}).strict()
export type ThemeExportRequest = z.infer<typeof themeExportRequestSchema>
export const themeExportResultSchema = z.object({ saved: z.boolean() }).strict()

export const openVsxSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(100),
  sortBy: z.enum(OPEN_VSX_SORTS),
}).strict()
export type OpenVsxSearchRequest = z.infer<typeof openVsxSearchRequestSchema>

const extensionIdPart = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/u)

export const openVsxExtensionSchema = z.object({
  id: z.string().max(128),
  namespace: extensionIdPart,
  name: extensionIdPart,
  collectionId: z.string().regex(/^[a-z0-9][a-z0-9.:-]{0,127}$/u),
  displayName: z.string().max(200),
  description: z.string().max(500),
  downloadCount: z.number().finite().min(0),
  sourceUrl: z.string().url().max(500).nullable(),
  version: z.string().max(64),
  license: z.string().max(32),
}).strict()
export type OpenVsxThemeExtension = z.infer<typeof openVsxExtensionSchema>

export const openVsxSearchResultSchema = z.array(openVsxExtensionSchema).max(16)

/** Only the identity crosses from the renderer: main re-reads every URL from Open VSX itself. */
export const openVsxInstallRequestSchema = z.object({ namespace: extensionIdPart, name: extensionIdPart }).strict()
export type OpenVsxInstallRequest = z.infer<typeof openVsxInstallRequestSchema>

export const openVsxInstallResultSchema = z.object({
  extension: openVsxExtensionSchema,
  themes: z.array(customThemeSchema).min(1).max(40),
}).strict()
export interface OpenVsxInstallResult {
  readonly extension: OpenVsxThemeExtension
  readonly themes: ThemeDefinition[]
}

export interface ThemesBridge {
  exportTheme(request: ThemeExportRequest): Promise<ThemesResult<{ saved: boolean }>>
  searchOpenVsx(request: OpenVsxSearchRequest): Promise<ThemesResult<OpenVsxThemeExtension[]>>
  installOpenVsx(request: OpenVsxInstallRequest): Promise<ThemesResult<OpenVsxInstallResult>>
}
