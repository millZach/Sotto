/** OpenRouter model IDs, including account-scoped preset references. */
export const OPENROUTER_MODEL_ID = /^(?:[\w.\-/:]{1,128}|@preset\/[\w.-]{1,120})$/u

export function isOpenRouterPreset(id: string | null): id is `@preset/${string}` {
  return id !== null && /^@preset\/[\w.-]{1,120}$/u.test(id)
}
