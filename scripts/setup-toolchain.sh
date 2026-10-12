#!/usr/bin/env bash
# Installs what is needed to build the on-chain programs on Ubuntu (native, WSL
# or CI): build packages, Rust, and the Agave CLI that provides `cargo
# build-sbf`. Safe to re-run; each step is skipped once it is in place.
#
# Versions follow Arch's own CI (arch-kit's deploy workflow).
set -euo pipefail

AGAVE_VERSION="${AGAVE_VERSION:-v3.1.9}"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

echo "==> build packages"
# libc6-dev-i386 looks out of place but is required: arch_program pulls in
# secp256k1's C sources, and compiling them for the VM target needs the generic
# libc headers that package provides.
PACKAGES="build-essential pkg-config libssl-dev libclang-dev libc6-dev-i386 clang cmake curl git ca-certificates bzip2 python3"
MISSING=""
for package in $PACKAGES; do
  dpkg -s "$package" >/dev/null 2>&1 || MISSING="$MISSING $package"
done
if [ -n "$MISSING" ]; then
  $SUDO apt-get update -qq
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq --no-install-recommends $MISSING
else
  echo "    already installed"
fi

echo "==> rust"
if ! command -v rustup >/dev/null 2>&1 && [ ! -x "$HOME/.cargo/bin/rustup" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
fi
# shellcheck disable=SC1091
. "$HOME/.cargo/env"
rustc --version

echo "==> agave ${AGAVE_VERSION} (cargo build-sbf)"
AGAVE_BIN="$HOME/.local/share/solana/install/active_release/bin"
if [ ! -x "$AGAVE_BIN/cargo-build-sbf" ] || ! "$AGAVE_BIN/solana" --version 2>/dev/null | grep -q "${AGAVE_VERSION#v}"; then
  sh -c "$(curl -sSfL "https://release.anza.xyz/${AGAVE_VERSION}/install")"
fi
export PATH="$AGAVE_BIN:$PATH"
solana --version
cargo-build-sbf --version

cat <<EOF

Toolchain ready. Add these to your shell profile if they are not there already:

  . "\$HOME/.cargo/env"
  export PATH="$AGAVE_BIN:\$PATH"
EOF
