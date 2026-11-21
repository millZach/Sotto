/** The four ways Antigravity's `agy` signs in, as its `initialize` names them and T3 Code offers them (ADR-0212). */
export const ANTIGRAVITY_SIGN_IN_METHODS = ['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform'] as const
export type AntigravitySignInMethod = typeof ANTIGRAVITY_SIGN_IN_METHODS[number]
/** The methods that sign in in a browser; the other two take a key, or a project and location, and connect from the row. */
export const ANTIGRAVITY_BROWSER_METHODS: readonly AntigravitySignInMethod[] = ['oauth-personal', 'oauth-business']
