#!/usr/bin/env bash
# One-shot TURN (coturn) setup for an Ubuntu DigitalOcean droplet.
#
# Run it on the droplet:
#   bash setup-turn.sh
#
# It installs coturn, writes a config with a random password, and prints the
# exact iceServers snippet to paste into src/shared/link.ts (or paste the
# password back to whoever is wiring it in).
set -euo pipefail

IP="${1:-24.199.108.142}"
TURN_USER="fish"
TURN_PASS="$(openssl rand -hex 16)"

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root (or with sudo)."
  exit 1
fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script assumes Ubuntu/Debian (apt)."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y coturn openssl

cat > /etc/turnserver.conf <<EOF
listening=3478
tcp-listening=3478
relay-ip=${IP}
use-ip=${IP}
min-port=49152
max-port=65535
user=${TURN_USER}:${TURN_PASS}
no-cli
no-tls
no-dtls
fingerprint
no-multicast-peers
total-quota=20
max-allocated-bps=2000000
syslog
EOF

systemctl enable coturn
systemctl restart coturn

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 3478/udp
  ufw allow 3478/tcp
  ufw allow 49152:65535/udp
  echo "Opened ufw rules (3478 udp/tcp, 49152-65535 udp)."
fi

echo
echo "TURN server ready on ${IP}"
echo
echo "Add this to RTC_CONFIG in src/shared/link.ts:"
echo
cat <<EOF
  {
    urls: ['turn:${IP}:3478?transport=udp', 'turn:${IP}:3478?transport=tcp'],
    username: '${TURN_USER}',
    credential: '${TURN_PASS}',
  },
EOF
echo
echo "Note: if a DigitalOcean project firewall is enabled for this droplet,"
echo "also allow inbound UDP+TCP 3478 and UDP 49152-65535 there."
