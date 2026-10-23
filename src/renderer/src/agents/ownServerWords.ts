import { i18n } from '@lingui/core'
import { plural, t } from '@lingui/core/macro'

import { OWN_SERVER_CONTEXT_MAX, OWN_SERVER_CONTEXT_MIN, type OwnServerKind, type OwnServerRefusal } from '../../../shared/ownModelServers'

/**
 * Every sentence Your own model servers says in the window (ADR-0124), in the interface language (ADR-0123). Main sends
 * its refusals in English beside a reason, since src/shared is built into the headless host without the macro
 * transform; the window words each reason here instead and shows main's English only for a reason it does not know.
 */

/** A server's kind by its own name; only a server that did not say what it is gets words. */
export function kindName(kind: OwnServerKind): string {
  switch (kind) {
    case 'vllm': return 'vLLM'
    case 'sglang': return 'SGLang'
    case 'ollama': return 'Ollama'
    case 'lmstudio': return 'LM Studio'
    case 'llamacpp': return 'llama.cpp'
    case 'tgi': return 'Text Generation Inference'
    case 'openai-compatible': return t({ message: 'An OpenAI-compatible server', comment: 'A model server that answers the OpenAI API but did not say which program it is.' })
  }
}

/** "Llama 3 and Qwen 3", in the reader's language. */
export function listNames(names: readonly string[]): string {
  return new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(names)
}

/** Milliseconds as the reader's language writes a number. */
const millis = (ms: number): string => i18n.number(ms)

export const modelCount = (count: number): string => plural(count, { one: '# model', other: '# models' })

/** What the user is told after Add: where the models are now. */
export const addedWords = (name: string): string => t`Added ${name}. Its models are in the model menu under ${name}, with OpenCode.`
export const removedWords = (name: string): string =>
  t`Removed ${name}. Its models are gone from the model menu. Threads that used them keep their history; pick another model in them to go on.`
export const notAnswered = (): string => t`Sotto could not reach its own side of this. Nothing was saved. Try again.`
export const notAnsweredSaved = (): string => t`Sotto could not reach its own side of this. Nothing was changed. Try again.`
export const removeFailed = (name: string): string => t`Sotto could not remove ${name}. Nothing was changed. Try again.`
export const keyNote = (): string => t`OpenCode keeps the key in Sotto’s OpenCode folder, and Sotto keeps no copy.`
export const privacyWords = (): string => t`Threads on this server send your code and messages to it, so whoever runs it can read them.`
export const contextUnknown = (): string => t`The server does not say how much context this model has. Type it from the model’s page.`
export function contextRange(): string {
  const min = i18n.number(OWN_SERVER_CONTEXT_MIN), max = i18n.number(OWN_SERVER_CONTEXT_MAX)
  return t({ message: `Type a number of tokens from ${min} to ${max}, such as 131072 or 128K.`, comment: '128K means 128 times 1,024 tokens; keep 131072 and 128K as they are.' })
}

/** The line under a check that answered: what answered, how fast, and how many models it has. */
export function answeredWords(kind: OwnServerKind, answeredMs: number, models: number): string {
  const who = kindName(kind), ms = millis(answeredMs), count = modelCount(models)
  return t({ message: `${who} answered in ${ms} ms with ${count}.`, comment: '{who} is a server program such as Ollama; {count} is a number of models, as in "2 models".' })
}

/** What Check again found on a saved server. */
export function checkedAgainWords(kind: OwnServerKind, answeredMs: number, gone: readonly string[], extra: readonly string[]): string {
  const who = kindName(kind), ms = millis(answeredMs)
  const lines = [t({ message: `${who} answered in ${ms} ms.`, comment: '{who} is a server program such as Ollama.' })]
  if (gone.length) {
    const names = listNames(gone)
    lines.push(plural(gone.length, {
      one: `It no longer lists ${names}, so threads on it will fail until the server loads it again.`,
      other: `It no longer lists ${names}, so threads on them will fail until the server loads them again.`,
    }))
  }
  if (extra.length) {
    const names = listNames(extra)
    lines.push(plural(extra.length, {
      one: `It also lists ${names}, which is not added. To use it, remove the server and add it again.`,
      other: `It also lists ${names}, which are not added. To use them, remove the server and add it again.`,
    }))
  }
  return lines.join(' ')
}

/** Check again on a server added with a key, which only OpenCode has. */
export const keyKeptWords = (name: string, answeredMs: number): string => {
  const ms = millis(answeredMs)
  return t`${name} answered in ${ms} ms and asks for its key, which OpenCode keeps, so Sotto could not read its models again.`
}

/** What the window was doing when main refused, since one reason reads differently for an add and a remove. */
export type OwnServerDoing = 'check' | 'add' | 'check-saved' | 'remove'

/**
 * A refusal in the interface language. `host` is the address's host and port, `name` the server's. `english` is main's
 * own words, shown only for a reason this build of the window does not know.
 */
export function refusalWords(reason: OwnServerRefusal | string, doing: OwnServerDoing, host: string, name: string, english?: string): string {
  switch (reason) {
    case 'bad-address': return t`That is not an address Sotto can reach. Type it like http://localhost:11434 or http://spark-head:8888.`
    case 'public-http': return t`${host} is on the internet, so Sotto needs https:// to send it a key and your code. Use the server’s https address, or reach it over your tailnet.`
    case 'unreachable': return t`Nothing answered at ${host}. Nothing was saved. Check the server is on and this computer can reach it, over the tailnet if it is there, then try again.`
    case 'key-needed': return t`${host} asks for a key. Nothing was saved. Paste the key whoever runs the server gave you, then check again.`
    case 'key-refused': return t`${host} turned down the key. Nothing was saved. Check the key with whoever runs the server, then try again.`
    case 'no-models': return t`${host} answered but has no models loaded. Nothing was saved. Load a model on the server, then check again.`
    case 'not-openai': return t`Something answered at ${host}, but not as an OpenAI-compatible server. Nothing was saved. Check the port and the path, such as http://localhost:11434/v1, then try again.`
    case 'opencode-not-running': return doing === 'remove'
      ? t`Sotto’s OpenCode holds the key for ${name} and is not running, so nothing was removed. Connect OpenCode under Providers, then remove the server again.`
      : t`Your own servers run with OpenCode, and Sotto’s OpenCode is not running, so nothing was saved. Connect OpenCode under Providers, then add the server again.`
    case 'sign-in-failed': return doing === 'remove'
      ? t`OpenCode did not forget the key for ${name}, so nothing was removed. Try removing the server again.`
      : t`OpenCode did not take the key for ${name}, so nothing was saved. Try adding the server again.`
    case 'added-partly': return t`OpenCode did not take the key for ${name}, and Sotto could not take ${name} back off its list, so it is saved without its key. Remove it, then add it again.`
    case 'removed-partly': return t`OpenCode no longer has the key for ${name}, but Sotto could not take ${name} off its list. Remove it again.`
    case 'not-found': return t`That server is no longer saved. Nothing was changed.`
    case 'full': return t`Sotto keeps up to 32 servers. Remove one you no longer use, then add this one.`
    case 'failed': return t`Sotto could not finish that, so nothing was changed. Try again.`
    default: return english ?? t`Sotto could not finish that, so nothing was changed. Try again.`
  }
}
