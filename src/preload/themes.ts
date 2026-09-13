import { z } from 'zod'

import {
  THEMES_EXPORT,
  THEMES_INSTALL,
  THEMES_SEARCH,
  openVsxInstallRequestSchema,
  openVsxInstallResultSchema,
  openVsxSearchRequestSchema,
  openVsxSearchResultSchema,
  themeExportRequestSchema,
  themeExportResultSchema,
  themesResultSchema,
  type ThemesBridge,
} from '../shared/themes/bridge'
import type { IpcRendererAdapter } from './index'

export function createThemesBridge(renderer: IpcRendererAdapter): ThemesBridge {
  const call = async <T>(channel: string, input: z.ZodType, output: z.ZodType<T>, payload: unknown): Promise<z.infer<ReturnType<typeof themesResultSchema<z.ZodType<T>>>>> =>
    themesResultSchema(output).parse(await renderer.invoke(channel, input.parse(payload)))
  return Object.freeze<ThemesBridge>({
    exportTheme: request => call(THEMES_EXPORT, themeExportRequestSchema, themeExportResultSchema, request) as ReturnType<ThemesBridge['exportTheme']>,
    searchOpenVsx: request => call(THEMES_SEARCH, openVsxSearchRequestSchema, openVsxSearchResultSchema, request) as ReturnType<ThemesBridge['searchOpenVsx']>,
    installOpenVsx: request => call(THEMES_INSTALL, openVsxInstallRequestSchema, openVsxInstallResultSchema, request) as ReturnType<ThemesBridge['installOpenVsx']>,
  })
}
