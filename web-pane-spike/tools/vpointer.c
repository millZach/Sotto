// A virtual pointer for the owned nested compositor only (wlr-virtual-pointer-unstable-v1).
// Usage: vpointer <live WAYLAND_DISPLAY> <width> <height>  < commands
// Refuses to run when WAYLAND_DISPLAY is the live one. Commands, one per line:
//   move <x> <y>     absolute, in the compositor's layout pixels
//   down | up        left button
//   scroll <dy>      vertical axis, in pixels
//   sleep <ms>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>

static const struct wl_message pointer_requests[] = {
    {"motion", "uff", NULL}, {"motion_absolute", "uuuuu", NULL},
    {"button", "uuu", NULL}, {"axis", "uuf", NULL}, {"frame", "", NULL},
    {"axis_source", "u", NULL}, {"axis_stop", "uu", NULL},
    {"axis_discrete", "uufi", NULL}, {"destroy", "", NULL},
};
static const struct wl_interface pointer_interface = {"zwlr_virtual_pointer_v1", 1, 9, pointer_requests, 0, NULL};
static const struct wl_interface *create_types[] = {&wl_seat_interface, &pointer_interface};
static const struct wl_message manager_requests[] = {{"create_virtual_pointer", "?on", create_types}, {"destroy", "", NULL}};
static const struct wl_interface manager_interface = {"zwlr_virtual_pointer_manager_v1", 1, 2, manager_requests, 0, NULL};
static struct wl_proxy *manager;
static void global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t v) {
    (void)d; (void)v;
    if (strcmp(iface, manager_interface.name) == 0) manager = wl_registry_bind(r, name, &manager_interface, 1);
}
static void global_remove(void *d, struct wl_registry *r, uint32_t n) { (void)d; (void)r; (void)n; }
static const struct wl_registry_listener listener = {global, global_remove};
static uint32_t now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint32_t)(t.tv_sec * 1000 + t.tv_nsec / 1000000); }

int main(int argc, char **argv) {
    const char *display_name = getenv("WAYLAND_DISPLAY");
    if (argc != 4 || !display_name || strcmp(display_name, argv[1]) == 0) { fprintf(stderr, "refusing: not a nested display\n"); return 1; }
    uint32_t w = (uint32_t)atoi(argv[2]), h = (uint32_t)atoi(argv[3]);
    struct wl_display *display = wl_display_connect(NULL);
    if (!display) return 1;
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &listener, NULL);
    if (wl_display_roundtrip(display) < 0 || !manager) { fprintf(stderr, "no virtual pointer manager\n"); return 1; }
    struct wl_proxy *p = wl_proxy_marshal_flags(manager, 0, &pointer_interface, 1, 0, NULL, NULL);
    char line[128];
    while (fgets(line, sizeof line, stdin)) {
        int x, y; char cmd[16];
        if (sscanf(line, "move %d %d", &x, &y) == 2) {
            wl_proxy_marshal_flags(p, 1, NULL, 1, 0, now_ms(), (uint32_t)x, (uint32_t)y, w, h);
            wl_proxy_marshal_flags(p, 4, NULL, 1, 0);
        } else if (sscanf(line, "scroll %d", &y) == 1) {
            wl_proxy_marshal_flags(p, 5, NULL, 1, 0, 0u);
            wl_proxy_marshal_flags(p, 3, NULL, 1, 0, now_ms(), 0u, wl_fixed_from_int(y));
            wl_proxy_marshal_flags(p, 4, NULL, 1, 0);
        } else if (sscanf(line, "sleep %d", &x) == 1) {
            wl_display_flush(display); usleep((useconds_t)x * 1000);
        } else if (sscanf(line, "%15s", cmd) == 1 && (strcmp(cmd, "down") == 0 || strcmp(cmd, "up") == 0)) {
            wl_proxy_marshal_flags(p, 2, NULL, 1, 0, now_ms(), 0x110u, strcmp(cmd, "down") == 0 ? 1u : 0u);
            wl_proxy_marshal_flags(p, 4, NULL, 1, 0);
        }
        wl_display_roundtrip(display);
    }
    wl_proxy_marshal_flags(p, 8, NULL, 1, WL_MARSHAL_FLAG_DESTROY);
    wl_display_roundtrip(display);
    wl_display_disconnect(display);
    return 0;
}
