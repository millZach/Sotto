# Signing Sotto's Windows installer

Researched October 22, 2026. The electron-builder and electron-updater source at the versions Sotto pins (electron-builder 26.15.3, electron-updater 6.8.9) was read from the tagged files. Microsoft Learn pages, the CA/B Forum ballot, the SignPath terms and vendor pages were read through a fetch tool that returns a summary of each page, so quoted wording is close to the page's text, not exact. Figures marked **(reported)** came from a search-and-read pass and were not re-read here, so check them before buying. Prices change; treat every price here as the figure seen on that day. Nothing in the repo changed for this note.

## Summary

Sotto's Windows installer is unsigned. Windows shows **Unknown publisher** and a SmartScreen prompt (README "Install", `docs/guide.md` "Install in detail"). Issue #614 asks for the decision: sign the builds or set `publisherName`. In electron-builder 26.15.3 those are close to one decision. A signed build writes its `publisherName` into the installed app, and the installed app then refuses any update that does not match. An unsigned build writes one only if a publisher name is configured.

**Recommendation:** buy Microsoft Artifact Signing (renamed from Trusted Signing), Basic tier, with Zach's individual identity. It costs $9.99 a month, has no hardware token, and electron-builder 26.15.3 supports it natively. Sign the stable and Owl packages on the Windows PC with an `az login` session, so no secret is stored. Keep CI's Package (Windows) job unsigned. The publisher will read as **Zach's legal name**, not "Sotto", and SmartScreen warnings will continue for a while after the first signed release.

Three facts shape this:

- **There is no Windows release job in `.github/workflows`.** Stable and Owl builds are made by hand on the Windows PC (`docs/release/releasing.md`). The only Windows packaging in CI is **Package (Windows)** in `ci.yml`, which runs `npm run package:dir` with no secrets. It is unsigned and publishes nothing, and it must stay that way.
- **The first signed build sets the identity every later update must match.** A wrong publisher name cannot be fixed by an update, because the installed app rejects it. Users would have to reinstall by hand. Pick the exact name before the first signed release.
- **EV no longer buys SmartScreen trust.** Microsoft says EV-signed files go through the same reputation process as OV (`code-signing-options`, updated 2026-08-29). Paying the EV premium is no longer justified for SmartScreen.

## What Sotto ships today

- `electron-builder.yml` has no signing block. It builds `nsis` for x64 only and publishes to `millZach/Sotto-releases`.
- `package.json` pins electron-builder 26.15.3 and electron-updater 6.8.9. Production dependencies stay `zod`, `node-pty` and `sherpa-onnx-node`.
- `src/main/updates/electronUpdaterAdapter.ts` sets `autoDownload = false` and `autoInstallOnAppQuit = false`, so an update is offered and never taken. Owl selects its own GitHub provider.
- `scripts/package-owl.mjs` (lines 47–52) checks the installer's size and sha512 against `release/owl.yml` after the build. A signing step run outside electron-builder would break that check. That is a useful tripwire.
- `scripts/verify-assets.mjs` (line 17) lists the Windows native files that ship outside the asar: `conpty.node`, `conpty_console_list.node`, `conpty/conpty.dll`, `conpty/OpenConsole.exe`, `pty.node`, `winpty.dll` and `winpty-agent.exe`. The sherpa-onnx addon and its ONNX Runtime DLLs are unpacked too (`asarUnpack` in `electron-builder.yml`).
- The repository `millZach/Sotto` is public and MIT-licensed (checked with `gh api`). It was created on 2026-07-16.
- Issue #614, "Windows updates rest on the release feed alone, with no code signing", is open and labelled `ready-for-human`. Its note says the decision needs a certificate only the owner can obtain.
- No ADR covers Windows signing. ADR-0001 covers the unsigned macOS build only.

## 1. Azure Artifact Signing

### Name and status

Learn now uses **Artifact Signing**, formerly Trusted Signing. The quickstart (updated 2026-10-08) and the signing-integrations page (updated 2026-08-03) both use the new name. The CLI is `az artifact-signing`.

### Price

| Tier | Monthly | Signatures included per month | After the quota |
| --- | --- | --- | --- |
| Basic | $9.99 per account | 5,000 | $0.005 per signature |
| Premium | $99.99 per account | 100,000 | $0.005 per signature |

Source: `how-to-change-sku`, updated 2026-08-03. The pricing page states that prices are calculated in US dollars, but its amounts did not render when read. Public Trust and Private Trust signing are both included on both tiers. Billing starts when the account is created and is not prorated. A tier change takes effect in the next billing cycle.

Basic is about $120 a year. The signature count per build is an estimate (tens of files at most, counted on the first build). Even one Owl build a day stays well under 5,000 signatures a month.

### Who can get a certificate

- **Public Trust, organisations:** the US, Canada, the EU, the UK, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway and Israel.
- **Public Trust, individuals:** the individual must be located in the **United States or Canada**.
- The individual's billing account must have the Account Type **Individual**. Its legal name and sold-to address must match the government ID used for validation. Fix them in the billing account before starting, because the form copies them and does not let you edit them.

Zach is eligible as a US individual.

### Identity validation

Steps, from the quickstart:

1. Have a Microsoft Entra tenant and an Azure subscription. Register the `Microsoft.CodeSigning` resource provider.
2. Create an Artifact Signing account on the Basic tier in a supported region. Account names are 3–24 alphanumeric characters.
3. Assign yourself the **Artifact Signing Identity Verifier** role. Without it the "New identity" button stays dimmed.
4. In the account, open **Identity validations**, choose **Organization**, select **Individual** in the dropdown, press **New Identity**, and choose **Public**. Pick the billing account, enter the primary email and press **Create**. The status becomes **In Progress**.
5. At **Action Required**, follow the link in the portal or the email. Sign in with the same email address. The check runs through AU10TIX: an emailed PIN, a phone number, a QR code scanned by the phone's Microsoft Authenticator app, the ID presented on the phone, then the credential shared back to Artifact Signing.
6. The portal updates a couple of minutes after the check completes.

Identity validation can be done only in the portal, not the CLI. Accepted ID is a passport, driving licence or state ID, or a US Social Security card as the photo ID. The address must match the ID, a utility bill or a bank statement, and Learn says more documents can be requested after the check starts.

**Timing:** Learn gives "from 1 to 20 business days (possibly longer if we need to request more documentation)". That sentence sits in the Organization tab of the quickstart. The individual tab gives no separate figure. Plan for up to four business weeks. The lifetime of a completed identity validation was not found.

### The publisher name

- For an individual, the certificate carries the **legal name** from the ID, and the city, state and country from the address. The email and street address are not included (quickstart, individual tab).
- The certificate profile's "Verified CN and O" is taken from that identity validation.
- Changing the name or address needs a **new identity validation**, and that replaces the certificates in use (quickstart, "Accuracy").
- The exact subject string Windows shows (CN and O values, and their order) is not stated on a Learn page. Read it from a test signature before writing it into the config (see Checklist A).

### Certificates, timestamps and regions

- Signing certificates are valid **three days**. Timestamping is therefore required, or a signature stops validating after three days. Learn recommends the Microsoft timestamp server `http://timestamp.acs.microsoft.com/` (signing-integrations, updated 2026-08-03).
- The signing endpoint must match the region of both the account and the profile. A mismatch returns 403 and a `SignerSign()` failure. Fifteen endpoints are listed, for example `https://wus2.codesigning.azure.net` and `https://eus.codesigning.azure.net`.
- The signing client is the `Azure.CodeSigning.Dlib` package (NuGet `Microsoft.ArtifactSigning.Client`). It works with SignTool from Windows SDK 10.0.2261.755 or newer. The 20348 SDK is not supported. It also needs the .NET 8 runtime and the VC++ redistributable. Install with `winget install -e --id Microsoft.Azure.ArtifactSigningClientTools`.
- The older `Microsoft.Trusted.Signing.Client` package is unlisted and should not be used.

### SmartScreen

Microsoft says: "Azure Artifact Signing does **not** provide instant SmartScreen trust", new files can show a warning "until they accumulate sufficient reputation", and "signing consecutive releases with a consistent publisher/signing identity lets publisher reputation build over time" (`code-signing-options`, updated 2026-08-29). So the first signed Sotto releases will still show a SmartScreen prompt for a while. What matters is keeping the same identity for every release.

## 2. electron-builder and CI

### Config at the pinned version

electron-builder 26.15.3 reads `win.azureSignOptions` (`packages/app-builder-lib/src/options/winOptions.ts`). The required fields are `publisherName`, `endpoint`, `codeSigningAccountName` and `certificateProfileName`. `timestampRfc3161` is optional. The Azure path replaces signtool options: the two cannot be combined.

```yaml
win:
  azureSignOptions:
    publisherName: "<exact subject from a test signature>"
    endpoint: https://wus2.codesigning.azure.net   # the account's and profile's region
    codeSigningAccountName: <account name>
    certificateProfileName: <profile name>
    timestampRfc3161: http://timestamp.acs.microsoft.com
  signExts: [".exe", ".dll", ".node"]              # see "Native files" below
```

- In 26.15.3 the Azure path runs PowerShell `Invoke-TrustedSigning` from the `TrustedSigning` module. electron-builder installs it on each build with `Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Repository PSGallery -Scope CurrentUser` (`codeSign/windowsSignAzureManager.ts`). Each build therefore fetches from PSGallery. Pin the module version before release.
- **What gets signed.** By default electron-builder signs only `.exe` files (`winPackager.ts`, `shouldSignFile`). That covers `Sotto.exe` and the NSIS installer and its uninstaller. `signExts` adds other file types. `.dll` and `.node` files under `app.asar.unpacked` are not signed without it.
- **Authentication.** electron-builder reads no Azure variables itself. The signing client uses `DefaultAzureCredential`, which tries environment variables (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`), workload identity federation, managed identity, then the Azure CLI. On the Windows PC, `az login` is enough, so no secret is stored. The identity needs the **Artifact Signing Certificate Profile Signer** role on the profile.
- **Ordering.** In the 26.18.0 source (reported from the research pass, not re-read at 26.15.3), electron-builder signs the app exe before targets run, signs the installer before the blockmap, and computes `latest.yml`'s sha512 from the signed bytes. Re-check this at 26.15.3 when the change is made.

### Publisher name and the updater (26.15.3 source, read directly)

- `PublishManager.ts` (lines 275–279) writes `publisherName` into the built `app-update.yml` only when the signing manager can compute one and `verifyUpdateCodeSignature` is not `false`. For an Azure build that is `azureSignOptions.publisherName`.
- An unsigned build is not always silent. `windowsSignToolManager.ts` (26.15.3, lines 70–75) returns a configured `signtoolOptions.publisherName` before it looks for a certificate. So an unsigned build with a publisher name configured would write one into `app-update.yml`, and every later update, which is unsigned too, would be refused. Sotto's config sets no publisher name, so today's unsigned build writes none.
- Sotto's `win.verifyUpdateCodeSignature` is unset, so the default (verify) applies once a publisher exists.

### GitHub Actions (not recommended for now)

The release is made on the Windows PC, so CI does not need Azure credentials. If releases move to CI later:

- The workflow needs `permissions: id-token: write` and `azure/login` with the client, tenant and subscription IDs. Those IDs are not secrets. There must be no client secret.
- A federated credential must match the workflow's subject. For a repository created after mid-July 2026, GitHub's subject uses the owner and repository IDs, for example `repo:millZach@59266632/Sotto@1303347981:ref:refs/heads/main`. The owner and repository IDs match what the API returned, but the naming rule itself was reported from GitHub's changelog and not re-read here.
- Whether `azure/login` alone is enough for electron-builder 26.15.3 is unverified. Test it before relying on it.

### Known electron-builder issues (reported)

- #9623 (closed 2026-04-27) blocked OIDC and Azure CLI credentials in a preflight check. It was removed by a later change, reported as in 26.15.3, so Sotto's pinned version should not hit it. Confirm on the first signed build.
- No open issues matching `azure`, `signtool`, `publisherName` or `verifyUpdateCodeSignature` were found.
- electron-builder 27 (alpha) moves this config to `win.sign` with `type: "azure"`. A later upgrade will change the config shape.

## 3. Alternatives

Read on 2026-10-22. Items marked (reported) were not re-read.

| Option | Price (USD) | Individual eligible | Key storage | CI and electron-builder fit | Publisher shown |
| --- | --- | --- | --- | --- | --- |
| **Artifact Signing, Basic** (recommended) | $9.99/month, about $120 a year | Yes, US or Canada | Microsoft cloud, no token | Native `win.azureSignOptions` in 26.15.3 | Legal name from the ID |
| **SSL.com IV** (personal validation) | $129 for one year, $109.65 a year on three years (reported) | Yes, a person is validated (reported) | eSigner cloud: $180 a year for 240 signings, $1 each extra; or $20 a month for 20 signings (SSL.com pricing guide, read 2026-10-22). A YubiKey also works (reported) | `SSLcom/esigner-codesign` action and CodeSignTool; electron-builder needs a custom sign hook | Personal name (reported) |
| **Sectigo OV** | $313.50 for one year (reported) | Stated as available to individual developers on the store page (reported); the Sectigo docs say nothing about purchase | Hardware HSM types include Google Cloud KMS and Fortanix DSM (Sectigo docs), so a cloud-key path exists. Cloud KMS costs were not priced | No signing tool or action identified; the Google Cloud KMS path is untested | Not verified |
| **DigiCert KeyLocker** | From $44 a month per certificate, or $62 a month, on 12-month auto-renewing plans with totals of $696 and $972 (DigiCert pricing page). The page does not say which storage each price covers | Not stated on the pricing page. The research pass reported "not offered", but that text was not found | KeyLocker cloud (DigiCert pricing page) | The KeyLocker GitHub plugin is documented, but its old signing action retired on May 1, 2026, in favour of "Binary signing using GitHub actions". Windows runner support not stated | Not verified |
| **EV** (any CA) | $349 or more (reported) | No. The legal company name and registered address must be verified (reported) | Token or cloud HSM | Same as OV | Company name |
| **SignPath Foundation** | Free for open-source projects | Open-source projects only, and no proprietary component (see below). Sotto ships the Anthropic Agent SDK, so probably not | Managed by SignPath | GitHub action exists (reported) | "SignPath Foundation" |
| **Certum open-source** | €49 in the EU shop, $58 in the US store (reported; both showed out of stock on the day seen) | Yes, for a person who shares free software (reported) | SimplySign cloud (reported) | Windows CI path not verified | "Open Source Developer" plus the person's name (reported) |

**Certificate lifetime applies to all of them.** The CA/B Forum ballot CSC-31 reduces the maximum validity of code signing certificates from 39 months to **460 days**, effective March 1, 2026 (cabforum.org, 2025-11-17). A "three-year" price is therefore not one three-year certificate. The ballot summary says the limit covers all code signing certificates. It does not say how reissue works.

**Hardware key storage applies to all of them.** Code signing private keys must be stored on a hardware module, and the CA/B Forum rule dates to June 2023 (reported). That is why every option above uses a token, an HSM or a cloud signing service. The primary text was not read here.

### SignPath Foundation

Sotto probably does not qualify as shipped. The SignPath terms page (read on 2026-10-22; the page itself says its code of conduct is a draft) says:

- The project must use an OSI-approved open-source licence "without commercial dual-licensing for all components". Sotto's MIT licence fits.
- "The project may not contain any proprietary, non open-source component".
- "Binary artifacts must be built from source code in a verifiable way." The page mentions build scripts and CI configuration in the repository. It does not say a laptop build is acceptable.
- "Every release needs manual approval for signing."
- Signed binaries show "SignPath Foundation is the publisher of the OSS project", and product-name metadata must be set to the project's name.

The blocker is the bundled Agent SDK. `electron-builder.yml` ships `sdk.mjs`, `LICENSE.md`, `README.md` and `package.json` from `@anthropic-ai/claude-agent-sdk` into `claude-sdk/`. The installed `LICENSE.md` reads: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." That is a proprietary component, and SignPath's terms allow no proprietary component except System Libraries. Removing the SDK file would change what Sotto ships, so this is a product decision as well as a signing one.

The SignPath About and Apply pages do not list criteria. The terms page does not say whether a private repository is eligible; Sotto's repository is public, so that question does not arise. A second problem is the build. Sotto's Windows release is built by hand on the PC, so SignPath would mean moving the Windows release build into CI, or at least a verifiable build, which is a bigger change than the signing itself.

## 4. Impact on Sotto

### SmartScreen and the publisher field

- **Today:** unsigned, so "Unknown publisher" and a SmartScreen prompt on each new download.
- **After signing:** the publisher is the certificate's legal name, and SmartScreen still warns until reputation builds. Microsoft says consistent signing builds reputation over releases. Changing the identity starts that over. How much it costs was not measured.
- Owl and stable install over the same app ID, `com.sotto.desktop`. The updater checks every update against the publisher in the installed app, and an Owl update to stable (or back) is an update, so the two tracks must carry the same publisher identity. A manual install over the other track is not checked by the updater.

### The updater (electron-updater 6.8.9, read directly)

- `NsisUpdater.ts` reads `publisherName` from the installed app's `app-update.yml`. If the field is absent, `verifySignature` returns `null` and the check is skipped.
- When the field is present, the update is checked with PowerShell `Get-AuthenticodeSignature`. `Status` must be Valid. The subject must match each attribute of a full DN; a bare CN matches with a warning. A mismatch throws `ERR_UPDATER_INVALID_SIGNATURE`.
- So:
  - **Unsigned installed app, signed update:** the check is skipped, the update installs, and trust starts here.
  - **Signed installed app, signed update:** the update must match the installed `publisherName`.
  - **Signed installed app, unsigned update:** the update is refused, because the field is set and the file has no signature.
- The first signed release sets the trust anchor for every later release. Confirm the name against a real test signature first.
- To confirm today's behaviour, open `release/win-unpacked/resources/app-update.yml` after the next unsigned build. It should have no `publisherName`.

### Hashes and the order of operations

`latest.yml` and `owl.yml` carry the sha512 of the installer's final bytes. Sign inside electron-builder, not as a separate `signtool` run after the build. A signature added afterwards changes the bytes, the sha512 no longer matches, the updater refuses the download, and the blockmap is stale.

### Native files

`signExts` should cover `.dll` and `.node` so that `conpty.dll`, `OpenConsole.exe`, `winpty.dll`, `winpty-agent.exe`, the sherpa-onnx native addon and its ONNX Runtime DLLs are signed too. Whether signtool accepts a `.node` file (a PE renamed) was not tested. Test it on the PC before relying on it.

### CI

- `ci.yml`'s **Package (Windows)** job runs `package:dir` with `CI=true` and no secrets. An ungated `azureSignOptions` in `electron-builder.yml` would make that job try to sign and fail, which would fail the required **Package result** check.
- The signing config must therefore be enabled only for the release commands, for example by a flag or environment variable read by `scripts/package-stable.mjs` and `scripts/package-owl.mjs`. The CI job stays unsigned.
- Pull requests from forks never receive secrets. Keeping the release on the PC means no Azure secret is ever in GitHub.

### Privacy and hosts

- Signing runs on Zach's PC, not in the installed app. It contacts Microsoft's sign-in service, `*.codesigning.azure.net` and `timestamp.acs.microsoft.com` at release time only. The app does not contact them, so the README's "Privacy and cost" list does not change for signing.
- Identity validation sends Zach's ID document to Microsoft's verifier (AU10TIX). That is Zach's own identity check, not Sotto user data.
- No npm production dependency changes. The signing tools reach the release machine through electron-builder and PSGallery, and `package.json` does not change.

### What a signing PR would change

- `docs/release/releasing.md` gains a signing step and a verification step.
- `README.md` line 83 and `docs/guide.md` line 588 stop saying the installer is unsigned, once the first signed build ships.
- An ADR records the identity and the decision, because AGENTS.md asks for an ADR when a choice is made rather than followed. The next free number applies.
- Issue #614 closes against that PR.

## 5. Recommendation

Use **Artifact Signing, Basic tier, under Zach's individual identity**, and sign on the Windows PC:

1. **Cost and fit.** About $120 a year, no token, Microsoft's own recommendation for non-Store distribution, and native electron-builder support in the pinned version. SSL.com IV with eSigner costs about $310 a year before extra signings ($129 for the certificate plus $180 for the annual eSigner plan), and needs a custom hook.
2. **Identity.** An individual is the only identity Zach can hold without a registered company. The publisher will be his legal name.
3. **Where it runs.** On the Windows PC, with `az login` and no stored secret, matching how releases are cut today. CI keeps its unsigned Package (Windows) check.
4. **Scope.** Stable and Owl, with the same publisher name for both. Sign `.exe`, `.dll` and `.node` files.
5. **Order.** Pick the exact publisher string from a test signature first. Ship one signed test build and install it. Then test one update from it to a second signed build, and one update that should be refused because its publisher is wrong. Only then ship a stable release.

**Fallbacks.** If Artifact Signing identity validation fails, use SSL.com IV with eSigner and a custom hook. If Zach wants no cost at all, SignPath is probably closed to Sotto while the Anthropic Agent SDK files ship. Any paid route costs more than the recommendation.

## Decisions only Zach can make

1. **Publisher name.** His legal name, as on the ID, will appear as the publisher. A company name would need a registered business and an organisation validation, which the quickstart describes but this note did not check in detail.
2. **Accept SmartScreen prompts** for the first few signed releases, while reputation builds.
3. **Sign Owl too.** Recommended, with the same identity as stable.
4. **Keep the release on the PC.** Recommended. Moving it to CI is what SignPath would need.
5. **Pin electron-builder.** Stay on 26.15.3 for the first signed release, and upgrade in a separate PR. The research pass read the 26.18.0 source; this note did not re-read it, and the signing order there may differ.

## Checklist A: steps only Zach can do

1. Confirm you are in the US or Canada and that the legal name and address on your billing account match your government ID.
2. Sign in to the Azure portal. Make sure the subscription has an **Individual** billing account. Register the `Microsoft.CodeSigning` provider.
3. Create an Artifact Signing account on the **Basic** tier in one region, for example West US 2 or East US. Note its endpoint.
4. Make sure you hold the **Artifact Signing Identity Verifier** role, which the portal needs before "New identity" works. Give the **Artifact Signing Certificate Profile Signer** role on the profile once it exists. The research did not confirm the exact role scope Learn expects, so check the role assignment in the portal.
5. Start **Individual** identity validation (Identity validations → Organization → Individual → New identity → Public). Complete the AU10TIX check on your phone when it asks. Expect 1 to 20 business days, possibly more if documents are requested.
6. Once validation shows **Completed**, create a **Public Trust** certificate profile. Note the account name and the profile name.
7. Install the signing tools on the Windows PC (`winget install -e --id Microsoft.Azure.ArtifactSigningClientTools`) and run `az login`.
8. Sign one test executable with SignTool and the dlib, and copy the exact subject from `Get-AuthenticodeSignature`. That string is the `publisherName`. Keep it.
9. No Azure secret is needed for the PC flow. If CI signing is ever wanted, only the client, tenant and subscription IDs go in GitHub, with a federated credential. No client secret.
10. Decide the open questions in the section above.

## Checklist B: repo changes for a later Building thread

1. **Gate the signing config.** Add `win.azureSignOptions` and `win.signExts` where the stable and Owl commands read them, behind a flag or environment variable. Leave `package:dir` and CI's Package (Windows) unsigned. Add a test that fails if signing is enabled in CI.
2. **Pin the signing module.** Set `TrustedSigning` to an exact version in `azureSignOptions` or the release script, rather than the `-MinimumVersion 0.5.0` default.
3. **Verify the artifact.** Extend `scripts/verify-packaged-resources.mjs` or a new script to check that `Sotto.exe`, the installer and every signed DLL or `.node` have a Valid signature whose subject matches `publisherName`. Also check that `resources/app-update.yml` contains that `publisherName`.
4. **Keep the sha512 check.** `scripts/package-owl.mjs` already compares the installer hash with `owl.yml`. Keep that check and add the equivalent for stable.
5. **Test the updater on the PC.** Install a signed build, then update it to a second signed build from a test feed, then try an update with the wrong publisher and confirm it is refused.
6. **Update the docs.** `docs/release/releasing.md` (new signing and verification steps), `README.md` line 83, `docs/guide.md` line 588, and an ADR for the decision. Close issue #614.
7. **Leave `package.json` alone.** Stay on electron-builder 26.15.3 for the first signed release. Do not add a runtime dependency.
8. **Confirm the first build.** Open a PR with the signed build's evidence (signature output and the `app-update.yml` line), recorded in `docs/verification/`.

## Not verified here

- The exact subject string an individual certificate carries. Read it from a test signature.
- The lifetime of a completed identity validation.
- Whether `signtool` signs `.node` files. Test on the PC.
- Whether `azure/login` alone works for electron-builder 26.15.3 in CI.
- The GitHub OIDC subject rule for repositories created after mid-July 2026.
- The 26.18.0 signing order, as opposed to 26.15.3.
- Every reported vendor price and eligibility line in the alternatives table.
- Whether a laptop build can satisfy SignPath's "verifiable build" wording.
- Whether Sectigo or DigiCert sells to an individual, and what a Sectigo cloud key through Google Cloud KMS would cost.
- The terms of the Anthropic Agent SDK licence as they apply to redistribution in an installer. The note relies only on the licence text in `LICENSE.md`.

## Sources

Read 2026-10-22.

- Microsoft Learn, Artifact Signing quickstart, updated 2026-10-08: https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- Microsoft Learn, Change the account SKU, updated 2026-08-03: https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku
- Microsoft Learn, Set up signing integrations, updated 2026-08-03: https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations
- Microsoft Learn, Code signing options for Windows app developers, updated 2026-08-29: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- Artifact Signing pricing page: https://azure.microsoft.com/en-us/pricing/details/artifact-signing/ (amounts did not render; currency stated as US dollars)
- CA/B Forum, ballot CSC-31, 2025-11-17: https://cabforum.org/2025/11/17/ballot-csc-31-maximum-validity-reduction/
- SignPath terms: https://signpath.org/terms.html (marked draft; read via summary)
- SignPath About and Apply pages, no criteria listed: https://signpath.org/about and https://signpath.org/apply
- electron-builder 26.15.3 source, tag `electron-builder@26.15.3`: `packages/app-builder-lib/src/options/winOptions.ts`, `winPackager.ts`, `publish/PublishManager.ts`, `codeSign/windowsSignAzureManager.ts`
- electron-updater 6.8.9 source, tag `electron-updater@6.8.9`: `packages/electron-updater/src/NsisUpdater.ts`, `windowsExecutableCodeSignatureVerifier.ts`
- Repository facts: `package.json`, `electron-builder.yml`, `scripts/package-owl.mjs`, `scripts/verify-assets.mjs`, `.github/workflows/ci.yml` (Package (Windows) job), `docs/release/releasing.md`, `src/main/updates/electronUpdaterAdapter.ts`, issue #614, `gh repo view millZach/Sotto`
- Checked for the review fixes on 2026-10-22: SSL.com eSigner pricing guide (https://www.ssl.com/guide/esigner-pricing-for-code-signing/), DigiCert code signing pricing (https://www.digicert.com/signing/code-signing-certificates) and KeyLocker GitHub documentation (https://docs.digicert.com/en/digicert-keylocker/ci-cd-integrations-and-deployment-pipelines/plugins/github.html), Sectigo code signing documentation (https://docs.sectigo.com/scm/scm-administrator/understanding-code-signing-certificates), electron-builder `windowsSignToolManager.ts` at `electron-builder@26.15.3`, and `node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md`.
- Vendor pages for the alternatives (reported): Sectigo store, SSL.com OV, EV, eSigner and IV pages, DigiCert code signing, Certum open-source; and the `SSLcom/esigner-codesign`, `digicert/ssm-code-signing` and `SignPath/github-action-submit-signing-request` repositories.
