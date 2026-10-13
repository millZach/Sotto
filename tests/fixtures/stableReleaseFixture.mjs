export const sourceCommit = 'a'.repeat(40)
export const cleanStableCheckout = { sourceCommit, clean: true, onMain: true, mainCommit: sourceCommit, sourceVersion: '0.1.37' }
export const successfulStableChecks = ['Gates (Windows)', 'Package result'].map((name, index) => ({
  id: index + 1, name, head_sha: sourceCommit, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' },
}))
export const stableReleaseRecord = { schemaVersion: 2, sourceCommit, mainCommit: sourceCommit, sourceVersion: '0.1.37',
  stableVersion: '0.1.38', explicitVersion: false, latestStableVersion: '0.1.37', checks: successfulStableChecks }
