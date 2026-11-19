// One N-API call: send a 64-byte record and, optionally, one file descriptor over a Unix socket (SCM_RIGHTS).
// N-API is ABI-stable, so a build against Node's headers loads in Electron's main process.
#include <node_api.h>
#include <sys/socket.h>
#include <string.h>
#include <errno.h>

static napi_value Send(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t sock = -1, fd = -1; void *data = NULL; size_t len = 0;
  napi_get_value_int32(env, argv[0], &sock);
  napi_get_buffer_info(env, argv[1], &data, &len);
  napi_get_value_int32(env, argv[2], &fd);
  struct iovec iov = { data, len };
  struct msghdr m; memset(&m, 0, sizeof m);
  m.msg_iov = &iov; m.msg_iovlen = 1;
  char ctrl[CMSG_SPACE(sizeof(int))]; memset(ctrl, 0, sizeof ctrl);
  if (fd >= 0) {
    m.msg_control = ctrl; m.msg_controllen = sizeof ctrl;
    struct cmsghdr *c = CMSG_FIRSTHDR(&m);
    c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(c), &fd, sizeof fd);
  }
  ssize_t n = sendmsg(sock, &m, MSG_NOSIGNAL);
  napi_value r; napi_create_int32(env, n < 0 ? -errno : (int32_t)n, &r);
  return r;
}

NAPI_MODULE_INIT() {
  napi_value f;
  napi_create_function(env, "send", NAPI_AUTO_LENGTH, Send, NULL, &f);
  napi_set_named_property(env, exports, "send", f);
  return exports;
}
