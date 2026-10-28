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

/** Each channel's answer, built once: building a schema costs far more than parsing with one. */
const exportResult = themesResultSchema(themeExportResultSchema)
const searchResult = themesResultSchema(openVsxSearchResultSchema)
const installResult = themesResultSchema(openVsxInstallResultSchema)

export function createThemesBridge(renderer: IpcRendererAdapter): ThemesBridge {
  const call = async <Result extends z.ZodType>(channel: string, input: z.ZodType, result: Result, payload: unknown): Promise<z.output<Result>> =>
    result.parse(await renderer.invoke(channel, input.parse(payload)))
  return Object.freeze<ThemesBridge>({
    exportTheme: request => call(THEMES_EXPORT, themeExportRequestSchema, exportResult, request) as ReturnType<ThemesBridge['exportTheme']>,
    searchOpenVsx: request => call(THEMES_SEARCH, openVsxSearchRequestSchema, searchResult, request) as ReturnType<ThemesBridge['searchOpenVsx']>,
    installOpenVsx: request => call(THEMES_INSTALL, openVsxInstallRequestSchema, installResult, request) as ReturnType<ThemesBridge['installOpenVsx']>,
  })
}
