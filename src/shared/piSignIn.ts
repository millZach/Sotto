import { z } from 'zod'
import type { OpenCodeSignInBridge } from './opencodeSignIn'

export const PI_RENDERER_ARGUMENT = '--sotto-pi-enabled'
export const PI_SIGN_IN = 'sotto:pi:sign-in'
export interface PiSource { readonly id: string; readonly name: string; readonly keyLabel?: string; readonly oauthLabel?: string; readonly hosts?: readonly string[]; readonly mode?: 'code' | 'auto' }
/** Pi 1.5.2's single-key and browser/device flows. Cloud setup flows needing further configuration are left out. */
export const PI_SOURCES: readonly PiSource[] = [
  {"id": "ant-ling", "name": "Ant Ling", "keyLabel": "Ant Ling API key"},
  {"id": "anthropic", "name": "Anthropic", "keyLabel": "Anthropic API key", "oauthLabel": "Anthropic (Claude Pro/Max)", "hosts": ["claude.ai"], "mode": "code"},
  {"id": "baseten", "name": "Baseten", "keyLabel": "Baseten API key"},
  {"id": "cerebras", "name": "Cerebras", "keyLabel": "Cerebras API key"},
  {"id": "deepseek", "name": "DeepSeek", "keyLabel": "DeepSeek API key"},
  {"id": "fireworks", "name": "Fireworks", "keyLabel": "Fireworks API key"},
  {"id": "github-copilot", "name": "GitHub Copilot", "keyLabel": "GitHub Copilot token", "oauthLabel": "GitHub Copilot", "hosts": ["github.com"], "mode": "auto"},
  {"id": "google", "name": "Google", "keyLabel": "Gemini API key"},
  {"id": "groq", "name": "Groq", "keyLabel": "Groq API key"},
  {"id": "huggingface", "name": "Hugging Face", "keyLabel": "Hugging Face token"},
  {"id": "kimi-coding", "name": "Kimi For Coding", "keyLabel": "Kimi API key", "oauthLabel": "Kimi Code (subscription)", "hosts": ["www.kimi.com"], "mode": "auto"},
  {"id": "meta", "name": "Meta", "keyLabel": "Meta Model API key", "oauthLabel": "Meta (Muse subscription)", "hosts": ["auth.meta.com"], "mode": "auto"},
  {"id": "minimax", "name": "MiniMax", "keyLabel": "MiniMax API key"},
  {"id": "minimax-cn", "name": "MiniMax CN", "keyLabel": "MiniMax CN API key"},
  {"id": "mistral", "name": "Mistral", "keyLabel": "Mistral API key"},
  {"id": "moonshotai", "name": "Moonshot AI", "keyLabel": "Moonshot AI API key"},
  {"id": "moonshotai-cn", "name": "Moonshot AI CN", "keyLabel": "Moonshot AI API key"},
  {"id": "nvidia", "name": "NVIDIA", "keyLabel": "NVIDIA API key"},
  {"id": "openai", "name": "OpenAI", "keyLabel": "OpenAI API key", "oauthLabel": "OpenAI (ChatGPT subscription)", "hosts": ["auth.openai.com"], "mode": "auto"},
  {"id": "openai-codex", "name": "OpenAI Codex", "oauthLabel": "OpenAI (ChatGPT Plus/Pro)", "hosts": ["auth.openai.com"], "mode": "auto"},
  {"id": "opencode", "name": "OpenCode Zen", "keyLabel": "OpenCode API key"},
  {"id": "opencode-go", "name": "OpenCode Go", "keyLabel": "OpenCode API key"},
  {"id": "openrouter", "name": "OpenRouter", "keyLabel": "OpenRouter API key", "oauthLabel": "OpenRouter OAuth", "hosts": ["openrouter.ai"], "mode": "auto"},
  {"id": "qwen-token-plan", "name": "Qwen Token Plan", "keyLabel": "Qwen Token Plan API key"},
  {"id": "qwen-token-plan-cn", "name": "Qwen Token Plan CN", "keyLabel": "Qwen Token Plan CN API key"},
  {"id": "qwen-token-plan-individual", "name": "Qwen Token Plan Individual", "keyLabel": "Qwen Token Plan Individual API key"},
  {"id": "qwen-token-plan-individual-cn", "name": "Qwen Token Plan Individual CN", "keyLabel": "Qwen Token Plan Individual CN API key"},
  {"id": "radius", "name": "Radius", "keyLabel": "Radius API key", "oauthLabel": "Radius", "hosts": ["radius.earendil.com"], "mode": "auto"},
  {"id": "together", "name": "Together", "keyLabel": "Together API key"},
  {"id": "typesafe", "name": "TypeSafe", "keyLabel": "TypeSafe API key"},
  {"id": "vercel-ai-gateway", "name": "Vercel AI Gateway", "keyLabel": "Vercel AI Gateway API key"},
  {"id": "xai", "name": "xAI", "keyLabel": "xAI API key", "oauthLabel": "xAI (Grok/X subscription)", "hosts": ["accounts.x.ai"], "mode": "auto"},
  {"id": "xiaomi", "name": "Xiaomi", "keyLabel": "Xiaomi API key"},
  {"id": "xiaomi-token-plan-ams", "name": "Xiaomi Token Plan AMS", "keyLabel": "Xiaomi Token Plan AMS API key"},
  {"id": "xiaomi-token-plan-cn", "name": "Xiaomi Token Plan CN", "keyLabel": "Xiaomi Token Plan CN API key"},
  {"id": "xiaomi-token-plan-sgp", "name": "Xiaomi Token Plan SGP", "keyLabel": "Xiaomi Token Plan SGP API key"},
  {"id": "zai", "name": "Z.AI", "keyLabel": "Z.AI API key"},
  {"id": "zai-coding-cn", "name": "Z.AI Coding CN", "keyLabel": "Z.AI Coding CN API key"},
]
export type PiSignInBridge = OpenCodeSignInBridge
export const piSignInCallSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('sources') }).strict(),
  z.object({ action: z.literal('key'), request: z.object({ sourceId: z.string().min(1).max(160), key: z.string().min(1).max(4096) }).strict() }).strict(),
  z.object({ action: z.literal('browser'), request: z.object({ sourceId: z.string().min(1).max(160), methodId: z.literal('browser') }).strict() }).strict(),
  z.object({ action: z.literal('wait'), request: z.object({ attemptId: z.string().min(1).max(200) }).strict() }).strict(),
  z.object({ action: z.literal('finish'), request: z.object({ attemptId: z.string().min(1).max(200), code: z.string().min(1).max(2048) }).strict() }).strict(),
  z.object({ action: z.literal('reopen'), request: z.object({ attemptId: z.string().min(1).max(200) }).strict() }).strict(),
  z.object({ action: z.literal('cancel'), request: z.object({ attemptId: z.string().min(1).max(200) }).strict() }).strict(),
  z.object({ action: z.literal('sign-out'), request: z.object({ sourceId: z.string().min(1).max(160) }).strict() }).strict(),
])
export type PiSignInCall = z.infer<typeof piSignInCallSchema>
