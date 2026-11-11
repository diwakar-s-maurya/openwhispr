#!/bin/sh
# Flatpak launcher for local.surface.OpenWhispr.
#
# Starts the Electron binary directly, not electron-builder's wrapper script:
# that one forces XWayland, may add --no-sandbox, and reads extra flags from a
# file the app itself can write. Chromium's sandbox is provided by zypak.
#
# Network: the sandbox has only loopback. src/helpers/hardenedEgress.js bridges
# 127.0.0.1:18080 to the host's filtering proxy on OW_PROXY_SOCKET, and both
# Chromium and Node send everything there.
set -eu
export OW_PROXY_SOCKET="${XDG_RUNTIME_DIR}/openwhispr-net/proxy.sock"
export HTTPS_PROXY=http://127.0.0.1:18080
export HTTP_PROXY=http://127.0.0.1:18080
export NO_PROXY=
export NODE_USE_ENV_PROXY=1
export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"
# The model catalog ships with the app; never fetch one at runtime.
export OPENWHISPR_MODEL_REGISTRY_MODE=bundled
# Wayland app_id, so the desktop matches windows to the .desktop entry.
export CHROME_DESKTOP=local.surface.OpenWhispr.desktop
exec zypak-wrapper /app/openwhispr/open-whispr-app \
  --ozone-platform=wayland \
  --enable-features=WaylandWindowDecorations \
  "$@"
