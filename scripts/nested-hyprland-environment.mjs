/** Parent display credentials are only for starting the compositor, never its commands. */
export function nestedCommandEnvironment(parent, instance, pid) {
  const env = {
    ...parent,
    WAYLAND_DISPLAY: instance.wl_socket,
    HYPRLAND_INSTANCE_SIGNATURE: instance.instance,
    SOTTO_PACKAGE_NESTED_PID: String(pid),
    XDG_CURRENT_DESKTOP: 'Hyprland',
    XDG_SESSION_TYPE: 'wayland',
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
  }
  delete env.DISPLAY
  delete env.XAUTHORITY
  return env
}
