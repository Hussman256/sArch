#!/usr/bin/env bash
# A local Arch chain for development: Bitcoin Core in regtest mode, the Titan
# indexer on top of it, and Arch's local validator on top of that.
#
#   scripts/localnet.sh setup     download and build everything (once)
#   scripts/localnet.sh run       start the chain and stay attached (Ctrl-C stops it)
#   scripts/localnet.sh start     start the chain in the background
#   scripts/localnet.sh stop      stop it
#   scripts/localnet.sh status    show what is running
#   scripts/localnet.sh reset     stop and delete all chain data
#
# Endpoints once running:
#   Arch RPC        http://127.0.0.1:9002
#   Arch WebSocket  ws://127.0.0.1:10081
#   Bitcoin RPC     http://127.0.0.1:18443  (bitcoin / bitcoinpass)
#   Titan           http://127.0.0.1:3030
#
# Linux only (including WSL 2). On WSL, use `run`: the distro shuts down, and
# takes background processes with it, once nothing is attached to it.
#
# Arch also ships this stack as Docker images (`arch-cli orchestrate start`).
# This script exists for machines without Docker.
set -euo pipefail

ARCH_VERSION="${ARCH_VERSION:-v0.12.0}"
BITCOIN_VERSION="${BITCOIN_VERSION:-28.1}"
TITAN_REPO="${TITAN_REPO:-https://github.com/Arch-Network/Titan.git}"
# Titan has no releases; pin the commit so a rebuild gets the same indexer.
TITAN_COMMIT="${TITAN_COMMIT:-3fd2b529f049bbca87f4e861e89f44a33dcc454d}"

HOME_DIR="${ARCHPAD_HOME:-$HOME/.archpad}"
BIN="$HOME_DIR/bin"
SRC="$HOME_DIR/src"
DATA="$HOME_DIR/localnet"
LOGS="$DATA/logs"
PIDS="$DATA/pids"

BTC_RPC_PORT=18443
BTC_P2P_PORT=18444
BTC_USER=bitcoin
BTC_PASS=bitcoinpass
TITAN_HTTP=127.0.0.1:3030
TITAN_TCP=127.0.0.1:8080
ARCH_RPC_PORT=9002
ARCH_WS_PORT=10081

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

btc_cli() {
  "$BIN/bitcoin-cli" -regtest -rpcport="$BTC_RPC_PORT" -rpcuser="$BTC_USER" -rpcpassword="$BTC_PASS" "$@"
}

arch_rpc() {
  curl -s -m 5 -X POST "http://127.0.0.1:$ARCH_RPC_PORT" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}"
}

is_running() {
  local pidfile="$PIDS/$1.pid"
  [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

# --- setup -------------------------------------------------------------------

glibc_at_least() {
  local have
  have="$(ldd --version | head -n1 | grep -oE '[0-9]+\.[0-9]+$')"
  [ "$(printf '%s\n%s\n' "$1" "$have" | sort -V | head -n1)" = "$1" ]
}

setup_arch() {
  local base="https://github.com/Arch-Network/arch-node/releases/download/$ARCH_VERSION"
  say "Arch $ARCH_VERSION binaries"
  mkdir -p "$BIN"
  curl -fsSL -o "$BIN/arch-manifest.json" "$base/$ARCH_VERSION.json"
  local name asset want got
  for name in local_validator arch-cli; do
    asset="$name-x86_64-unknown-linux-gnu"
    [ -x "$BIN/$name.bin" ] || { curl -fsSL -o "$BIN/$name.tmp" "$base/$asset"; mv "$BIN/$name.tmp" "$BIN/$name.bin"; chmod +x "$BIN/$name.bin"; }
    want="$(python3 -c "import json,sys; print(next(a['sha256'] for a in json.load(open(sys.argv[1]))['artifacts'] if a['name']==sys.argv[2]))" "$BIN/arch-manifest.json" "$asset")"
    got="$(sha256sum "$BIN/$name.bin" | cut -d' ' -f1)"
    [ "$want" = "$got" ] || die "$name does not match the checksum in the release manifest"
  done

  # The release binaries need glibc 2.38 (arch-cli: 2.39). On an older distro,
  # unpack a newer glibc next to the system one and run them through its
  # loader. Nothing on the system is replaced.
  local loader="" libdir=""
  if ! glibc_at_least 2.39; then
    say "system glibc is older than 2.39; unpacking a newer one under $HOME_DIR/glibc"
    if [ ! -d "$HOME_DIR/glibc/extracted" ]; then
      local pool="http://archive.ubuntu.com/ubuntu/pool/main/g/glibc" deb
      mkdir -p "$HOME_DIR/glibc"
      deb="$(curl -fsSL "$pool/" | grep -o 'libc6_2\.39-[^"]*_amd64\.deb' | sort -uV | tail -n1)"
      [ -n "$deb" ] || die "could not find a libc6 2.39 package at $pool"
      curl -fsSL -o "$HOME_DIR/glibc/$deb" "$pool/$deb"
      mkdir -p "$HOME_DIR/glibc/extracted"
      dpkg-deb -x "$HOME_DIR/glibc/$deb" "$HOME_DIR/glibc/extracted"
      rm -f "$HOME_DIR/glibc/$deb"
    fi
    loader="$(find "$HOME_DIR/glibc/extracted" -name 'ld-linux-x86-64.so.2' | head -n1)"
    libdir="$(dirname "$(find "$HOME_DIR/glibc/extracted" -name 'libc.so.6' | head -n1)")"
  fi
  for name in local_validator arch-cli; do
    if [ -n "$loader" ]; then
      printf '#!/usr/bin/env bash\nexec "%s" --library-path "%s:/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu" "%s" "$@"\n' \
        "$loader" "$libdir" "$BIN/$name.bin" > "$BIN/$name"
    else
      printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$BIN/$name.bin" > "$BIN/$name"
    fi
    chmod +x "$BIN/$name"
  done
  "$BIN/local_validator" --version
}

setup_bitcoin() {
  say "Bitcoin Core $BITCOIN_VERSION"
  if [ -x "$BIN/bitcoind" ] && "$BIN/bitcoind" --version | head -n1 | grep -q "v$BITCOIN_VERSION"; then
    echo "already installed"
    return
  fi
  local base="https://bitcoincore.org/bin/bitcoin-core-$BITCOIN_VERSION"
  local tarball="bitcoin-$BITCOIN_VERSION-x86_64-linux-gnu.tar.gz"
  local tmp; tmp="$(mktemp -d)"
  curl -fL --retry 5 --retry-all-errors -C - -o "$tmp/$tarball" "$base/$tarball"
  curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
  ( cd "$tmp" && grep " $tarball\$" SHA256SUMS | sha256sum -c - ) || die "Bitcoin Core download does not match SHA256SUMS"
  tar -xzf "$tmp/$tarball" -C "$tmp"
  install -m 0755 "$tmp/bitcoin-$BITCOIN_VERSION/bin/bitcoind" "$tmp/bitcoin-$BITCOIN_VERSION/bin/bitcoin-cli" "$BIN/"
  rm -rf "$tmp"
  "$BIN/bitcoind" --version | head -n1
}

setup_titan() {
  say "Titan indexer (built from source; this takes a while the first time)"
  if [ -x "$BIN/titan" ]; then
    echo "already built"
    return
  fi
  command -v cargo >/dev/null || die "cargo not found: run scripts/setup-toolchain.sh first"
  mkdir -p "$SRC"
  [ -d "$SRC/Titan/.git" ] || git clone --quiet "$TITAN_REPO" "$SRC/Titan"
  if [ -n "$TITAN_COMMIT" ]; then
    git -C "$SRC/Titan" fetch --quiet origin "$TITAN_COMMIT" || true
    git -C "$SRC/Titan" checkout --quiet "$TITAN_COMMIT"
  fi
  echo "building commit $(git -C "$SRC/Titan" rev-parse --short HEAD)"
  ( cd "$SRC/Titan" && cargo build --release -p titan )
  install -m 0755 "$SRC/Titan/target/release/titan" "$BIN/titan"
}

cmd_setup() {
  mkdir -p "$BIN"
  setup_arch
  setup_bitcoin
  setup_titan
  say "setup complete"
}

# --- run ---------------------------------------------------------------------

wait_for() {
  local what="$1" tries="$2"; shift 2
  local i
  for i in $(seq 1 "$tries"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  die "$what did not come up; see $LOGS"
}

start_bitcoind() {
  is_running bitcoind && return
  say "bitcoind (regtest)"
  mkdir -p "$DATA/bitcoin"
  "$BIN/bitcoind" -regtest -datadir="$DATA/bitcoin" -server=1 -txindex=1 \
    -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 -rpcport="$BTC_RPC_PORT" -port="$BTC_P2P_PORT" \
    -rpcuser="$BTC_USER" -rpcpassword="$BTC_PASS" -fallbackfee=0.001 \
    > "$LOGS/bitcoind.log" 2>&1 &
  echo $! > "$PIDS/bitcoind.pid"
  wait_for "bitcoind" 60 btc_cli getblockchaininfo

  btc_cli -named createwallet wallet_name=testwallet >/dev/null 2>&1 || btc_cli loadwallet testwallet >/dev/null 2>&1 || true
  if [ "$(btc_cli getblockcount)" -lt 101 ]; then
    # Coinbase outputs need 100 confirmations before they can be spent.
    btc_cli -rpcwallet=testwallet generatetoaddress 101 "$(btc_cli -rpcwallet=testwallet getnewaddress)" >/dev/null
  fi
}

start_titan() {
  is_running titan && return
  say "titan"
  mkdir -p "$DATA/titan"
  "$BIN/titan" --chain regtest \
    --bitcoin-rpc-url "http://127.0.0.1:$BTC_RPC_PORT" \
    --bitcoin-rpc-username "$BTC_USER" --bitcoin-rpc-password "$BTC_PASS" \
    --index-addresses --index-bitcoin-transactions --enable-tcp-subscriptions \
    --data-dir "$DATA/titan" --http-listen "$TITAN_HTTP" --tcp-address "$TITAN_TCP" \
    > "$LOGS/titan.log" 2>&1 &
  echo $! > "$PIDS/titan.pid"
  wait_for "titan" 120 curl -sf -m 3 "http://$TITAN_HTTP/status"
}

start_validator() {
  is_running validator && return
  say "arch local validator"
  mkdir -p "$DATA/arch"
  "$BIN/local_validator" --network-mode localnet --data-dir "$DATA/arch" \
    --rpc-bind-ip 127.0.0.1 --rpc-bind-port "$ARCH_RPC_PORT" \
    --websocket-bind-ip 127.0.0.1 --websocket-bind-port "$ARCH_WS_PORT" \
    --titan-endpoint "http://$TITAN_HTTP" --titan-socket-endpoint "$TITAN_TCP" \
    > "$LOGS/validator.log" 2>&1 &
  echo $! > "$PIDS/validator.pid"
  node_ready() { arch_rpc is_node_ready | grep -q '"result":true'; }
  wait_for "the validator" 120 node_ready
}

cmd_start() {
  for bin in bitcoind bitcoin-cli titan local_validator; do
    [ -x "$BIN/$bin" ] || die "$bin is missing: run '$0 setup' first"
  done
  mkdir -p "$LOGS" "$PIDS"
  start_bitcoind
  start_titan
  start_validator
  say "localnet is up: Arch RPC http://127.0.0.1:$ARCH_RPC_PORT (block $(arch_rpc get_block_count | grep -oE '[0-9]+' | tail -n1))"
}

cmd_stop() {
  local name
  for name in validator titan bitcoind; do
    if is_running "$name"; then
      say "stopping $name"
      kill "$(cat "$PIDS/$name.pid")" 2>/dev/null || true
      for _ in $(seq 1 20); do is_running "$name" || break; sleep 0.5; done
      is_running "$name" && kill -9 "$(cat "$PIDS/$name.pid")" 2>/dev/null || true
    fi
    rm -f "$PIDS/$name.pid"
  done
}

cmd_status() {
  local name
  for name in bitcoind titan validator; do
    if is_running "$name"; then echo "$name: running (pid $(cat "$PIDS/$name.pid"))"; else echo "$name: stopped"; fi
  done
  if is_running validator; then
    echo "arch block height: $(arch_rpc get_block_count | grep -oE '[0-9]+' | tail -n1)"
    echo "arch version:      $(arch_rpc get_version | grep -oE '"version":"[^"]+"')"
  fi
}

cmd_run() {
  trap 'cmd_stop; exit 0' INT TERM
  cmd_start
  say "attached; Ctrl-C to stop"
  # Stay in the foreground, and bring the chain down if a piece of it dies.
  while is_running bitcoind && is_running titan && is_running validator; do sleep 2; done
  echo "a localnet process exited unexpectedly; see $LOGS" >&2
  cmd_stop
  exit 1
}

case "${1:-}" in
  setup) cmd_setup ;;
  start) cmd_start ;;
  run) cmd_run ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  reset) cmd_stop; rm -rf "$DATA"; say "chain data deleted" ;;
  *) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
