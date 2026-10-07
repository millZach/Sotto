# Phone access cleanup recovery

The host protocol stops before cleanup begins. Its existing listener becomes a placeholder that immediately closes connections without releasing the port. A restart reserves the saved port directly before checking Serve. Cleanup releases the placeholder only after removal and the saved record update succeed.

Recovered records retain a durable pending-cleanup marker. A failed marker write preserves the original file. Sotto checks Serve, but an occupied setting cannot be removed without a readable record identifying it as Sotto’s; removing the setting in Tailscale lets Try again finish cleanup. A free Serve port clears pending cleanup normally.

The focused main, renderer and integration suites passed 49 tests; the adjacent socket and command suites brought the focused run to 96 passing tests. Six new main and integration cases failed against the preceding implementation. Coverage includes a real paired phone disconnect, refused new connections, the same port remaining bound until cleanup succeeds, quit with pending cleanup retaining the reserved port, restart with the setting on and off, setup failure while the setting stays on, unreadable and corrupt records, recovery across another restart, and restoration of the record. Tailscale is a fake; loopback binding and phone sockets are real in the connection checks.

Forge has no display. The Phones Electron e2e spec and visual checks were not run locally. Renderer tests cover the cleanup explanation and retry control. No visual restyle or baseline regeneration was requested.

Turning the setting off during pending setup stops the listener immediately. A later turn-on starts a fresh listener after cleanup. Tests also cover a setup command that applies its setting before reporting failure, and an identified mapping whose cleanup record cannot be saved. Four of these regression cases fail against the preceding commit and pass with the changes.

Final local gates: typecheck, lint, notices and build passed. The full suite with one worker passed 6,487 tests and skipped 145; its 24 failures and one unhandled rejection are confined to the eight Linux baseline files listed in the task brief.

The second review adds coverage for a refused recovery-marker write followed by a fresh start with phone access off. Invalid records are read without removing the primary; each uncertain cleanup attempt retries the atomic marker write after a successful read. Read failures preserve the original ownership record until read access returns. The Phones message now asks the user to remove the setting on port 8443 in Tailscale and press Try again.

Second-review verification: 43 focused main and renderer tests passed. Both added regressions fail on their preceding implementations. The full suite at `7e966116` passed 6,555 tests and skipped 145, with the same 24 Linux baseline failures and one known host-setup error. After merging `081d9afa` as `4c1fa7ac`, 180 focused phone, storage, socket and command tests passed; typecheck, lint, notices and build passed again. The local full suite used one worker on forge. Windows CI remains the required gate.
