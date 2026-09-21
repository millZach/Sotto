# New work in a settled folder

Acceptance: create a thread in a settled project; only the new thread appears in Projects, older threads remain in Settled. Preserve individually settled threads, other projects, provider activity and restart recovery. Failed creation must leave organization unchanged.

Desktop Windows scope, using the existing sidebar, Figtree and theme roles. No new production controls, copy, layout or motion. The proof is the same folder in both sections with disjoint thread lists. Existing composition and typography are the reference; alternatives that reopen all history or hide new work contradict the requested behavior. Review dark/light at 1600x1000, 1280x800 and 820x560, including keyboard and reduced motion. No new text elements in production.

- [x] Reproduce: workspace.test.ts reports new thread settled (expected false, received true).
- [x] Prototype the state transition.
- [x] Preserve settlement during successful creation and roll back on write failure.
- [x] Verify regression, neighboring lifecycle and Electron sidebar.
- [x] Record evidence and limitations.

Result and evidence: [verification](../verification/settled-folder-new-thread.md). Prototype captured on `prototype/settled-folder-new-thread`; the requested split was used without adding controls or restyling the sidebar.
