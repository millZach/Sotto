import { z } from 'zod'

import { INTERFACE_LANGUAGE_CODES, isShownInterfaceLanguage, type InterfaceLanguageCode, type InterfaceLanguageState, type ShownInterfaceLanguage } from './interfaceLanguages'

/** What a window is in now, asked once it has loaded, in case the language changed after the window was made. */
export const INTERFACE_LANGUAGE_GET = 'sotto:interface-language:get' as const
/** Sent to every window when the interface language changes. */
export const INTERFACE_LANGUAGE_CHANGED = 'sotto:interface-language:changed' as const
/**
 * Given to both windows while the `interface-language` Owl feature is on (ADR-0122), carrying the language as the window
 * is made, `--sotto-interface-language=ja,en`: the language shown, then the computer's. A window draws its first frame in
 * it without asking main, which trusts a window only once it has loaded. Without it a window stays English.
 */
export const INTERFACE_LANGUAGE_RENDERER_ARGUMENT = '--sotto-interface-language='

export const interfaceLanguageStateSchema: z.ZodType<InterfaceLanguageState> = z.object({
  language: z.string().refine(isShownInterfaceLanguage).transform(value => value as ShownInterfaceLanguage),
  system: z.enum(INTERFACE_LANGUAGE_CODES as [InterfaceLanguageCode, ...InterfaceLanguageCode[]]),
}).strict()

export function interfaceLanguageArgument(state: InterfaceLanguageState): string {
  return `${INTERFACE_LANGUAGE_RENDERER_ARGUMENT}${state.language},${state.system}`
}

/** The language a window's arguments carry, or null when the Owl feature is off or the argument is not one. */
export function parseInterfaceLanguageArgument(arguments_: readonly string[]): InterfaceLanguageState | null {
  const matches = arguments_.filter(argument => argument.startsWith(INTERFACE_LANGUAGE_RENDERER_ARGUMENT))
  if (matches.length !== 1) return null
  const [language, system, ...rest] = matches[0]!.slice(INTERFACE_LANGUAGE_RENDERER_ARGUMENT.length).split(',')
  const parsed = interfaceLanguageStateSchema.safeParse({ language, system })
  return rest.length === 0 && parsed.success ? parsed.data : null
}

/** A window's view of the interface language: main resolves it from the setting and the computer's languages. */
export interface InterfaceLanguageBridge {
  /** The language as the window was made, for its first frame. */
  readonly startup: InterfaceLanguageState
  current(): Promise<InterfaceLanguageState>
  onChanged(listener: (state: InterfaceLanguageState) => void): () => void
}
