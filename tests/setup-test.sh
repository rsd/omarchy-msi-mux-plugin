#!/bin/bash

# setup.sh against temporary trees, a fake sudo and a fake stat; never for
# real. The fake sudo records its arguments and plays the five commands
# setup.sh may run: chown and chmod of the folder mark it as fixed, install
# copies the binary and marks the copy, mv renames the copy over the binary
# and marks it, rm removes a path. MM_SUDO_NOOP=1 makes every command do
# nothing, MM_SUDO_NOOP=<command> just that one. The fake stat (for setup.sh's
# owner-and-mode query only) reports a marked path as root-owned with mode
# 755, a path in the "others" list as owned by uid 4242, a path in the
# "root-real" list (checked first) as root-owned with its real mode, and
# anything else as the real stat does. Every run has PATH starting with the
# fakes and a temporary HOME; a run is refused if `sudo` would resolve
# anywhere else.

set -u

PLUGIN_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SETUP=$PLUGIN_DIR/setup.sh
REAL_STAT=$(command -v stat)
FAILED=0
CHECKS=0

ok() { CHECKS=$((CHECKS + 1)); echo "ok   $*"; }
fail() { CHECKS=$((CHECKS + 1)); FAILED=$((FAILED + 1)); echo "FAIL $*"; }
quote() {
  local line
  while IFS= read -r line; do printf '     | %s\n' "$line"; done <<<"$1"
}

T=$(mktemp -d) || exit 1
trap 'chmod -R u+rwx "$T" 2>/dev/null; rm -rf "$T"' EXIT
FAKE=$T/fakebin
ROOTS=$T/roots       # paths the fake stat reports as root:root 755
OTHERS=$T/others     # paths the fake stat reports as owned by uid 4242
ROOTREAL=$T/rootreal # paths the fake stat reports as root-owned, real mode
SUDO_LOG=$T/sudo.log
mkdir -p "$FAKE" "$T/home"
: >"$ROOTS"
: >"$OTHERS"
: >"$ROOTREAL"

cat >"$FAKE/sudo" <<EOF
#!/bin/bash
printf '%s\n' "\$*" >>"$SUDO_LOG"
[[ \${MM_SUDO_FAIL:-} == 1 ]] && exit 1
[[ \${MM_SUDO_NOOP:-} == 1 || \${MM_SUDO_NOOP:-} == "\$1" ]] && exit 0
mark() { printf '%s\n' "\$1" >>"$ROOTS"; }
if [[ \$1 == chown && \$2 == -h && \$3 == root:root && \$4 == -- && \$# == 5 ]]; then
  mark "\$5"
  # The race setup.sh guards against: the binary swapped for a link while
  # sudo asks for the password.
  if [[ -n \${MM_SUDO_SWAP:-} ]]; then rm -f -- "\$MM_SUDO_SWAP"; ln -s /etc/hostname "\$MM_SUDO_SWAP"; fi
  # The binary made writable by others, or rewritten in place (same file,
  # same mode), at the same moment.
  if [[ -n \${MM_SUDO_CHMOD:-} ]]; then chmod 757 -- "\$MM_SUDO_CHMOD"; fi
  if [[ -n \${MM_SUDO_REWRITE:-} ]]; then printf 'echo changed\\n' >>"\$MM_SUDO_REWRITE"; fi
  exit 0
fi
if [[ \$1 == chmod && \$2 == 755 && \$3 == -- && \$# == 4 ]]; then
  mark "\$4"
  exit 0
fi
if [[ "\$1 \$2 \$3 \$4 \$5 \$6 \$7 \$8" == "install -o root -g root -m 755 --" && \$# == 10 ]]; then
  cp -- "\$9" "\${10}" && mark "\${10}"
  exit
fi
if [[ \$1 == mv && \$2 == -f && \$3 == -- && \$# == 5 ]]; then
  mv -f -- "\$4" "\$5" && mark "\$5"
  exit
fi
if [[ \$1 == rm && \$2 == -f && \$3 == -- && \$# == 4 ]]; then
  rm -f -- "\$4"
  exit
fi
exit 1
EOF

# Called by setup.sh as: stat -c '%u %f %U' -- <path>
cat >"$FAKE/stat" <<EOF
#!/bin/bash
path=\${4:-}
fake=0
[[ \${1:-} == -c && \${2:-} == '%u %f %U' && \${3:-} == -- && \$# == 4 ]] && fake=1
if ((fake)) && grep -qxF -- "\$path" "$ROOTREAL"; then
  raw=\$("$REAL_STAT" -c %f -- "\$path") || exit 1
  printf '0 %s root\n' "\$raw"
  exit 0
fi
if ((fake)) && grep -qxF -- "\$path" "$ROOTS"; then
  raw=\$("$REAL_STAT" -c %f -- "\$path") || exit 1
  printf '0 %x root\n' "\$(( (16#\$raw & 16#F000) | 8#755 ))"
  exit 0
fi
if ((fake)) && grep -qxF -- "\$path" "$OTHERS"; then
  raw=\$("$REAL_STAT" -c %f -- "\$path") || exit 1
  printf '4242 %s someone\n' "\$raw"
  exit 0
fi
exec "$REAL_STAT" "\$@"
EOF
chmod 755 "$FAKE/sudo" "$FAKE/stat"

# run_setup <stdin text> <args...>: setup.sh's output in OUT, status in STATUS.
OUT=""
STATUS=0
run_setup() {
  local input=$1
  shift
  if [[ $(PATH="$FAKE:$PATH" command -v sudo) != "$FAKE/sudo" ]]; then
    echo "refusing to run: sudo does not resolve to the fake"
    exit 1
  fi
  : >"$SUDO_LOG"
  OUT=$(printf '%b' "$input" | env PATH="$FAKE:$PATH" HOME="$T/home" bash "$SETUP" "$@" 2>&1)
  STATUS=$?
}

expect() {
  local name=$1 status=$2 pattern=$3
  if [[ $STATUS -eq $status ]] && grep -qF -- "$pattern" <<<"$OUT"; then
    ok "$name"
  else
    fail "$name (status $STATUS, want $status; want output containing: $pattern)"
    quote "$OUT"
  fi
}

no_sudo() {
  if [[ -s $SUDO_LOG ]]; then
    fail "$1: sudo was called: $(tr '\n' '|' <"$SUDO_LOG")"
  else
    ok "$1: sudo was not called"
  fi
}

# A tree whose only problem is the binary's own folder and the binary:
# everything above <base>/opt/msi-mux-switch is marked root-owned.
make_tree() {
  local base=$1
  mkdir -p "$base/opt/msi-mux-switch"
  printf '#!/bin/sh\nexit 0\n' >"$base/opt/msi-mux-switch/msi-mux-switch"
  chmod 755 "$base/opt/msi-mux-switch/msi-mux-switch"
  local p=$base/opt
  while [[ $p != / ]]; do
    printf '%s\n' "$p" >>"$ROOTS"
    p=${p%/*}
    [[ -z $p ]] && p=/
  done
}

BIN=$T/a/opt/msi-mux-switch/msi-mux-switch
DIR=$T/a/opt/msi-mux-switch
make_tree "$T/a"

# --- refusals that change nothing

run_setup "" "relative/msi-mux-switch"
expect "a relative path is refused" 1 "The path must be absolute."
no_sudo "relative path"

run_setup "" "$T/a/opt/../opt/msi-mux-switch/msi-mux-switch"
expect "a path with .. is refused" 1 'must not contain ".."'

run_setup "" "$T/a/opt/msi-mux-switch/missing"
expect "a missing binary: not found, with the README hint" 1 "msi-mux-switch was not found at $T/a/opt/msi-mux-switch/missing."
if grep -qF "README" <<<"$OUT"; then ok "the not-found message points to the README"; else fail "no README hint"; fi
no_sudo "missing binary"

# Links and directories live in a tree of their own: the accepted run below
# needs a folder holding the binary alone.
make_tree "$T/l"
ln -s "$T/l/opt/msi-mux-switch/msi-mux-switch" "$T/l/opt/msi-mux-switch/link"
run_setup "y\n" "$T/l/opt/msi-mux-switch/link"
expect "a symbolic link is refused" 1 "is a symbolic link"
no_sudo "symlink"

mkdir -p "$T/l/opt/msi-mux-switch/adir"
run_setup "y\n" "$T/l/opt/msi-mux-switch/adir"
expect "a directory is refused" 1 "is not a regular file."

# User-controllable mounts, refused on the path alone.
for m in /mnt /media /run/media /run/user; do
  run_setup "y\n" "$m/x/msi-mux-switch"
  expect "a binary under $m is refused" 1 "is under $m, where a user can mount"
  no_sudo "under $m"
done

# The parent is the (temporary) home.
printf 'x\n' >"$T/home/msi-mux-switch"
run_setup "y\n" "$T/home/msi-mux-switch"
expect "a binary directly in \$HOME is refused" 1 "Refusing to change $T/home"
no_sudo "binary in home"

# The parent is directly under / (a file in /tmp itself).
TOPFILE=$(mktemp -p /tmp msi-mux-test.XXXXXX) || exit 1
run_setup "y\n" "$TOPFILE"
rm -f "$TOPFILE"
expect "a binary whose folder is directly under / is refused" 1 "Refusing to change /tmp"
no_sudo "folder under /"

# /dev/shm: its folder is directly under /dev, so the same rule refuses it
# (one temporary file of ours, removed after).
if SHMFILE=$(mktemp -p /dev/shm msi-mux-test.XXXXXX 2>/dev/null); then
  run_setup "y\n" "$SHMFILE"
  rm -f "$SHMFILE"
  expect "a binary in /dev/shm is refused" 1 "Refusing to change /dev/shm"
  no_sudo "/dev/shm"
else
  echo "skip the /dev/shm case (no /dev/shm to write here)"
fi

# The parent is directly under /home: a file already in the real home
# (only stat'ed; HOME is the temporary one, so the /home rule is what fires).
REAL_HOME_FILE=""
real_home=$(getent passwd "$(id -u)" | cut -d: -f6)
if [[ $real_home == /home/* && ${real_home#/home/} != */* ]]; then
  for f in "$real_home"/.bashrc "$real_home"/.profile "$real_home"/.bash_profile; do
    [[ -f $f && ! -L $f ]] && { REAL_HOME_FILE=$f; break; }
  done
fi
if [[ -n $REAL_HOME_FILE ]]; then
  run_setup "y\n" "$REAL_HOME_FILE"
  expect "a binary whose folder is directly under /home is refused" 1 "Refusing to change $real_home"
  no_sudo "folder under /home"
else
  echo "skip a binary directly under /home/<user> (no plain dotfile found there to stat)"
fi

# A real shared folder: /var/tmp is root-owned with the sticky bit. Only
# stat'ed and listed, plus one temporary file of ours, removed after.
if [[ $("$REAL_STAT" -c '%u %a' -- /var/tmp /var / 2>/dev/null | tr '\n' ' ') =~ ^0\ 1777\ 0\ 755\ 0\ (755|555)\ $ ]] &&
  VARFILE=$(mktemp -p /var/tmp msi-mux-test.XXXXXX); then
  run_setup "y\n" "$VARFILE"
  rm -f "$VARFILE"
  expect "a binary in /var/tmp is refused: sticky bit" 1 "/var/tmp has the sticky bit"
  no_sudo "/var/tmp"
else
  echo "skip the /var/tmp case (/var/tmp is not root 1777 under root 755 folders here)"
fi

# The binary's own folder, unfit to change: sticky, writable by group or
# others, holding other files (also a dotfile), owned by another user.
make_tree "$T/s"
chmod 1755 "$T/s/opt/msi-mux-switch"
run_setup "y\n" "$T/s/opt/msi-mux-switch/msi-mux-switch"
expect "a sticky folder of the user's is refused" 1 "$T/s/opt/msi-mux-switch has the sticky bit"
no_sudo "sticky folder"

make_tree "$T/w"
chmod 757 "$T/w/opt/msi-mux-switch"
run_setup "y\n" "$T/w/opt/msi-mux-switch/msi-mux-switch"
expect "an other-writable folder is refused" 1 "$T/w/opt/msi-mux-switch is writable by group or others."
no_sudo "other-writable folder"
chmod 775 "$T/w/opt/msi-mux-switch"
run_setup "y\n" "$T/w/opt/msi-mux-switch/msi-mux-switch"
expect "a group-writable folder is refused" 1 "$T/w/opt/msi-mux-switch is writable by group or others."
no_sudo "group-writable folder"

make_tree "$T/e"
printf 'x\n' >"$T/e/opt/msi-mux-switch/notes.txt"
run_setup "y\n" "$T/e/opt/msi-mux-switch/msi-mux-switch"
expect "a folder holding another file is refused" 1 "holds other files besides msi-mux-switch"
no_sudo "extra file"
rm -f "$T/e/opt/msi-mux-switch/notes.txt"
printf 'x\n' >"$T/e/opt/msi-mux-switch/.hidden"
run_setup "y\n" "$T/e/opt/msi-mux-switch/msi-mux-switch"
expect "a folder holding a dotfile is refused" 1 "holds other files besides msi-mux-switch"
no_sudo "dotfile"

make_tree "$T/o"
printf '%s\n' "$T/o/opt/msi-mux-switch" >>"$OTHERS"
run_setup "y\n" "$T/o/opt/msi-mux-switch/msi-mux-switch"
expect "a folder owned by another user is refused" 1 "$T/o/opt/msi-mux-switch is owned by someone, not by you or root."
no_sudo "other user's folder"

# A directory further up fails: an unmarked tree.
mkdir -p "$T/b/x/opt/msi-mux-switch"
printf 'x\n' >"$T/b/x/opt/msi-mux-switch/msi-mux-switch"
run_setup "y\n" "$T/b/x/opt/msi-mux-switch/msi-mux-switch"
expect "a failing directory further up is refused" 1 "A directory above $T/b/x/opt/msi-mux-switch fails the check:"
if grep -qF "$T/b/x/opt is owned by" <<<"$OUT"; then ok "the failing ancestor is named"; else fail "the failing ancestor is not named"; fi
no_sudo "further ancestor"

# A directory further up owned by root but writable by others.
make_tree "$T/g"
chmod 757 "$T/g/opt"
printf '%s\n' "$T/g/opt" >>"$ROOTREAL"
run_setup "y\n" "$T/g/opt/msi-mux-switch/msi-mux-switch"
expect "a root-owned but other-writable directory further up is refused" 1 "$T/g/opt is writable by group or others."
if grep -qF "A directory above $T/g/opt/msi-mux-switch fails the check:" <<<"$OUT"; then ok "it is reported as a directory above"; else fail "not reported as a directory above"; fi
no_sudo "other-writable ancestor"

# --- the binary itself: another user's, or writable by group or others

make_tree "$T/ob"
printf '%s\n' "$T/ob/opt/msi-mux-switch/msi-mux-switch" >>"$OTHERS"
run_setup "y\n" "$T/ob/opt/msi-mux-switch/msi-mux-switch"
expect "a binary owned by another user is refused" 1 "Refusing to install $T/ob/opt/msi-mux-switch/msi-mux-switch:"
if grep -qF "  $T/ob/opt/msi-mux-switch/msi-mux-switch is owned by someone, not by you or root." <<<"$OUT"; then ok "the other owner is named"; else fail "the other owner is not named"; quote "$OUT"; fi
if grep -qF "Nothing was changed." <<<"$OUT"; then ok "another user's binary: nothing was changed"; else fail "no 'Nothing was changed.'"; fi
no_sudo "other user's binary"

make_tree "$T/ow"
chmod 757 "$T/ow/opt/msi-mux-switch/msi-mux-switch"
run_setup "y\n" "$T/ow/opt/msi-mux-switch/msi-mux-switch"
expect "an other-writable binary is refused" 1 "Refusing to install $T/ow/opt/msi-mux-switch/msi-mux-switch:"
if grep -qF "  $T/ow/opt/msi-mux-switch/msi-mux-switch is writable by group or others." <<<"$OUT"; then ok "the writable binary is named"; else fail "the writable binary is not named"; quote "$OUT"; fi
# A file others could write may hold their content (or still be written
# through a descriptor they opened earlier): the hint is a fresh copy, never
# chmod.
if grep -qF "Rebuild or re-download msi-mux-switch into a folder only you can write" <<<"$OUT" && ! grep -q "chmod" <<<"$OUT"; then
  ok "the writable binary's hint is a fresh copy, not chmod"
else
  fail "the writable binary's hint is not a fresh copy (or suggests chmod)"; quote "$OUT"
fi
no_sudo "other-writable binary"
chmod 775 "$T/ow/opt/msi-mux-switch/msi-mux-switch"
run_setup "y\n" "$T/ow/opt/msi-mux-switch/msi-mux-switch"
expect "a group-writable binary is refused" 1 "Refusing to install $T/ow/opt/msi-mux-switch/msi-mux-switch:"
no_sudo "group-writable binary"

# --- the commands, declined and accepted

run_setup "n\n" "$BIN"
expect "declining runs nothing" 1 "Cancelled."
no_sudo "declined"
want_shown=$(printf '  %s\n' "sudo chown -h root:root -- $DIR" "sudo chmod 755 -- $DIR" \
  "sudo install -o root -g root -m 755 -- $BIN $DIR/.msi-mux-switch.new" "sudo mv -f -- $DIR/.msi-mux-switch.new $BIN")
if [[ $(grep '^  sudo ' <<<"$OUT") == "$want_shown" ]]; then
  ok "the exact four commands are shown before asking, folder first"
else
  fail "the commands shown:"
  quote "$OUT"
fi
if grep -qF "is owned by $(id -un), not root." <<<"$OUT"; then ok "the problem is named (owned by $(id -un), not root)"; else fail "the problem is not named"; fi

run_setup "" "$BIN"
expect "no answer (end of input) runs nothing" 1 "Cancelled."
no_sudo "end of input"

MM_SUDO_FAIL=1 run_setup "y\n" "$BIN"
expect "a failing sudo is reported" 1 "A command failed"
if [[ $(cat "$SUDO_LOG") == "chown -h root:root -- $DIR" ]]; then ok "a failing first command stops the rest"; else fail "sudo ran: $(tr '\n' '|' <"$SUDO_LOG")"; fi

MM_SUDO_NOOP=1 run_setup "y\n" "$BIN"
expect "sudo that makes no copy: nothing is moved" 1 "The copy $DIR/.msi-mux-switch.new cannot be checked"
if grep -q '^mv ' "$SUDO_LOG"; then fail "mv ran without a checked copy"; else ok "no mv without a checked copy"; fi

MM_SUDO_NOOP="mv" run_setup "y\n" "$BIN"
expect "an mv that changes nothing: the final check says so" 1 "Still not safe:"
if grep -qF "  $BIN is owned by $(id -un), not root." <<<"$(sed -n '/Still not safe:/,$p' <<<"$OUT")"; then ok "the final check names the binary"; else fail "the final check does not name the binary"; quote "$OUT"; fi
rm -f -- "$DIR/.msi-mux-switch.new"

# The binary swapped for a link between the check and sudo: the folder is
# fixed, the binary is not touched (no install, no mv).
make_tree "$T/r"
MM_SUDO_SWAP=$T/r/opt/msi-mux-switch/msi-mux-switch run_setup "y\n" "$T/r/opt/msi-mux-switch/msi-mux-switch"
expect "a binary swapped during sudo: stops after the folder" 1 "is no longer a regular file."
if [[ $(cat "$SUDO_LOG") == "$(printf '%s\n%s' "chown -h root:root -- $T/r/opt/msi-mux-switch" "chmod 755 -- $T/r/opt/msi-mux-switch")" ]]; then
  ok "only the folder's two commands ran"
else
  fail "sudo ran: $(tr '\n' '|' <"$SUDO_LOG")"
fi

# The binary rewritten in place between the check and the copy: the staged
# copy does not match the checksum, so it is removed and nothing is moved.
make_tree "$T/c"
CBIN=$T/c/opt/msi-mux-switch/msi-mux-switch
CDIR=$T/c/opt/msi-mux-switch
MM_SUDO_REWRITE=$CBIN run_setup "y\n" "$CBIN"
expect "a binary changed after the check: refused" 1 "$CBIN changed after it was checked"
if grep -qF "  sudo rm -f -- $CDIR/.msi-mux-switch.new" <<<"$OUT"; then ok "the removal of the copy is shown"; else fail "the removal is not shown"; quote "$OUT"; fi
want_log=$(printf '%s\n' "chown -h root:root -- $CDIR" "chmod 755 -- $CDIR" \
  "install -o root -g root -m 755 -- $CBIN $CDIR/.msi-mux-switch.new" "rm -f -- $CDIR/.msi-mux-switch.new")
if [[ $(cat "$SUDO_LOG") == "$want_log" ]]; then
  ok "changed binary: the copy is removed, no mv"
else
  fail "sudo ran: $(tr '\n' '|' <"$SUDO_LOG")"
fi
if [[ ! -e $CDIR/.msi-mux-switch.new ]]; then ok "no staged copy is left"; else fail "the staged copy is left"; fi

# The binary made other-writable during sudo: the recheck stops before the copy.
make_tree "$T/m"
MBIN=$T/m/opt/msi-mux-switch/msi-mux-switch
MM_SUDO_CHMOD=$MBIN run_setup "y\n" "$MBIN"
expect "a binary made writable during sudo: stops after the folder" 1 "$MBIN is writable by group or others."
if [[ $(wc -l <"$SUDO_LOG") == 2 ]]; then ok "only the folder's two commands ran"; else fail "sudo ran: $(tr '\n' '|' <"$SUDO_LOG")"; fi

ino_before=$("$REAL_STAT" -c %i -- "$BIN")
run_setup "y\n" "$BIN"
expect "accepted: the commands run and the re-check passes" 0 "Done: $BIN and $DIR are owned by root with mode 755."
want_log=$(printf '%s\n' "chown -h root:root -- $DIR" "chmod 755 -- $DIR" \
  "install -o root -g root -m 755 -- $BIN $DIR/.msi-mux-switch.new" "mv -f -- $DIR/.msi-mux-switch.new $BIN")
if [[ $(cat "$SUDO_LOG") == "$want_log" ]]; then
  ok "sudo ran exactly the four commands, in order"
else
  fail "sudo ran: $(tr '\n' '|' <"$SUDO_LOG")"
fi
left=$(find "$DIR" -mindepth 1 -printf '%f ')
if [[ $("$REAL_STAT" -c %i -- "$BIN") != "$ino_before" && $left == "msi-mux-switch " ]]; then
  ok "the binary is a fresh copy; nothing else is left in the folder"
else
  fail "the binary was changed in place, or the folder holds: $left"
fi
if grep -qE '^(chown|chmod) .*'"$BIN"'$' "$SUDO_LOG"; then fail "the binary was chowned or chmodded in place"; else ok "the binary is never chowned or chmodded in place"; fi

run_setup "y\n" "$BIN"
expect "once fixed, it has nothing to do" 0 "Already set up"
no_sudo "already set up"

# A real root-owned binary: nothing to do, nothing run (the fake stat passes
# unmarked paths to the real stat).
if [[ $("$REAL_STAT" -c '%u %a' -- /usr/bin/ls /usr/bin /usr / 2>/dev/null | tr '\n' ' ') =~ ^0\ 755\ 0\ 755\ 0\ 755\ 0\ (755|555)\ $ ]]; then
  run_setup "y\n" /usr/bin/ls
  expect "a binary root owns already: nothing to do" 0 "Nothing to do."
  no_sudo "root-owned"
else
  echo "skip the root-owned case (/usr/bin/ls and its folders are not all root 755 here)"
fi

echo "$((CHECKS - FAILED))/$CHECKS passed"
((FAILED == 0))
