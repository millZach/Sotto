// A mouse for the owned nested Hyprland in verify-omarchy-shell-plugin.sh,
// which drags and clicks the plugin there while the live session stays
// locked and untouched.
// Reads one command per line on stdin and answers "ok" once the compositor
// has it:  move <x> <y> <layout-width> <layout-height> | down | up
// Usage: nested-pointer <live-instance> <nested-instance> <live-display> <nested-display>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
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

enum { MOTION_ABSOLUTE = 1, BUTTON = 2, FRAME = 4 };
#define BTN_LEFT 0x110

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

static uint32_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

int main(int argc, char **argv) {
    const char *instance = getenv("HYPRLAND_INSTANCE_SIGNATURE");
    const char *display_name = getenv("WAYLAND_DISPLAY");
    // The caller verified that it owns the nested compositor and passes both
    // identities; refuse anything that is, or is not plainly, the nested one.
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
    if (wl_display_roundtrip(display) < 0) return 1;
    puts("ready");
    fflush(stdout);

    char line[256];
    while (fgets(line, sizeof line, stdin)) {
        unsigned x, y, width, height;
        if (sscanf(line, "move %u %u %u %u", &x, &y, &width, &height) == 4) {
            wl_proxy_marshal_flags(pointer, MOTION_ABSOLUTE, NULL, 1, 0, now_ms(), x, y, width, height);
        } else if (strncmp(line, "down", 4) == 0) {
            wl_proxy_marshal_flags(pointer, BUTTON, NULL, 1, 0, now_ms(), BTN_LEFT, 1u);
        } else if (strncmp(line, "up", 2) == 0) {
            wl_proxy_marshal_flags(pointer, BUTTON, NULL, 1, 0, now_ms(), BTN_LEFT, 0u);
        } else {
            puts("unknown");
            fflush(stdout);
            continue;
        }
        wl_proxy_marshal_flags(pointer, FRAME, NULL, 1, 0);
        if (wl_display_roundtrip(display) < 0) return 1;
        puts("ok");
        fflush(stdout);
    }
    wl_display_disconnect(display);
    return 0;
}
