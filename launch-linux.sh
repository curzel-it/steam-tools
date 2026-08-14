#!/bin/sh
# THE LINUX DEPOT'S ENTRY POINT, and the reason it is a script rather than the binary itself.
#
# Electron ships a helper called chrome-sandbox that has to be owned by root with the setuid bit
# (mode 4755). STEAM DEPOTS DO NOT CARRY THE SETUID BIT, and the Steam client that unpacks them is
# not root, so it could not restore it even if the depot recorded it. Electron then refuses to start
# rather than run unsandboxed:
#
#   FATAL:setuid_sandbox_host.cc The SUID sandbox helper binary was found, but is not
#   configured correctly. Rather than run without sandboxing I'm aborting now.
#
# That goes to stderr, WHICH STEAM SHOWS NOBODY. The player presses Play, the status flips Running
# then Stopped, no window ever appears and no error is displayed. It is the single most likely way
# a Linux depot ships broken, and it does not reproduce on a desktop distro — there chrome-sandbox
# still has its bit from the tarball.
#
# IT ALSO CANNOT BE FIXED FROM JAVASCRIPT. Chromium sets its sandbox up during early startup, before
# the Electron main script is ever evaluated, so app.commandLine.appendSwitch() is too late and
# cannot even print that it fired (electron/electron#20063). That cost two rounds of debugging on a
# fallback module which read as load-bearing and was provably inert. The flag has to be on argv,
# which is the whole job of this file.
#
# THREE RUNGS, BEST FIRST, EACH ONE MEASURED RATHER THAN ASSUMED:
#
#   1. chrome-sandbox is setuid AND root-owned — no flag at all, the full setuid sandbox. A
#      SteamPipe depot can never reach this rung; a tarball unpacked by hand can, which is the only
#      reason it is still asked.
#   2. unprivileged user namespaces work — --disable-setuid-sandbox, which turns off the helper
#      alone and leaves Chromium its namespace sandbox, so a renderer configured with
#      `sandbox: true` stays confined. A normal Linux Steam install lands here.
#   3. neither — --no-sandbox, because the alternative is not a safer game, it is no window and no
#      error. Flatpak Steam cannot nest user namespaces, and that is the default install on
#      Bazzite, Nobara and most Fedora software centres; Ubuntu 24.04's AppArmor restriction blocks
#      them on native Steam. Both measured on a real box.
#
# RUNG 2 IS ASKED, NOT ASSUMED, which is the whole difference from simply always passing
# --disable-setuid-sandbox: the sysctls can say namespaces are allowed while the runtime the game
# is inside still denies the syscall, so the probe is an actual unshare. Anything it cannot prove
# falls to rung 3 — the direction for a wrong answer to be wrong in, since that one still plays.
#
# STEAM_TOOLS_SANDBOX overrides the lot: 1 keeps the full sandbox, 0 forces --no-sandbox. Reachable
# from Steam's Launch Options as `STEAM_TOOLS_SANDBOX=0 %command%`, so a player whose machine this
# file reads wrong has a game tonight instead of after a depot upload.
#
# WHICH BINARY IT WRAPS IS FOUND, NOT NAMED, so this file ships unmodified from one project to the
# next: everything beside it that is a plain file, carries no dot in its name, is not this script
# and is not one of Chromium's own helpers. In an electron-builder --dir output that is exactly one
# file, whatever `linux.executableName` was set to. STEAM_TOOLS_EXE names it outright if a layout
# ever makes that untrue, and an ambiguous directory is an error rather than a guess.
#
# WHY THE POLICY LIVES HERE AND NOT IN A STEAMWORKS TEXT FIELD. A launch option is invisible from
# the repo, absent from every local test, and one careless edit in a web form from being gone. In
# here it ships with the build, and `sh -x launch-linux.sh` says out loud which rung a player's
# machine took.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
self=${0##*/}

if [ -n "${STEAM_TOOLS_EXE:-}" ]; then
  exe="$here/$STEAM_TOOLS_EXE"
  if [ ! -f "$exe" ]; then
    echo "launch-linux: STEAM_TOOLS_EXE names $STEAM_TOOLS_EXE, which is not beside this script" >&2
    exit 1
  fi
else
  # Two passes' worth of bookkeeping in one loop, because the shell has no arrays and an
  # executable name may contain a space. THE EXEC BIT IS THE TIEBREAK rather than the filter:
  # SteamPipe preserves it, but a binary that somehow arrived without one should be found and
  # repaired below rather than reported missing.
  exe=""
  runnable=0
  plain=""
  plain_count=0
  for path in "$here"/*; do
    [ -f "$path" ] || continue
    name=${path##*/}
    case "$name" in
      "$self" | *.* | chrome-sandbox | chrome_crashpad_handler | LICENSE) continue ;;
    esac
    if [ -x "$path" ]; then
      exe="$path"
      runnable=$((runnable + 1))
    else
      plain="$path"
      plain_count=$((plain_count + 1))
    fi
  done

  if [ "$runnable" -eq 0 ] && [ "$plain_count" -eq 1 ]; then
    exe="$plain"
    runnable=1
  fi

  if [ "$runnable" -eq 0 ]; then
    echo "launch-linux: no game binary beside this script." >&2
    echo "              Set STEAM_TOOLS_EXE to its name if it is there under one." >&2
    exit 1
  fi
  if [ "$runnable" -gt 1 ]; then
    echo "launch-linux: more than one binary beside this script, so it will not guess:" >&2
    for path in "$here"/*; do
      [ -f "$path" ] && [ -x "$path" ] || continue
      name=${path##*/}
      case "$name" in
        "$self" | *.* | chrome-sandbox | chrome_crashpad_handler | LICENSE) continue ;;
      esac
      echo "              $name" >&2
    done
    echo "              Set STEAM_TOOLS_EXE to the one to launch." >&2
    exit 1
  fi
fi

# THE EXECUTE BIT IS A DIFFERENT LOSS FROM THE SETUID ONE, and it survives SteamPipe where setuid
# does not — but a binary that arrives without it fails in exactly the same silent way, so it is
# restored rather than assumed. Unlike setuid this needs no privileges: the files belong to the
# player who just downloaded them.
[ -x "$exe" ] || chmod +x "$exe" 2>/dev/null || true

# Rung 1. Both halves matter: a chrome-sandbox that is present and merely executable is exactly
# what a depot delivers, and is the case that aborts.
helper_is_root_setuid() {
  [ -u "$here/chrome-sandbox" ] \
    && [ "$(stat -c %u "$here/chrome-sandbox" 2>/dev/null || echo -1)" = "0" ]
}

# Rung 2. An unshare rather than a sysctl, because /proc can say yes where the syscall says no —
# and if the tool is missing the answer is "cannot prove it", which is a no.
namespaces_work() {
  unshare --user true 2>/dev/null
}

case "${STEAM_TOOLS_SANDBOX-}" in
  1) exec "$exe" "$@" ;;
  0) exec "$exe" --no-sandbox "$@" ;;
esac

if helper_is_root_setuid; then
  exec "$exe" "$@"
fi

if namespaces_work; then
  exec "$exe" --disable-setuid-sandbox "$@"
fi

exec "$exe" --no-sandbox "$@"
