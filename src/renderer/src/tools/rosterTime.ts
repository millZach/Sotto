/** "12s", "4m 5s", "1h 4m": how long an agent or a delegated thread has worked, as Tools › Agents counts it. */
export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  return seconds >= 3_600 ? `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds % 3_600 / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
}
