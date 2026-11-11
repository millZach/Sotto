import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AgentSkillCatalog, AgentSkillReference } from '../../shared/agentSkills'
import { selectedSkill } from './providers/claude/claudeSkills'

type HermesSkill = AgentSkillCatalog['skills'][number]
/** A folder Hermes reads skills from, and whose they are: the project profile's own, or the ones every project shares. */
export interface HermesSkillRoot { readonly directory: string; readonly scope: 'repo' | 'user' }

// Hermes 0.23.1 lists no skill over ACP and has no machine-readable `skills list`, so Sotto reads the folders it reads.
const NAME_LINE = /^name:[ \t]*(.+)$/mu
const DESCRIPTION_LINE = /^description:[ \t]*(.*(?:\r?\n[ \t]+.*)*)$/mu
/** A name that can follow a slash as one token. */
const INVOCABLE = /^\w[\w.-]*$/u
/** How deep a skill sits under its root: `category/skill/SKILL.md`, with room for one more folder. */
const MAX_DEPTH = 3

/** A front matter value as plain words: no block marker, no line folding, no quotes around it. */
function plain(value: string | undefined): string | undefined {
  return value?.replace(/^[>|][+-]?\s*/u, '').replace(/\s+/gu, ' ').trim().replace(/^(["'])(.*)\1$/u, '$2')
}

/** Every `SKILL.md` under a folder, in name order. A folder that holds one is a skill, and is not searched further. */
async function skillFiles(directory: string, depth = 0): Promise<string[]> {
  // A profile that has written no skill has no folder yet.
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  if (entries.some(entry => entry.isFile() && entry.name === 'SKILL.md')) return [join(directory, 'SKILL.md')]
  if (depth >= MAX_DEPTH) return []
  const folders = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules').map(entry => entry.name).sort()
  return (await Promise.all(folders.map(name => skillFiles(join(directory, name), depth + 1)))).flat()
}

/**
 * Hermes's skills for a thread, as `/name`. The first root to name a skill keeps the name, as Hermes resolves a
 * profile's own skill ahead of a shared one.
 */
export async function discoverHermesSkills(threadId: string, cwd: string, roots: readonly HermesSkillRoot[]): Promise<AgentSkillCatalog> {
  const skills = new Map<string, HermesSkill>()
  for (const root of roots) {
    for (const path of await skillFiles(root.directory)) {
      const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(await readFile(path, 'utf8'))?.[1] ?? ''
      const name = plain(NAME_LINE.exec(front)?.[1]) || basename(dirname(path))
      if (!INVOCABLE.test(name) || skills.has(name)) continue
      skills.set(name, { name, path, description: plain(DESCRIPTION_LINE.exec(front)?.[1]) ?? '', scope: root.scope, enabled: true, userInvocable: true, invocation: `/${name}` })
    }
  }
  return { threadId, providerId: 'hermes', cwd, status: 'ready', errors: [], maxSkillsPerMessage: 1,
    skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)) }
}

/** The skill a message invokes: the one picked in the composer, or a listed one whose `/name` opens the words. */
export function invokedHermesSkill(text: string, picked: readonly AgentSkillReference[], catalog: AgentSkillCatalog): HermesSkill | undefined {
  const typed = /^\s*\/(\S+)/u.exec(text)?.[1]
  return selectedSkill(picked, catalog) ?? catalog.skills.find(skill => skill.name === typed)
}

/**
 * The words Hermes is sent for an invoked skill. Hermes 0.23.1 expands `/name` in its own terminal and chat apps but
 * not over ACP, where an unknown slash word is ordinary prompt text, so Sotto writes what Hermes itself would have:
 * its note that the user invoked the skill, the skill file, the folder its paths are relative to, and what the user
 * wrote beside the name.
 */
export function hermesSkillPrompt(text: string, skill: Pick<HermesSkill, 'name' | 'path'>, content: string): string {
  const token = new RegExp(`(^|\\s)/${skill.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?=\\s|$)[ \\t]*`, 'u')
  const instruction = text.replace(token, '$1').trim()
  return [`[IMPORTANT: The user has invoked the "${skill.name}" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]`,
    '', content.trim(), '', `[Skill directory: ${dirname(skill.path)}]`, 'Resolve any relative paths in this skill against that directory.',
    ...(instruction ? ['', `The user has provided the following instruction alongside the skill invocation: ${instruction}`] : [])].join('\n')
}
