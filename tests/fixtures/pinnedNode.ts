import { readFileSync } from 'node:fs'

/**
 * The Node version the suite's counts are taken on: the one in `.node-version`, which every workflow that installs Node pins
 * (`tests/unit/release/nodeVersion.test.ts` holds them to it). Under Node 26 the window's tests that use localStorage
 * fail. The owner-scale work budget once read as over budget there too (#2339), until its clock waited out a send's file
 * work (#2402).
 */
// Read from the folder the run starts in, the repository's root for vitest and for Playwright alike: Playwright loads
// `tests/globalSetup.ts` as CommonJS, where `import.meta` does not exist.
export const PINNED_NODE = readFileSync('.node-version', 'utf8').trim()
/** Whether this process runs the pinned version's major, which is what the counts depend on. */
export const ON_PINNED_NODE = process.versions.node.split('.')[0] === PINNED_NODE.split('.')[0]
/** What to tell someone running the suite on another major, with the command that runs it on the pinned one. */
export const OFF_PINNED_NODE_MESSAGE = `The suite's counts are taken on Node ${PINNED_NODE} (.node-version), as CI runs it. This is Node ${process.versions.node}: `
  + 'tests of the window that use localStorage may fail. '
  + `Put the pinned version's node first on PATH, for example: PATH="$(mise where node@${PINNED_NODE})/bin:$PATH" npx vitest run <files>`
