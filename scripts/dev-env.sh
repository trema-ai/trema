# Sourced by mise ([env] _.source) before every task, so parallel worktrees
# of this repo can run `mise run dev` side by side without port conflicts.
#
# Each worktree gets a stable "slot" that offsets every dev port:
#
#   server         3000 + slot
#   web            5173 + slot
#   postgres       5432 + slot
#   hatchet grpc   7077 + slot
#   hatchet web    8888 + slot
#
# The main checkout is slot 0, which keeps the documented default ports and
# the existing compose project (and therefore the existing database volume).
# A linked worktree hashes its absolute path into a slot from 1-99, so the
# slot survives re-clones of the same path and never depends on creation
# order. Set TREMA_DEV_SLOT_PIN to pin a slot explicitly — for example when
# two worktree paths happen to hash to the same slot.
#
# Linked worktrees also get their own compose project name, which isolates
# the postgres container and volume per worktree.
#
# Two constraints shape the mechanics here:
#
# - A worktree under .claude/worktrees/ sits inside the main checkout, so
#   mise loads both configs and sources this file twice, outer first. The
#   slot is therefore recomputed unconditionally from this file's own root —
#   the innermost config wins — instead of deferring to a value a previous
#   sourcing exported. Pinning uses the separate TREMA_DEV_SLOT_PIN variable
#   so a pin is distinguishable from an outer computation.
# - mise sources env scripts with its own machinery (and may cache results),
#   so BASH_SOURCE is not guaranteed; the root comes from TREMA_ROOT, which
#   mise.toml sets to {{config_root}} right before sourcing this file.

if [ -n "${TREMA_ROOT:-}" ]; then
  _trema_root="$TREMA_ROOT"
elif [ -n "${BASH_SOURCE:-}" ]; then
  _trema_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
else
  _trema_root="$PWD"
fi

if [ -n "${TREMA_DEV_SLOT_PIN:-}" ]; then
  TREMA_DEV_SLOT="$TREMA_DEV_SLOT_PIN"
elif [ -f "$_trema_root/.git" ]; then
  # In a linked worktree `.git` is a file pointing at the real git dir; in
  # the main checkout it is a directory.
  TREMA_DEV_SLOT=$((($(printf %s "$_trema_root" | cksum | cut -d' ' -f1) % 99) + 1))
else
  TREMA_DEV_SLOT=0
fi

export TREMA_DEV_SLOT
export TREMA_SERVER_PORT=$((3000 + TREMA_DEV_SLOT))
export TREMA_WEB_PORT=$((5173 + TREMA_DEV_SLOT))
export TREMA_DB_PORT=$((5432 + TREMA_DEV_SLOT))
export TREMA_HATCHET_PORT=$((8888 + TREMA_DEV_SLOT))
export TREMA_HATCHET_GRPC_PORT=$((7077 + TREMA_DEV_SLOT))

# Override a compose project name a previous sourcing of this file set, but
# never one the user chose themselves.
case "${COMPOSE_PROJECT_NAME:-}" in
"" | trema-s*)
  if [ "$TREMA_DEV_SLOT" -ne 0 ]; then
    export COMPOSE_PROJECT_NAME="trema-s${TREMA_DEV_SLOT}"
  fi
  ;;
esac

unset _trema_root
