#!/bin/sh
# Root part of the OpenWhispr egress filter. Run with: sudo ./install-openwhispr-net-root.sh
#  - puts the proxy config + allowlist in root-owned /etc/openwhispr-net (user processes can't widen it)
#  - lets Ubuntu's tinyproxy AppArmor profile read exactly those two files
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

install -d -m 755 -o root -g root /etc/openwhispr-net
install -m 644 -o root -g root "$HERE/openwhispr-net/tinyproxy.conf" "$HERE/openwhispr-net/allowlist.txt" /etc/openwhispr-net/

cat > /etc/apparmor.d/local/tinyproxy <<'RULES'
# OpenWhispr egress filter: read its config and allowlist, nothing else.
file r /etc/openwhispr-net/tinyproxy.conf,
file r /etc/openwhispr-net/allowlist.txt,
RULES
apparmor_parser -r /etc/apparmor.d/tinyproxy
systemctl disable --now tinyproxy 2>/dev/null || true
echo "done: /etc/openwhispr-net installed, AppArmor profile reloaded"
