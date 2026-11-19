#!/bin/sh
set -e

cat > /usr/share/nginx/html/app/config.js <<EOF
window.__APP_CONFIG__ = {
  WAMP_WT_URL: "${VITE_WAMP_WT_URL:-https://localhost:8082/wamp}",
  WAMP_WT_CERT_URL: "${VITE_WAMP_WT_CERT_URL:-}",
  WAMP_REALM: "${VITE_WAMP_REALM:-com.deskconn}",
  REGISTRATION_AUTHID: "${VITE_REGISTRATION_AUTHID:-deskconn-web-app}"
};
EOF

exec "$@"
