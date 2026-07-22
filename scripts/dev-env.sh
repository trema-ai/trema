# Sourced by mise ([env] _.source) before every task, so parallel worktrees
# of this repo can run `mise run dev` side by side without port conflicts.
#
# Each worktree gets a stable "slot" that offsets every dev port:
#
#   server    3000 + slot
#   web       5173 + slot
#   postgres  5432 + slot
#
# The main checkout is slot 0, which keeps the documented default ports and
# the existing compose project (and therefore the existing database volume).
# A linked worktree hashes its absolute path into a slot from 1-99, so the
# slot survives re-clones of the same path and never depends on creation
# order. Set TREMA_DEV_SLOT in the environment to pin a slot explicitly —
# for example when two worktree paths happen to hash to the same slot.
#
# Linked worktrees also get their own compose project name, which isolates
# the postgres container and volume per worktree.

_trema_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "${TREMA_DEV_SLOT:-}" ]; then
  # In a linked worktree `.git` is a file pointing at the real git dir; in
  # the main checkout it is a directory.
  if [ -f "$_trema_root/.git" ]; then
    TREMA_DEV_SLOT=$((($(printf %s "$_trema_root" | cksum | cut -d' ' -f1) % 99) + 1))
  else
    TREMA_DEV_SLOT=0
  fi
fi

export TREMA_DEV_SLOT
export TREMA_SERVER_PORT=$((3000 + TREMA_DEV_SLOT))
export TREMA_WEB_PORT=$((5173 + TREMA_DEV_SLOT))
export TREMA_DB_PORT=$((5432 + TREMA_DEV_SLOT))

if [ "$TREMA_DEV_SLOT" -ne 0 ] && [ -z "${COMPOSE_PROJECT_NAME:-}" ]; then
  export COMPOSE_PROJECT_NAME="trema-s${TREMA_DEV_SLOT}"
fi

unset _trema_root
