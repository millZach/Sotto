// Give the owned nested compositor a pointer seat while the live session is locked.
// Usage is private to verify-hyprland-paste-nested.mjs; never connect to the live display.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>

// Minimal client declarations for wlr-virtual-pointer-unstable-v1, version 1.
static const struct wl_message pointer_requests[] = {
    {"motion", "uff", NULL}, {"motion_absolute", "uuuuu", NULL},
    {"button", "uuu", NULL}, {"axis", "uuf", NULL}, {"frame", "", NULL},
    {"axis_source", "u", NULL}, {"axis_stop", "uu", NULL},
    {"axis_discrete", "uufi", NULL}, {"destroy", "", NULL},
};
static const struct wl_interface pointer_interface = {
    "zwlr_virtual_pointer_v1", 1, 9, pointer_requests, 0, NULL,
};
static const struct wl_interface *create_types[] = { &wl_seat_interface, &pointer_interface };
static const struct wl_message manager_requests[] = {
    {"create_virtual_pointer", "?on", create_types}, {"destroy", "", NULL},
};
static const struct wl_interface manager_interface = {
    "zwlr_virtual_pointer_manager_v1", 1, 2, manager_requests, 0, NULL,
};
static struct wl_proxy *manager;

static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
    (void)data;
    (void)version;
    if (strcmp(interface, manager_interface.name) == 0)
        manager = wl_registry_bind(registry, name, &manager_interface, 1);
}
static void global_remove(void *data, struct wl_registry *registry, uint32_t name) {
    (void)data;
    (void)registry;
    (void)name;
}
static const struct wl_registry_listener listener = {global, global_remove};

int main(int argc, char **argv) {
    const char *instance = getenv("HYPRLAND_INSTANCE_SIGNATURE");
    const char *display_name = getenv("WAYLAND_DISPLAY");
    // The parent verifies compositor PID ownership and passes both identities.
    if (argc != 5 || !instance || !display_name || strcmp(instance, argv[1]) == 0
        || strcmp(instance, argv[2]) != 0 || strcmp(display_name, argv[3]) == 0
        || strcmp(display_name, argv[4]) != 0) return 1;
    struct wl_display *display = wl_display_connect(NULL);
    if (!display) return 1;
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &listener, NULL);
    if (wl_display_roundtrip(display) < 0 || !manager) return 1;
    struct wl_proxy *pointer = wl_proxy_marshal_flags(manager, 0, &pointer_interface, 1, 0, NULL, NULL);
    if (!pointer) return 1;
    // Register a mouse before any terminal binds its seat. No keyboard input.
    wl_proxy_marshal_flags(pointer, 1, NULL, 1, 0, 0u, 0u, 0u, 1280u, 800u);
    wl_proxy_marshal_flags(pointer, 4, NULL, 1, 0);
    if (wl_display_roundtrip(display) < 0) return 1;
    puts("ready");
    fflush(stdout);
    while (wl_display_dispatch(display) >= 0) {}
    wl_display_disconnect(display);
    return 1;
}
