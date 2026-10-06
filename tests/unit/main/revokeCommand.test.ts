// @vitest-environment node
import { expect, it } from 'vitest'
import { revokeByHandCommand } from '../../../src/main/hosts/revokeCommand'

it('writes the command that revokes this computer by hand, resolving the version the host runs and expanding a home folder', () => {
  expect(revokeByHandCommand({ installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto', clientId: '0f9c2d7e-1b2a-4c3d-8e9f-001122334455', node: '/home/zach/.local/share/mise/installs/node/24.4.0/bin/node' }))
    .toBe('I="$HOME/.local/share/sotto-host"; E="$I/host/index.js"; [ -f "$I/current" ] && V=$(cat "$I/current") && [ -f "$I/versions/$V/host/index.js" ] && E="$I/versions/$V/host/index.js"; '
      + '"/home/zach/.local/share/mise/installs/node/24.4.0/bin/node" "$E" --data "$HOME/.sotto" --revoke-client "0f9c2d7e-1b2a-4c3d-8e9f-001122334455"')
  // A Node it never saw is the one on the PATH, and a path the shell would read as more than a path stays one path.
  expect(revokeByHandCommand({ installPath: '/opt/sotto "release"', dataDirectory: '/data/$sotto`x`', clientId: 'client' }))
    .toBe('I="/opt/sotto \\"release\\""; E="$I/host/index.js"; [ -f "$I/current" ] && V=$(cat "$I/current") && [ -f "$I/versions/$V/host/index.js" ] && E="$I/versions/$V/host/index.js"; '
      + 'node "$E" --data "/data/\\$sotto\\`x\\`" --revoke-client "client"')
})
