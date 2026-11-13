#!/usr/bin/env sh
set -eu

component="${1:-${WALRUS_COMPONENT:-walrus@testnet}}"

case "$component" in
  -h|--help)
    cat <<'EOF'
usage: coordinator/scripts/install-walrus.sh [suiup-component]

Installs or updates the Walrus CLI with suiup, then prints the active version.

Default component: walrus@testnet
Override with:     WALRUS_COMPONENT=walrus@testnet coordinator/scripts/install-walrus.sh
                   coordinator/scripts/install-walrus.sh walrus
EOF
    exit 0
    ;;
esac

if ! command -v suiup >/dev/null 2>&1; then
  echo "suiup not found on PATH; install suiup first, then rerun this script" >&2
  exit 1
fi

if command -v walrus >/dev/null 2>&1; then
  echo "current walrus: $(walrus --version 2>/dev/null || echo unknown)"
  echo "updating ${component} with suiup..."
  if ! suiup update "$component" -y; then
    echo "suiup update failed; trying install ${component}..."
    suiup install "$component" -y
  fi
else
  echo "walrus not found; installing ${component} with suiup..."
  suiup install "$component" -y
fi

if ! command -v walrus >/dev/null 2>&1; then
  echo "walrus was installed but is not on PATH; add suiup's binary directory to PATH" >&2
  exit 1
fi

echo "active walrus: $(walrus --version)"
