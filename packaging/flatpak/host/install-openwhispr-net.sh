#!/bin/sh
# Installs the OpenWhispr egress filter as systemd USER units (no root needed here).
# Prerequisites (run yourself): sudo apt install tinyproxy; sudo ./install-openwhispr-net-root.sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
UNITS="$HOME/.config/systemd/user"

command -v tinyproxy >/dev/null || { echo "tinyproxy is not installed"; exit 1; }
if systemctl is-active --quiet tinyproxy 2>/dev/null; then
  echo "The system-wide tinyproxy service is running (an open proxy on port 8888)."
  echo "Disable it first: sudo systemctl disable --now tinyproxy"
  exit 1
fi

[ -r /etc/openwhispr-net/allowlist.txt ] || { echo "run: sudo $HERE/install-openwhispr-net-root.sh"; exit 1; }
install -d "$UNITS"
install -m 644 "$HERE/systemd/openwhispr-net.socket" "$HERE/systemd/openwhispr-net.service" \
  "$HERE/systemd/openwhispr-net-tinyproxy.service" "$UNITS/"

systemctl --user daemon-reload
systemctl --user enable --now openwhispr-net.socket
systemctl --user restart openwhispr-net-tinyproxy.service
systemctl --user --no-pager status openwhispr-net.socket openwhispr-net-tinyproxy.service | grep -E "●|Active:"
ls -l "${XDG_RUNTIME_DIR}/openwhispr-net/proxy.sock"
