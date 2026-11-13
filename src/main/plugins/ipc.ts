import { t } from '@lingui/core/macro'
import { z } from 'zod'
import {
  gitHubSignInSchema, pluginHostSignInsSchema, PLUGINS_GITHUB_SIGN_IN_ELSEWHERE, type PluginHostSignIn, pluginCopiesViewSchema, pluginCopyNewSetSchema, pluginCopySetSchema, PLUGINS_COPIES, PLUGINS_COPY_NEW_SET, PLUGINS_COPY_SET, pluginAccountAddSchema, pluginAccountRemoveSchema, pluginAccountReplaceSchema, pluginAccountResultSchema, pluginAccountsSchema, pluginAccountUpdateSchema, pluginProjectsSchema,
  PLUGINS_ACCOUNT_ADD, PLUGINS_ACCOUNT_REMOVE, PLUGINS_ACCOUNT_REPLACE, PLUGINS_ACCOUNT_UPDATE, PLUGINS_ACCOUNTS, PLUGINS_GITHUB_SIGN_IN, PLUGINS_PROJECTS, PLUGINS_RECENT_USE, shownPluginUsesSchema,
  mailGrantsOfSchema, mailGrantStopSchema, PLUGINS_MAIL_GRANT_STOP, PLUGINS_MAIL_GRANTS, threadMailGrantsSchema, type MailGrantStop, type ThreadMailGrant,
  type GitHubSignIn, type PluginAccount, type PluginAccountAdd, type PluginAccountRemove, type PluginAccountReplace, type PluginAccountResult, type PluginAccountUpdate, type PluginCopiesView, type PluginCopySet, type PluginProject, type ShownPluginUse,
} from '../../shared/plugins'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** Each call's arguments, checked against a schema built once rather than on every call. */
const noArguments = z.tuple([])
const addArguments = z.tuple([pluginAccountAddSchema])
const replaceArguments = z.tuple([pluginAccountReplaceSchema])
const removeArguments = z.tuple([pluginAccountRemoveSchema])
const updateArguments = z.tuple([pluginAccountUpdateSchema])
const copySetArguments = z.tuple([pluginCopySetSchema])
const copyNewArguments = z.tuple([pluginCopyNewSetSchema])
const mailGrantsArguments = z.tuple([mailGrantsOfSchema])
const mailGrantStopArguments = z.tuple([mailGrantStopSchema])
const stoppedSchema = z.boolean()

/** What Settings › Plugins asks of main. */
export interface PluginsIpcHandlers {
  readonly gitHubSignIn: () => Promise<GitHubSignIn>
  readonly gitHubSignInElsewhere: () => Promise<readonly PluginHostSignIn[]>
  readonly recentUse: () => Promise<readonly ShownPluginUse[]>
  readonly accounts: () => Promise<readonly PluginAccount[]>
  readonly addAccount: (request: PluginAccountAdd) => Promise<PluginAccountResult>
  readonly replaceSecret: (request: PluginAccountReplace) => Promise<PluginAccountResult>
  readonly removeAccount: (request: PluginAccountRemove) => Promise<PluginAccountResult>
  readonly updateAccount: (request: PluginAccountUpdate) => Promise<PluginAccountResult>
  readonly projects: () => readonly PluginProject[]
  readonly copies: () => Promise<PluginCopiesView>
  readonly setCopy: (request: PluginCopySet) => Promise<PluginCopiesView>
  readonly setCopyNew: (copyNew: boolean) => Promise<PluginCopiesView>
  /** The mail accounts one of this computer's threads has been let read. */
  readonly mailGrants: (threadId: string) => Promise<readonly ThreadMailGrant[]>
  /** Ends one. False when it could not be ended. */
  readonly stopMailGrant: (request: MailGrantStop) => Promise<boolean>
}

/**
 * Settings › Plugins' channels (ADR-0205), answered for the main window only. Registered only while the `plugins` Owl
 * feature is on, so stable answers nothing. What goes back is checked on the way out and never carries a secret. A
 * secret comes in once, when an account is added or its secret replaced, and a request that cannot be read is turned
 * away in fixed words, so nothing that was sent is ever said back.
 */
export function registerPluginsIpc(ipc: IpcMainAdapter, plugins: PluginsIpcHandlers, senders: () => readonly TrustedIpcSender[]): () => void {
  ipc.handle(PLUGINS_GITHUB_SIGN_IN, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Settings in the main Sotto window.`)
    noArguments.parse(args)
    return gitHubSignInSchema.parse(await plugins.gitHubSignIn())
  })
  ipc.handle(PLUGINS_GITHUB_SIGN_IN_ELSEWHERE, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Settings in the main Sotto window.`)
    noArguments.parse(args)
    return pluginHostSignInsSchema.parse(await plugins.gitHubSignInElsewhere())
  })
  ipc.handle(PLUGINS_RECENT_USE, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Settings in the main Sotto window.`)
    noArguments.parse(args)
    return shownPluginUsesSchema.parse(await plugins.recentUse())
  })
  ipc.handle(PLUGINS_ACCOUNTS, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Settings in the main Sotto window.`)
    noArguments.parse(args)
    return pluginAccountsSchema.parse(await plugins.accounts())
  })
  ipc.handle(PLUGINS_PROJECTS, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Settings in the main Sotto window.`)
    noArguments.parse(args)
    return pluginProjectsSchema.parse(plugins.projects())
  })
  ipc.handle(PLUGINS_COPIES, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Settings in the main Sotto window.`)
    noArguments.parse(args)
    return pluginCopiesViewSchema.parse(await plugins.copies())
  })
  ipc.handle(PLUGINS_COPY_SET, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Settings in the main Sotto window.`)
    const parsed = copySetArguments.safeParse(args)
    if (!parsed.success) throw new Error(t`That could not be done. Nothing was changed.`)
    return pluginCopiesViewSchema.parse(await plugins.setCopy(parsed.data[0]))
  })
  ipc.handle(PLUGINS_COPY_NEW_SET, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Settings in the main Sotto window.`)
    const parsed = copyNewArguments.safeParse(args)
    if (!parsed.success) throw new Error(t`That could not be done. Nothing was changed.`)
    return pluginCopiesViewSchema.parse(await plugins.setCopyNew(parsed.data[0].copyNew))
  })
  // A thread's menu reads its own mail grants and ends one: the main window's, as the page's channels are.
  ipc.handle(PLUGINS_MAIL_GRANTS, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open the thread in the main Sotto window.`)
    const parsed = mailGrantsArguments.safeParse(args)
    if (!parsed.success) throw new Error(t`That could not be done. Nothing was changed.`)
    return threadMailGrantsSchema.parse(await plugins.mailGrants(parsed.data[0].threadId))
  })
  ipc.handle(PLUGINS_MAIL_GRANT_STOP, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open the thread in the main Sotto window.`)
    const parsed = mailGrantStopArguments.safeParse(args)
    if (!parsed.success) throw new Error(t`That could not be done. Nothing was changed.`)
    return stoppedSchema.parse(await plugins.stopMailGrant(parsed.data[0]))
  })
  const change = <Request>(channel: string, schema: z.ZodType<[Request]>, run: (request: Request) => Promise<PluginAccountResult>): void => {
    ipc.handle(channel, async (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Settings in the main Sotto window.`)
      const parsed = schema.safeParse(args)
      if (!parsed.success) throw new Error(t`That could not be done. Nothing was changed.`)
      return pluginAccountResultSchema.parse(await run(parsed.data[0]))
    })
  }
  change(PLUGINS_ACCOUNT_ADD, addArguments, request => plugins.addAccount(request))
  change(PLUGINS_ACCOUNT_REPLACE, replaceArguments, request => plugins.replaceSecret(request))
  change(PLUGINS_ACCOUNT_REMOVE, removeArguments, request => plugins.removeAccount(request))
  change(PLUGINS_ACCOUNT_UPDATE, updateArguments, request => plugins.updateAccount(request))
  return () => {
    for (const channel of [PLUGINS_MAIL_GRANTS, PLUGINS_MAIL_GRANT_STOP, PLUGINS_GITHUB_SIGN_IN, PLUGINS_GITHUB_SIGN_IN_ELSEWHERE, PLUGINS_RECENT_USE, PLUGINS_ACCOUNTS, PLUGINS_PROJECTS, PLUGINS_COPIES, PLUGINS_COPY_SET, PLUGINS_COPY_NEW_SET, PLUGINS_ACCOUNT_ADD, PLUGINS_ACCOUNT_REPLACE, PLUGINS_ACCOUNT_REMOVE, PLUGINS_ACCOUNT_UPDATE]) ipc.removeHandler(channel)
  }
}
