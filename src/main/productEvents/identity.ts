import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Who a product event is from (ADR-0179): a random ID for this install, and the hashed account IDs Claude Code and Codex
 * keep on this machine. Sotto reads no other part of those files, keeps nothing it reads, and logs none of it.
 * What these reads take from each client's files follows T3 Code's Identify.ts (MIT, see THIRD_PARTY_NOTICES.md).
 */

export const PRODUCT_EVENTS_INSTALL_FILE = 'product-events-install-id'
/** So these hashes match no other app's hashes of the same account ID. */
const HASH_PREFIX = 'sotto-product-events-v1:'
const INSTALL_ID = /^[0-9a-f-]{36}$/
/** auth.json is small; anything larger is not a file this was written for. */
const MAX_AUTH_FILE_BYTES = 256 * 1024
/** .claude.json keeps a record of every project and can grow, so it is scanned a piece at a time and never parsed whole. */
const MAX_CLAUDE_FILE_BYTES = 64 * 1024 * 1024
const SCAN_OVERLAP_CHARACTERS = 128
const CLAUDE_ACCOUNT = /"accountUuid"\s*:\s*"([0-9a-fA-F-]{36})"/

export function hashProductEventId(value: string): string {
  return createHash('sha256').update(HASH_PREFIX + value).digest('hex')
}

/** This install's hashed ID, making the random one it comes from the first time. Null when the folder cannot be written. */
export async function ensureInstallId(dataDirectory: string): Promise<string | null> {
  const path = join(dataDirectory, PRODUCT_EVENTS_INSTALL_FILE)
  try {
    const saved = (await readFile(path, 'utf8')).trim()
    if (INSTALL_ID.test(saved)) return hashProductEventId(saved)
  } catch { /* None yet. */ }
  try {
    const made = randomUUID()
    await mkdir(dirname(path), { recursive: true })
    const partial = `${path}.${process.pid}.tmp`
    await writeFile(partial, made, { encoding: 'utf8', mode: 0o600 })
    await rename(partial, path)
    return hashProductEventId(made)
  } catch { return null }
}

/** Turning off leaves no ID behind. A later turn on makes a new one. */
export async function deleteInstallId(dataDirectory: string): Promise<void> {
  await rm(join(dataDirectory, PRODUCT_EVENTS_INSTALL_FILE), { force: true }).catch(() => undefined)
}

/** The value of one pattern's first group, a piece of the file at a time, so a large file never holds the event loop. */
async function scanFile(path: string, pattern: RegExp, maxBytes: number): Promise<string | null> {
  const size = (await stat(path)).size
  if (size > maxBytes) return null
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 })
  try {
    let tail = ''
    for await (const piece of stream as AsyncIterable<string>) {
      const text = tail + piece
      const found = pattern.exec(text)
      if (found?.[1]) return found[1]
      tail = text.slice(-SCAN_OVERLAP_CHARACTERS)
    }
    return null
  } finally { stream.destroy() }
}

/**
 * The OpenAI `user_id` claim in Codex's ChatGPT sign-in, the one ID every login method and no one else shares. `account_id`
 * is the workspace a whole Team shares and `sub` is per login method. The file also holds live sign-in tokens, so only the
 * `id_token` is taken from it, only its middle part is decoded, and only the claim leaves this function. Its signature is
 * not checked: this needs a stable ID, not proof.
 */
export function openAiUserId(authFile: string): string | null {
  const token = /"id_token"\s*:\s*"([^"]+)"/.exec(authFile)?.[1]
  const claims = token?.split('.')[1]
  if (!claims) return null
  try {
    const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<string, { user_id?: unknown } | undefined>
    const id = decoded['https://api.openai.com/auth']?.user_id
    return typeof id === 'string' && id.trim() !== '' ? id : null
  } catch { return null }
}

async function readCodexAccount(codexHome: string): Promise<string | null> {
  const path = join(codexHome, 'auth.json')
  const file = await open(path, 'r')
  try {
    if ((await file.stat()).size > MAX_AUTH_FILE_BYTES) return null
    return openAiUserId(await file.readFile('utf8'))
  } finally { await file.close() }
}

export interface ProductEventOwner { readonly ownerSource: 'claude' | 'openai'; readonly ownerId: string }

export interface ProductEventHomes {
  /** `CLAUDE_CONFIG_DIR`, whose `.claude.json` Claude Code then reads; otherwise the home folder holds it. */
  readonly claudeFile?: string
  readonly codexHome?: string
}

export function productEventHomes(environment: NodeJS.ProcessEnv = process.env, home: string = homedir()): Required<ProductEventHomes> {
  return {
    claudeFile: environment.CLAUDE_CONFIG_DIR ? join(environment.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json'),
    codexHome: environment.CODEX_HOME || join(home, '.codex'),
  }
}

/** The accounts signed in on this machine, hashed. A file that is missing or unreadable only leaves that account out. */
export async function readProductEventOwners(homes: Required<ProductEventHomes>): Promise<ProductEventOwner[]> {
  const [claude, openAi] = await Promise.all([
    scanFile(homes.claudeFile, CLAUDE_ACCOUNT, MAX_CLAUDE_FILE_BYTES).catch(() => null),
    readCodexAccount(homes.codexHome).catch(() => null),
  ])
  return [
    ...claude ? [{ ownerSource: 'claude' as const, ownerId: hashProductEventId(claude) }] : [],
    ...openAi ? [{ ownerSource: 'openai' as const, ownerId: hashProductEventId(openAi) }] : [],
  ]
}
