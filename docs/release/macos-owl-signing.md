# Signing the Mac Owl (Stage 2 credentials)

The Mac Owl is signed with Sotto's Developer ID and notarized by Apple in GitHub Actions (ADR-0092). Only Zach can do the steps below: they need the Apple Developer account's Account Holder, and they put secrets into GitHub. Stage 2's code waits for them. Everything here works from the Windows PC in Git Bash; no Mac is needed.

Stable on the Mac is not signed and does not use any of this.

## 1. Check the Apple Developer membership

The iPhone app already reaches TestFlight with an App Store Connect key and the `APPLE_TEAM_ID` secret (ADR-0032), so the membership most likely exists.

1. Sign in at <https://developer.apple.com/account> and open **Membership details**.
2. Check the membership is active and your role is **Account Holder**. Only the Account Holder can make a Developer ID certificate.
3. Note the **Team ID**. It is the same value as the `APPLE_TEAM_ID` secret.

If there is no membership, enroll at <https://developer.apple.com/programs/enroll/> ($99 a year) and wait for Apple's confirmation before going on.

## 2. Make the Developer ID Application certificate

The certificate request and its private key are made on the PC, so the key never leaves it except as the GitHub secret.

```sh
mkdir -p ~/sotto-devid && cd ~/sotto-devid
openssl genrsa -out devid.key 2048
openssl req -new -key devid.key -out devid.csr -subj "/emailAddress=<your Apple ID email>/CN=<your name>/C=US"
```

1. At <https://developer.apple.com/account/resources/certificates/list>, press **+**.
2. Choose **Developer ID Application**, then the **G2 Sub-CA** profile, and upload `devid.csr`.
3. Download the certificate, `developerID_application.cer`, into `~/sotto-devid`.

Join the certificate and key into a password-protected `.p12` that macOS's keychain accepts:

```sh
cd ~/sotto-devid
openssl x509 -inform DER -in developerID_application.cer -out devid.pem
openssl pkcs12 -export -inkey devid.key -in devid.pem -out devid.p12 \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
```

OpenSSL asks for an export password. Make a long one and save it, with `devid.p12`, in your password manager. That pair is the only copy of the signing identity; Apple cannot give the private key back.

## 3. Make the notarization key

1. In App Store Connect, open **Users and Access**, then **Integrations**, then **App Store Connect API**, under **Team Keys**.
2. Press **+**, name it `Sotto Mac notarization`, and give it the **Developer** role.
3. Download the `.p8` file. Apple offers it once only.
4. Note the **Key ID** beside it and the **Issuer ID** above the list.

A separate key from the TestFlight one means either can be revoked without breaking the other.

## 4. Put the secrets in GitHub

The secrets live in a GitHub environment that only the Mac Owl workflow's job reads, as the `testflight` environment holds the iPhone app's key.

1. At <https://github.com/millZach/Sotto/settings/environments>, press **New environment** and name it `owl-mac`.
2. Under **Deployment branches and tags**, choose **Selected branches and tags** and add `main`. The workflow then reads the secrets only when started from `main`.
3. Add the five secrets from Git Bash. `gh` reads each value from the file or prompt, so none of them lands in your shell history:

```sh
cd ~/sotto-devid
base64 -w0 devid.p12 | gh secret set MAC_DEVELOPER_ID_P12 --env owl-mac --repo millZach/Sotto
gh secret set MAC_DEVELOPER_ID_P12_PASSWORD --env owl-mac --repo millZach/Sotto      # paste the export password
gh secret set APPLE_NOTARY_KEY_P8 --env owl-mac --repo millZach/Sotto < AuthKey_<KEY ID>.p8
gh secret set APPLE_NOTARY_KEY_ID --env owl-mac --repo millZach/Sotto                # paste the Key ID
gh secret set APPLE_NOTARY_ISSUER_ID --env owl-mac --repo millZach/Sotto             # paste the Issuer ID
gh secret list --env owl-mac --repo millZach/Sotto
```

The list shows the five names and no values.

## 5. Clean up the PC

Once the `.p12` and its password are in your password manager and the `.p8` is in GitHub:

```sh
rm -rf ~/sotto-devid
```

Keep the downloaded `.p8` out of Downloads too. If the `.p12`, its password or the `.p8` is ever exposed, revoke the notarization key in App Store Connect, and email Apple at product-security@apple.com to revoke the Developer ID certificate. Apple does not let you revoke a Developer ID certificate from the website.

## 6. Hand back

Tell the thread building Stage 2 that the `owl-mac` environment holds its five secrets. It turns on signing and notarization, runs the workflow once without publishing, and shows the `codesign` and `spctl` results before anything ships.
