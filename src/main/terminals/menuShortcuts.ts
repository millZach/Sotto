import type { SottoPlatform } from '../../shared/platform'

/** Native menus see accelerators before the renderer. Yield just terminal zoom, keeping Edit-menu copy and paste. */
export function terminalTakesMenuShortcut(input: { key: string; control: boolean; meta: boolean; alt: boolean; shift: boolean }, focused: boolean, platform: SottoPlatform): boolean {
  const zoom = !input.shift && ['=', '-', '0'].includes(input.key) || platform !== 'darwin' && ['+', '='].includes(input.key)
  return focused && !input.alt && zoom &&
    (platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta)
}
