import type { OutgoingHttpHeaders, RequestOptions } from 'node:http'
import type { URL } from 'node:url'
import type { AppUpdater } from 'electron-updater'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'

import { getReleaseTrack } from '../../shared/releaseTrack'

/**
 * Reuse the installed GitHub provider's custom-channel selection and downloads.
 * It can fall back to latest.yml inside the selected tag: validate the manifest
 * before AppUpdater records a downloadable offer, including that fallback.
 */
export class OwlGitHubProvider extends GitHubProvider {
  private selectedTag: string | null = null

  constructor(_options: unknown, updater: AppUpdater, runtimeOptions: ProviderRuntimeOptions) {
    super({ provider: 'github', owner: 'millZach', repo: 'Sotto-releases', channel: 'owl' }, updater, runtimeOptions)
  }

  override async getLatestVersion(): ReturnType<GitHubProvider['getLatestVersion']> {
    this.selectedTag = null
    const info = await super.getLatestVersion()
    const selectedTag = this.readSelectedTag()
    if (getReleaseTrack(info.version) !== 'owl' || selectedTag === null ||
      info.tag !== selectedTag || selectedTag.replace(/^v/u, '') !== info.version) {
      throw new Error('The Owl release has inconsistent update information. Try again after the release is corrected.')
    }
    return info
  }

  // The upstream async call populated this property through createRequestOptions.
  // A method reads past TypeScript's narrowing of the reset to null above.
  private readSelectedTag(): string | null { return this.selectedTag }

  protected override createRequestOptions(url: URL, headers?: OutgoingHttpHeaders | null): RequestOptions {
    // Upstream returns { tag, ...manifest }, so manifest.tag is not trusted.
    // Both owl.yml and the fallback are fetched inside the actual selected tag.
    const match = /^\/millZach\/Sotto-releases\/releases\/download\/([^/]+)\/(?:owl|latest)\.yml$/u.exec(url.pathname)
    if (match && url.hostname === 'github.com') this.selectedTag = match[1]!
    return super.createRequestOptions(url, headers)
  }
}
