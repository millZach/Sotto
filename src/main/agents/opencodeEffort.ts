/** OpenCode calls thinking Off the `none` variant. Other providers' None option is unchanged. */
export function openCodeEffort(variant: string, ownServer: boolean): string {
  return ownServer && variant === 'none' ? 'off' : variant
}
