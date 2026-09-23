import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { SshHostSuggestion } from '../../shared/hosts'

/**
 * The hosts the user's own SSH setup already knows, for Add host's suggestions: every `Host` alias in
 * `~/.ssh/config` and the files it includes, then the names in `~/.ssh/known_hosts`. This follows T3 Code's
 * `discoverSshHosts`. Wildcard and negated patterns are skipped, as are hashed known-hosts lines, which name
 * nothing readable. What is read stays on this computer: it goes to the window that asked and nowhere
 * else, and nothing here is logged.
 */

/** A configuration file larger than this is not an SSH configuration anyone wrote by hand. */
const FILE_LIMIT = 512 * 1024
/** Include chains deeper than this are a loop the visited set did not catch (a symlink, a case change). */
const DEPTH_LIMIT = 16
const SUGGESTION_LIMIT = 200

export interface SshConfigHost { readonly alias: string; readonly hostname?: string; readonly user?: string }
/** `includes` are the `Include` patterns in order; `includeAt` says how many of `hosts` were written before each. */
export interface ParsedSshConfig { readonly hosts: readonly SshConfigHost[]; readonly includes: readonly string[]; readonly includeAt: readonly number[] }

const pattern = (value: string): boolean => /[*?!]/u.test(value)
/** What Add host accepts as a host: the same shape `validateSshHost` checks. */
const addable = (value: string): boolean => value.length <= 253 && /^[a-z0-9][a-z0-9._-]*$/iu.test(value)

/** `Key value`, `Key=value` or `Key = value`, with the comment after `#` gone; quoted arguments keep their spaces. */
function directive(line: string): { key: string; args: string[] } | null {
  const text = line.replace(/#.*$/u, '').trim()
  const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/u.exec(text)
  if (!match) return null
  const args = [...match[2]!.matchAll(/"([^"]*)"|(\S+)/gu)].map(item => item[1] ?? item[2]!).filter(Boolean)
  return { key: match[1]!.toLowerCase(), args }
}

/**
 * One configuration file's aliases and the `Include` patterns it names, in order. A `Host` line's
 * `HostName` and `User` are kept for the aliases it names, the first value winning as it does in
 * OpenSSH; a `Match` block names no alias, so the lines under it are not attributed to the one before.
 */
export function parseSshConfig(text: string): ParsedSshConfig {
  const hosts = new Map<string, { alias: string; hostname?: string; user?: string }>()
  const includes: string[] = []
  const includeAt: number[] = []
  let current: string[] = []
  for (const line of text.split(/\r?\n/u)) {
    const entry = directive(line)
    if (!entry) continue
    if (entry.key === 'include') { for (const arg of entry.args) { includes.push(arg); includeAt.push(hosts.size) } continue }
    if (entry.key === 'match') { current = []; continue }
    if (entry.key === 'host') {
      current = entry.args.filter(alias => !pattern(alias))
      for (const alias of current) if (!hosts.has(alias)) hosts.set(alias, { alias })
      continue
    }
    const value = entry.args[0]
    if (!value || (entry.key !== 'hostname' && entry.key !== 'user')) continue
    for (const alias of current) {
      const host = hosts.get(alias)!
      if (entry.key === 'hostname' && host.hostname === undefined) host.hostname = value.replace(/%h/gu, alias)
      if (entry.key === 'user' && host.user === undefined) host.user = value
    }
  }
  return { hosts: [...hosts.values()], includes, includeAt }
}

/** The host names in a known_hosts file, with the port when it is not 22. Hashed and revoked lines are skipped. */
export function parseKnownHosts(text: string): { host: string; port?: number }[] {
  const found = new Map<string, { host: string; port?: number }>()
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    // `@cert-authority` lines name a pattern of hosts, and `@revoked` ones a key no one should trust.
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@') || trimmed.startsWith('|')) continue
    const field = trimmed.split(/\s+/u)[0]!
    for (const raw of field.split(',')) {
      const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/u.exec(raw)
      const host = bracketed ? bracketed[1]! : raw
      const port = bracketed ? Number(bracketed[2]) : 22
      if (!host || pattern(host) || !addable(host) || found.has(host)) continue
      found.set(host, { host, ...(port !== 22 && port > 0 && port <= 65535 ? { port } : {}) })
    }
  }
  return [...found.values()]
}

/** A simple `*` and `?` match on one file name, as `Include` uses; no other glob syntax. */
function globMatcher(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*').replace(/\?/gu, '.')}$`, 'u')
}

interface Files {
  readonly read: (path: string) => Promise<string | null>
  readonly list: (directory: string) => Promise<string[]>
}
const diskFiles: Files = {
  read: async path => {
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > FILE_LIMIT) return null
      return await readFile(path, 'utf8')
    } catch { return null }
  },
  list: async directory => { try { return await readdir(directory) } catch { return [] } },
}

async function includedPaths(value: string, home: string, files: Files): Promise<string[]> {
  const expanded = value.replace(/^~(?=$|[\\/])/u, home)
  // OpenSSH reads a relative Include from ~/.ssh, whichever file names it.
  const full = isAbsolute(expanded) ? expanded : resolve(join(home, '.ssh'), expanded)
  const name = basename(full)
  if (!/[*?]/u.test(name)) return [full]
  const matcher = globMatcher(name)
  return (await files.list(dirname(full))).filter(entry => matcher.test(entry)).sort().map(entry => join(dirname(full), entry))
}

async function configHosts(path: string, home: string, files: Files, visited: Set<string>, depth: number): Promise<SshConfigHost[]> {
  const key = resolve(path)
  if (depth > DEPTH_LIMIT || visited.has(key)) return []
  visited.add(key)
  const text = await files.read(key)
  if (text === null) return []
  const parsed = parseSshConfig(text)
  // An included file's hosts go where its Include line is, so the aliases keep the order they are written in.
  const hosts: SshConfigHost[] = []
  let next = 0
  for (const [index, include] of parsed.includes.entries()) {
    hosts.push(...parsed.hosts.slice(next, parsed.includeAt[index]))
    next = parsed.includeAt[index]!
    for (const file of await includedPaths(include, home, files)) hosts.push(...await configHosts(file, home, files, visited, depth + 1))
  }
  hosts.push(...parsed.hosts.slice(next))
  return hosts
}

/**
 * The aliases in the SSH configuration, in the order they are written, then the known hosts no alias
 * already goes to, sorted. A missing or unreadable file offers nothing rather than failing.
 */
export async function discoverSshHosts(options: { readonly home?: string; readonly files?: Files } = {}): Promise<SshHostSuggestion[]> {
  const home = options.home ?? homedir()
  const files = options.files ?? diskFiles
  if (!home) return []
  const suggestions = new Map<string, SshHostSuggestion>()
  const destinations = new Set<string>()
  for (const host of await configHosts(join(home, '.ssh', 'config'), home, files, new Set(), 0)) {
    if (!addable(host.alias) || suggestions.has(host.alias)) continue
    const hostname = host.hostname && !host.hostname.includes('%') ? host.hostname : undefined
    if (hostname) destinations.add(hostname)
    const detail = host.user ? `${host.user}@${hostname ?? host.alias}` : hostname !== undefined && hostname !== host.alias ? hostname : undefined
    suggestions.set(host.alias, { alias: host.alias, source: 'config', ...(detail ? { detail } : {}) })
  }
  const known = await files.read(join(home, '.ssh', 'known_hosts'))
  for (const entry of parseKnownHosts(known ?? '').sort((left, right) => left.host.localeCompare(right.host))) {
    if (suggestions.has(entry.host) || destinations.has(entry.host)) continue
    suggestions.set(entry.host, { alias: entry.host, source: 'known-hosts', ...(entry.port ? { port: entry.port, detail: `${entry.host}:${entry.port}` } : {}) })
  }
  return [...suggestions.values()].slice(0, SUGGESTION_LIMIT)
}
