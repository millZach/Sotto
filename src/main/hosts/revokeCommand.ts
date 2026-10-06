/** A value inside double quotes for a POSIX shell, with a leading `~/` written as `$HOME/` so the shell still expands it. */
export function shellQuoted(value: string): string {
  const home = value === '~' || value.startsWith('~/')
  const rest = home ? value.slice(1) : value
  return `"${home ? '$HOME' : ''}${rest.replace(/["$`\\]/gu, character => `\\${character}`)}"`
}

/**
 * The one line that revokes this computer on a host by hand, for when Forget could not (ADR-0053, "Forget"). It resolves
 * `current` the way the launch script does, since an update deletes old version folders and another desktop may have
 * updated the host: the version `current` names when its entry is there, and the flat entry otherwise. The host must be
 * running, since `--revoke-client` goes through its administrative route. Sotto never runs it.
 */
export function revokeByHandCommand(input: { readonly installPath: string; readonly dataDirectory: string; readonly clientId: string; readonly node?: string | undefined }): string {
  return [
    `I=${shellQuoted(input.installPath)}`,
    'E="$I/host/index.js"',
    '[ -f "$I/current" ] && V=$(cat "$I/current") && [ -f "$I/versions/$V/host/index.js" ] && E="$I/versions/$V/host/index.js"',
    `${input.node ? shellQuoted(input.node) : 'node'} "$E" --data ${shellQuoted(input.dataDirectory)} --revoke-client ${shellQuoted(input.clientId)}`,
  ].join('; ')
}
