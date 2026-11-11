import { readdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AgentSkillCatalog, AgentSkillReference } from '../../shared/agentSkills'
import { selectedSkill } from './providers/claude/claudeSkills'

type HermesSkill = AgentSkillCatalog['skills'][number]
/** A folder Hermes reads skills from, and whose they are: the project profile's own, or the ones every project shares. */
export interface HermesSkillRoot { readonly directory: string; readonly scope: 'repo' | 'user' }

// Hermes 0.23.1 lists no skill over ACP and has no machine-readable `skills list`, so Sotto reads the folders Hermes
// reads, by Hermes's own rules (`agent/skill_utils.py`, `agent/skill_commands.py`).
const NAME_LINE = /^name:[ \t]*(.+)$/mu
const DESCRIPTION_LINE = /^description:[ \t]*(.*(?:\r?\n[ \t]+.*)*)$/mu
/** Folders Hermes never looks in for a skill; Sotto leaves out every dot folder with them. */
const SKIPPED = new Set(['venv', 'node_modules', 'site-packages', '__pycache__'])
/** A skill's own folders of supporting files, which hold no skill. */
const SUPPORT = new Set(['references', 'templates', 'assets', 'scripts'])

/** The word after the slash for a skill's name, as Hermes writes it: `Code Review` and `code_review` are `/code-review`. */
export function hermesSkillSlug(name: string): string {
  return name.toLowerCase().replace(/[ _]/gu, '-').replace(/[^\p{L}\p{N}-]/gu, '').replace(/-{2,}/gu, '-').replace(/^-+|-+$/gu, '')
}

/** A front matter value as plain words: no block marker, no line folding, no quotes around it and no comment after it. */
function plain(value: string | undefined): string | undefined {
  const text = value?.replace(/^[>|][+-]?[ \t]*/u, '').replace(/\s+/gu, ' ').trim()
  if (!text) return undefined
  const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/u.exec(text)
  return quoted ? quoted[2] : text.replace(/\s+#.*$/u, '')
}

/**
 * Every `SKILL.md` under a folder, as Hermes walks it: links followed, a skill's supporting folders left out. `seen`
 * holds the real folders already read, so a link back up the tree ends there.
 */
async function skillFiles(directory: string, seen = new Set<string>()): Promise<string[]> {
  // A profile that has written no skill has no folder yet, and a link can point nowhere.
  const real = await realpath(directory).catch(() => undefined)
  if (real === undefined || seen.has(real)) return []
  seen.add(real)
  // A link to a file is no folder.
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const isSkill = entries.some(entry => entry.name === 'SKILL.md' && !entry.isDirectory())
  const found = isSkill ? [join(directory, 'SKILL.md')] : []
  const folders = entries.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.') && !SKIPPED.has(entry.name)
    && !(isSkill && SUPPORT.has(entry.name))).map(entry => entry.name).sort()
  for (const name of folders) found.push(...await skillFiles(join(directory, name), seen))
  return found
}

/**
 * Hermes's skills for a thread, each named by the word that follows its slash. The first root to name a skill keeps
 * the name, as Hermes resolves a profile's own skill ahead of a shared one. A skill file that cannot be read is left
 * out, so it never takes the others with it.
 */
export async function discoverHermesSkills(threadId: string, cwd: string, roots: readonly HermesSkillRoot[]): Promise<AgentSkillCatalog> {
  const skills = new Map<string, HermesSkill>()
  for (const root of roots) {
    for (const path of await skillFiles(root.directory)) {
      const text = await readFile(path, 'utf8').catch(() => undefined)
      if (text === undefined) continue
      // A byte order mark ahead of the fence would hide the front matter.
      const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text.replace(/^\uFEFF/u, ''))?.[1] ?? ''
      const name = hermesSkillSlug(plain(NAME_LINE.exec(front)?.[1]) || basename(dirname(path)))
      if (!name || skills.has(name)) continue
      skills.set(name, { name, path, description: plain(DESCRIPTION_LINE.exec(front)?.[1]) ?? '', scope: root.scope, enabled: true, userInvocable: true, invocation: `/${name}` })
    }
  }
  return { threadId, providerId: 'hermes', cwd, status: 'ready', errors: [], maxSkillsPerMessage: 1,
    skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)) }
}

/** Whether a word after a slash names this skill. A word with a slash in it is a path, as it is to Hermes. */
function names(word: string, skill: Pick<HermesSkill, 'name'>): boolean { return !word.includes('/') && hermesSkillSlug(word) === skill.name }

/** The skill a message invokes: the one picked in the composer, or a listed one whose `/name` opens the words. */
export function invokedHermesSkill(text: string, picked: readonly AgentSkillReference[], catalog: AgentSkillCatalog): HermesSkill | undefined {
  const typed = /^\s*\/(\S+)/u.exec(text)?.[1]
  return selectedSkill(picked, catalog) ?? (typed === undefined ? undefined : catalog.skills.find(skill => names(typed, skill)))
}

/**
 * The words Hermes is sent for an invoked skill. Hermes 0.23.1 expands `/name` in its own terminal and chat apps but
 * not over ACP, where an unknown slash word is ordinary prompt text, so Sotto writes what Hermes itself would have:
 * its note that the user invoked the skill, the skill file, the folder its paths are relative to, and what the user
 * wrote beside the name.
 */
export function hermesSkillPrompt(text: string, skill: Pick<HermesSkill, 'name' | 'path'>, content: string): string {
  let taken = false
  // The first mention of the skill is its invocation; the rest of the words are the instruction.
  const instruction = text.replace(/(^|\s)\/(\S+)[ \t]*/gu, (whole, lead: string, word: string) => {
    if (taken || !names(word, skill)) return whole
    taken = true
    return lead
  }).trim()
  return [`[IMPORTANT: The user has invoked the "${skill.name}" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]`,
    '', content.trim(), '', `[Skill directory: ${dirname(skill.path)}]`, 'Resolve any relative paths in this skill against that directory.',
    ...(instruction ? ['', `The user has provided the following instruction alongside the skill invocation: ${instruction}`] : [])].join('\n')
}
