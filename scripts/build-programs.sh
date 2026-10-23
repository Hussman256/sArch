#!/usr/bin/env bash
# Builds the on-chain programs for the Arch VM.
#
#   scripts/build-programs.sh            build every program
#   scripts/build-programs.sh config     build one
#
# Output: programs/target/deploy/archpad_<name>.so
#
# Run on Linux (or WSL) after scripts/setup-toolchain.sh.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRAMS_DIR="$REPO/programs"
OUT_DIR="$PROGRAMS_DIR/target/deploy"

# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
command -v cargo-build-sbf >/dev/null || { echo "cargo-build-sbf not found: run scripts/setup-toolchain.sh" >&2; exit 1; }

# On WSL the repository usually sits on the Windows drive, where builds are
# slow. Keep intermediate artifacts on the Linux filesystem instead.
case "$REPO" in
  /mnt/*)
    export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/archpad/sbf-target}"
    SBF_OUT_DIR="$HOME/.cache/archpad/deploy"
    ;;
  *)
    SBF_OUT_DIR="$OUT_DIR"
    ;;
esac
TARGET_DIR="${CARGO_TARGET_DIR:-$PROGRAMS_DIR/target}"
command -v nm >/dev/null || { echo "nm not found: run scripts/setup-toolchain.sh" >&2; exit 1; }

if [ "$#" -gt 0 ]; then
  NAMES=("$@")
else
  NAMES=()
  for manifest in "$PROGRAMS_DIR"/*/Cargo.toml; do
    NAMES+=("$(basename "$(dirname "$manifest")")")
  done
fi

mkdir -p "$OUT_DIR" "$SBF_OUT_DIR"
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

# The VM gives every function a fixed 4 KB stack frame and does not fault when
# one overruns it: the overflow silently lands in the next frame. The toolchain
# reports such functions and then exits 0 anyway, so the checks below turn those
# reports into build failures.
check_stack_frames() {
  local name="$1" elf="$2"

  if grep -q "overwrites values in the frame" "$LOG"; then
    echo "error: $name has a function that overwrites its caller's stack frame (see above)" >&2
    return 1
  fi

  # One report is expected and harmless: `bitcode::histogram`, in a dependency
  # of arch_program, which is never called and is dropped at link time. That is
  # only safe while it really is dropped, so check. The deployed binary has no
  # symbol names left to look at, so this reads the unstripped one beside it,
  # and refuses to pass if that one has no symbols either.
  local symbols
  symbols="$(nm "$elf" 2>/dev/null || true)"
  if [ -z "$symbols" ]; then
    echo "error: cannot read symbols from $elf to check for oversized stack frames" >&2
    return 1
  fi
  if grep -q "bitcode.*histogram" <<<"$symbols"; then
    echo "error: bitcode::histogram survived into $name, so its oversized frame is live code" >&2
    return 1
  fi
  local oversized
  oversized="$(grep "exceeded max offset" "$LOG" | grep -v "bitcode" || true)"
  if [ -n "$oversized" ]; then
    echo "error: $name has a function whose stack frame exceeds the VM's 4 KB limit:" >&2
    echo "$oversized" >&2
    echo "hint: move large values to the heap or into a function marked #[inline(never)]" >&2
    return 1
  fi
}

for name in "${NAMES[@]}"; do
  manifest="$PROGRAMS_DIR/$name/Cargo.toml"
  [ -f "$manifest" ] || { echo "no such program: $name" >&2; exit 1; }
  echo "==> $name"
  cargo build-sbf --manifest-path "$manifest" --sbf-out-dir "$SBF_OUT_DIR" 2>&1 | tee "$LOG"
  [ -f "$SBF_OUT_DIR/archpad_$name.so" ] || { echo "error: build of $name produced no program" >&2; exit 1; }
  cp -f "$SBF_OUT_DIR/archpad_$name.so" "$OUT_DIR/archpad_$name.so"
  check_stack_frames "$name" "$TARGET_DIR/sbpf-solana-solana/release/archpad_$name.so"
done

echo
ls -l "$OUT_DIR"/*.so
