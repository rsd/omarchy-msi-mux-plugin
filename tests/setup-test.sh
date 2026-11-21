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
# anything else as the real stat does. The fake cat (for setup.sh's read of
# /proc/self/mountinfo only) serves the file MM_MOUNTINFO names, fails when
# it is "unreadable", and serves a plain ext4 root when it is unset; on chown
# (MM_SUDO_MOUNTINFO) or mv (MM_SUDO_MV_MOUNTINFO) the fake sudo copies the
# file named there over MM_MOUNTINFO, a mount appearing mid-run. On its
# MM_CAT_FLIP_AT-th read of mountinfo (1: the first check, 2: the re-check, 3:
# the final check) the fake cat adds the path MM_CAT_FLIP names to the
# "flipped" list, which the fake stat (checking it before any other) reports
# as owned by uid 4242: the stat after the mount check then differs from the
# one before, as when a FUSE mount forges a stat and unmounts lazily. The fake
# head (for setup.sh's read of /etc/fuse.conf only) and the fake stat's
# existence probe of that file both look at the file MM_FUSE_CONF names
# instead (the fixture fuse-conf-off when it is unset), so a missing, a
# chmod-000, a directory or a symbolic link MM_FUSE_CONF is the real case. Every run
# has PATH starting with the fakes and a temporary HOME; a run is refused if
# `sudo` would resolve anywhere else.

set -u

PLUGIN_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SETUP=$PLUGIN_DIR/setup.sh
REAL_STAT=$(command -v stat)
REAL_CAT=$(command -v cat)
REAL_HEAD=$(command -v head)
FIXTURES=$PLUGIN_DIR/tests/fixtures
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
FLIPPED=$T/flipped   # paths the fake stat reports as uid 4242, before the rest
CAT_READS=$T/catreads
SUDO_LOG=$T/sudo.log
PLAIN_MI=$T/mountinfo-plain
mkdir -p "$FAKE" "$T/home"
printf '%s\n' '22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw' >"$PLAIN_MI"
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
  if [[ -n \${MM_SUDO_MOUNTINFO:-} ]]; then cp -- "\$MM_SUDO_MOUNTINFO" "\$MM_MOUNTINFO"; fi
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
  mv -f -- "\$4" "\$5" && mark "\$5" || exit
  if [[ -n \${MM_SUDO_MV_MOUNTINFO:-} ]]; then cp -- "\$MM_SUDO_MV_MOUNTINFO" "\$MM_MOUNTINFO"; fi
  exit 0
fi
if [[ \$1 == rm && \$2 == -f && \$3 == -- && \$# == 4 ]]; then
  rm -f -- "\$4"
  exit
fi
exit 1
EOF

# Called by setup.sh as: stat -c '%u %f %U' -- <path>, and as
# stat -c %i -- /etc/fuse.conf (served from MM_FUSE_CONF)
cat >"$FAKE/stat" <<EOF
#!/bin/bash
if [[ \$# == 4 && \$1 == -c && \$2 == %i && \$3 == -- && \$4 == /etc/fuse.conf ]]; then
  exec "$REAL_STAT" -c %i -- "\${MM_FUSE_CONF:-$FIXTURES/fuse-conf-off}"
fi
path=\${4:-}
fake=0
[[ \${1:-} == -c && \${2:-} == '%u %f %U' && \${3:-} == -- && \$# == 4 ]] && fake=1
if ((fake)) && grep -qxF -- "\$path" "$FLIPPED"; then
  raw=\$("$REAL_STAT" -c %f -- "\$path") || exit 1
  printf '4242 %s someone\n' "\$raw"
  exit 0
fi
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
# Called by setup.sh as: cat -- /proc/self/mountinfo
cat >"$FAKE/cat" <<EOF
#!/bin/bash
if [[ \$# == 2 && \$1 == -- && \$2 == /proc/self/mountinfo ]]; then
  printf 'x\n' >>"$CAT_READS"
  if [[ -n \${MM_CAT_FLIP:-} && \$(wc -l <"$CAT_READS") == "\${MM_CAT_FLIP_AT:-1}" ]]; then
    printf '%s\n' "\$MM_CAT_FLIP" >>"$FLIPPED"
  fi
  # The forged root view of MM_CAT_UNROOT gone after the first read.
  if [[ -n \${MM_CAT_UNROOT:-} && \$(wc -l <"$CAT_READS") == 1 ]]; then
    grep -vxF -- "\$MM_CAT_UNROOT" "$ROOTS" >"$ROOTS.new"
    "$REAL_CAT" -- "$ROOTS.new" >"$ROOTS"
  fi
  case \${MM_MOUNTINFO:-} in
    unreadable) exit 1 ;;
    "") exec "$REAL_CAT" -- "$PLAIN_MI" ;;
    *) exec "$REAL_CAT" -- "\$MM_MOUNTINFO" ;;
  esac
fi
exec "$REAL_CAT" "\$@"
EOF
# Called by setup.sh as: head -c <bytes> -- /etc/fuse.conf
cat >"$FAKE/head" <<EOF
#!/bin/bash
if [[ \$# == 4 && \$1 == -c && \$3 == -- && \$4 == /etc/fuse.conf ]]; then
  exec "$REAL_HEAD" -c "\$2" -- "\${MM_FUSE_CONF:-$FIXTURES/fuse-conf-off}"
fi
exec "$REAL_HEAD" "\$@"
EOF
chmod 755 "$FAKE/sudo" "$FAKE/stat" "$FAKE/cat" "$FAKE/head"

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
  : >"$FLIPPED"
  : >"$CAT_READS"
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

# fresh_copy_hint <name> <marker>: from the line holding <marker> on, the
# advice is a fresh build in a folder only you can write, and never a chmod,
# chown, fix by hand or retry on the same file: a binary another account could
# have changed may already hold its content.
REBUILD="Rebuild or re-download msi-mux-switch into a folder only you can write"
fresh_copy_hint() {
  local name=$1 rest
  rest=$(sed -n "/$(printf '%s' "$2" | sed 's/[][\/.*^$]/\\&/g')/,\$p" <<<"$OUT")
  if [[ -n $rest ]] && grep -qF -- "$REBUILD" <<<"$rest" && grep -qF -- "then run setup again" <<<"$rest" &&
    ! grep -qiE 'chmod|chown|by hand|run this again|move msi-mux-switch somewhere|Check .* and run' <<<"$rest"; then
    ok "$name: the hint is a fresh copy, not a fix in place or a retry"
  else
    fail "$name: the hint is not a fresh copy (or suggests a fix in place or a retry)"
    quote "$OUT"
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
fresh_copy_hint "sticky folder" "Refusing to change"
no_sudo "sticky folder"

make_tree "$T/w"
chmod 757 "$T/w/opt/msi-mux-switch"
run_setup "y\n" "$T/w/opt/msi-mux-switch/msi-mux-switch"
expect "an other-writable folder is refused" 1 "$T/w/opt/msi-mux-switch is writable by group or others."
fresh_copy_hint "other-writable folder" "Refusing to change"
no_sudo "other-writable folder"
chmod 775 "$T/w/opt/msi-mux-switch"
run_setup "y\n" "$T/w/opt/msi-mux-switch/msi-mux-switch"
expect "a group-writable folder is refused" 1 "$T/w/opt/msi-mux-switch is writable by group or others."
no_sudo "group-writable folder"

make_tree "$T/e"
printf 'x\n' >"$T/e/opt/msi-mux-switch/notes.txt"
run_setup "y\n" "$T/e/opt/msi-mux-switch/msi-mux-switch"
expect "a folder holding another file is refused" 1 "holds other files besides msi-mux-switch"
# Not a sign of tampering: the hint is still to give it a folder of its own.
if grep -qF "Put msi-mux-switch alone in a folder of its own" <<<"$OUT"; then ok "extra file: the hint is a folder of its own"; else fail "extra file: no folder-of-its-own hint"; quote "$OUT"; fi
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
fresh_copy_hint "other user's folder" "Refusing to change"
no_sudo "other user's folder"

# A directory further up fails: an unmarked tree.
mkdir -p "$T/b/x/opt/msi-mux-switch"
printf 'x\n' >"$T/b/x/opt/msi-mux-switch/msi-mux-switch"
run_setup "y\n" "$T/b/x/opt/msi-mux-switch/msi-mux-switch"
expect "a failing directory further up is refused" 1 "A directory above $T/b/x/opt/msi-mux-switch fails the check:"
if grep -qF "$T/b/x/opt is owned by" <<<"$OUT"; then ok "the failing ancestor is named"; else fail "the failing ancestor is not named"; fi
fresh_copy_hint "failing ancestor" "fails the check:"
no_sudo "further ancestor"

# A directory further up owned by root but writable by others.
make_tree "$T/g"
chmod 757 "$T/g/opt"
printf '%s\n' "$T/g/opt" >>"$ROOTREAL"
run_setup "y\n" "$T/g/opt/msi-mux-switch/msi-mux-switch"
expect "a root-owned but other-writable directory further up is refused" 1 "$T/g/opt is writable by group or others."
if grep -qF "A directory above $T/g/opt/msi-mux-switch fails the check:" <<<"$OUT"; then ok "it is reported as a directory above"; else fail "not reported as a directory above"; fi
fresh_copy_hint "other-writable ancestor" "fails the check:"
no_sudo "other-writable ancestor"

# --- the binary itself: another user's, or writable by group or others

make_tree "$T/ob"
printf '%s\n' "$T/ob/opt/msi-mux-switch/msi-mux-switch" >>"$OTHERS"
run_setup "y\n" "$T/ob/opt/msi-mux-switch/msi-mux-switch"
expect "a binary owned by another user is refused" 1 "Refusing to install $T/ob/opt/msi-mux-switch/msi-mux-switch:"
if grep -qF "  $T/ob/opt/msi-mux-switch/msi-mux-switch is owned by someone, not by you or root." <<<"$OUT"; then ok "the other owner is named"; else fail "the other owner is not named"; quote "$OUT"; fi
if grep -qF "Nothing was changed." <<<"$OUT"; then ok "another user's binary: nothing was changed"; else fail "no 'Nothing was changed.'"; fi
fresh_copy_hint "other user's binary" "Refusing to install"
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
fresh_copy_hint "other-writable binary" "Refusing to install"
no_sudo "other-writable binary"
chmod 775 "$T/ow/opt/msi-mux-switch/msi-mux-switch"
run_setup "y\n" "$T/ow/opt/msi-mux-switch/msi-mux-switch"
expect "a group-writable binary is refused" 1 "Refusing to install $T/ow/opt/msi-mux-switch/msi-mux-switch:"
no_sudo "group-writable binary"

# --- mounts another account may control (FUSE, user_id=), from mountinfo

# mi_esc <path>: the path as mountinfo writes it (space, tab, newline and
# backslash as octal escapes).
mi_esc() {
  local s=${1//\\/\\134}
  s=${s// /\\040}
  s=${s//$'\t'/\\011}
  s=${s//$'\n'/\\012}
  printf '%s' "$s"
}
MI=$T/mountinfo
MI_ROOT='22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw'
# mi <lines...>: the plain root, then the given lines, as $MI.
mi() { printf '%s\n' "$MI_ROOT" "$@" >"$MI"; }
# mi_refused <name> <pattern>: $BIN refused on its mounts, nothing run.
mi_refused() {
  MM_MOUNTINFO=$MI run_setup "y\n" "$BIN"
  expect "$1" 1 "$2"
  fresh_copy_hint "$1" "$2"
  no_sudo "$1"
}
# mi_passes <name>: the mount check passes (the run goes on to ask).
mi_passes() {
  MM_MOUNTINFO=$MI run_setup "n\n" "$BIN"
  expect "$1" 1 "Cancelled."
  no_sudo "$1"
}

mi
mi_passes "a plain ext4 root passes"
printf '%s\n' '22 1 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw' \
  "30 22 0:26 / $(mi_esc "$T") rw shared:2 master:7 propagate_from:1 - tmpfs tmpfs rw,size=8g" >"$MI"
mi_passes "no optional fields, or three, both parse"

mi "40 22 0:50 / $(mi_esc "$T/a") rw,nosuid,nodev,relatime shared:9 - fuse.sshfs me@host:/srv rw,user_id=1000,group_id=1000"
mi_refused "fuse.sshfs at an ancestor is refused" "is on a FUSE mount at $(mi_esc "$T/a") (fuse.sshfs)"
mi "40 22 8:17 / $(mi_esc "$DIR") rw,relatime - fuseblk /dev/sdb1 rw,user_id=0,group_id=0,allow_other"
mi_refused "fuseblk at the binary's own folder is refused" "is on a FUSE mount at $(mi_esc "$DIR") (fuseblk)"
mi "40 22 0:51 / $(mi_esc "$BIN") rw - fuse /dev/fuse rw,user_id=0,group_id=0"
mi_refused "fuse over the binary itself is refused, even with user_id=0" "is on a FUSE mount at $(mi_esc "$BIN") (fuse)"
mi "40 22 0:52 / $(mi_esc "$T") rw,relatime - tmpfs tmpfs rw,user_id=1000"
mi_refused "a non-FUSE mount with user_id=1000 is refused" "is on a user mount at $(mi_esc "$T") (user_id=1000)"
mi "40 22 0:52 / $(mi_esc "$T") rw,relatime,user_id=1000 - tmpfs tmpfs rw"
mi_refused "user_id=1000 in the mount options is refused" "is on a user mount at $(mi_esc "$T") (user_id=1000)"
mi "40 22 0:52 / $(mi_esc "$T") rw,relatime - tmpfs tmpfs rw,user_id=0"
mi_passes "a non-FUSE mount with user_id=0 passes"
# Mounted at the same point later, below a plain one: still refused.
mi "40 22 0:50 / $(mi_esc "$T/a") rw - fuse.sshfs x rw" "41 40 0:53 / $(mi_esc "$T/a") rw - ext4 /dev/sdc1 rw"
mi_refused "a FUSE mount hidden under a later mount at the same point is refused" "is on a FUSE mount"
mi "40 22 0:50 / $(mi_esc "$T/a")/opt/msi-mux-switchX rw - fuse.sshfs x rw" \
  "41 22 0:54 / $(mi_esc "$T/a")/op rw - fuse.sshfs x rw"
mi_passes "a FUSE mount at a sibling with the same prefix passes"
# A source of "-" and an empty one do not shift the fields.
mi "40 22 0:55 / $(mi_esc "$T/q") rw - tmpfs - rw" "41 22 0:56 / $(mi_esc "$T/q2") rw - tmpfs  rw"
mi_passes "a source of '-' or an empty source parses"

# A folder with a space in its name: \040 in mountinfo.
make_tree "$T/sp ace"
SPBIN="$T/sp ace/opt/msi-mux-switch/msi-mux-switch"
mi "40 22 0:50 / $(mi_esc "$T/sp ace") rw - fuse.sshfs x rw"
if [[ $(mi_esc "$T/sp ace") == *'\040'* ]]; then ok "the fixture escapes the space as \\040"; else fail "the fixture does not escape the space"; fi
MM_MOUNTINFO=$MI run_setup "y\n" "$SPBIN"
expect "a FUSE mount whose name holds \\040 and covers the binary is refused" 1 "is on a FUSE mount at $(mi_esc "$T/sp ace")"
no_sudo "\\040 mount covering"
mi "40 22 0:50 / $(mi_esc "$T/sp ace2") rw - fuse.sshfs x rw" "41 22 0:50 / $(mi_esc "$T/sp")\\134040ace rw - fuse.sshfs x rw"
MM_MOUNTINFO=$MI run_setup "n\n" "$SPBIN"
expect "a FUSE mount whose name holds \\040 and does not cover the binary passes" 1 "Cancelled."
no_sudo "\\040 mount not covering"

# user_id= is decimal digits worth 0 to pass; empty or not digits refuses.
mi "40 22 0:52 / $(mi_esc "$T") rw - tmpfs tmpfs rw,user_id=00"
mi_passes "user_id=00 passes"
mi "40 22 0:52 / $(mi_esc "$T") rw - tmpfs tmpfs rw,user_id="
mi_refused "an empty user_id= is refused" "is on a user mount at $(mi_esc "$T") (user_id=)"
mi "40 22 0:52 / $(mi_esc "$T") rw - tmpfs tmpfs rw,user_id=0x"
mi_refused "user_id=0x is refused" "is on a user mount at $(mi_esc "$T") (user_id=0x)"
mi "40 22 0:52 / $(mi_esc "$T") rw - tmpfs tmpfs rw,user_id=-0"
mi_refused "user_id=-0 is refused" "(user_id=-0)"

# Escapes: a backslash and three octal digits decode, anything else is
# unparseable.
mi "40 22 0:52 / $(mi_esc "$T/q")\\400 rw - fuse.sshfs x rw"
mi_passes "an escape of three octal digits above 377 decodes"
for bad in '\08x' '\x41' '\12' "\\"; do
  mi "40 22 0:52 / $(mi_esc "$T/q")$bad rw - tmpfs tmpfs rw"
  MM_MOUNTINFO=$MI run_setup "y\n" "$BIN"
  expect "a mount point ending in $bad is unparseable" 1 "$BIN could not be checked: /proc/self/mountinfo could not be parsed."
  no_sudo "bad escape $bad"
done

# The numeric fields: mount id, parent id, maj:min.
for bad in "x 22 0:52" "4a 22 0:52" "40 x 0:52" "40 22 052" "40 22 0:5a" "40 22 :52" "40 22 0:" "-1 22 0:52"; do
  mi "$bad / $(mi_esc "$T/z") rw - tmpfs tmpfs rw"
  MM_MOUNTINFO=$MI run_setup "y\n" "$BIN"
  expect "numeric fields '$bad' are unparseable" 1 "$BIN could not be checked: /proc/self/mountinfo could not be parsed."
  no_sudo "numeric fields '$bad'"
done

# Fail safe: what cannot be read or parsed refuses.
MM_MOUNTINFO=unreadable run_setup "y\n" "$BIN"
expect "an unreadable mountinfo is refused" 1 "$BIN could not be checked: /proc/self/mountinfo could not be read."
no_sudo "unreadable mountinfo"
: >"$MI"
MM_MOUNTINFO=$MI run_setup "y\n" "$BIN"
expect "an empty mountinfo is refused" 1 "$BIN could not be checked: /proc/self/mountinfo could not be parsed."
no_sudo "empty mountinfo"
mi "40 22 0:52 / $(mi_esc "$T/z") rw shared:3 tmpfs tmpfs rw"
MM_MOUNTINFO=$MI run_setup "y\n" "$BIN"
expect "a line without the - separator is refused" 1 "$BIN could not be checked: /proc/self/mountinfo could not be parsed."
no_sudo "no separator"
mi "40 22 0:52 / $(mi_esc "$T/z") rw - tmpfs"
MM_MOUNTINFO=$MI run_setup "y\n" "$BIN"
expect "a line with too few fields after - is refused" 1 "$BIN could not be checked: /proc/self/mountinfo could not be parsed."
no_sudo "too few fields after -"
mi "40 22 0:52 / - tmpfs tmpfs rw"
MM_MOUNTINFO=$MI run_setup "y\n" "$BIN"
expect "a line with too few fields before - is refused" 1 "$BIN could not be checked: /proc/self/mountinfo could not be parsed."
no_sudo "too few fields before -"
mi "" "40 22 0:52 / $(mi_esc "$T/z") rw - tmpfs tmpfs rw"
MM_MOUNTINFO=$MI run_setup "y\n" "$BIN"
expect "an empty line inside is refused" 1 "$BIN could not be checked: /proc/self/mountinfo could not be parsed."
no_sudo "empty line"
printf '%s\n' "30 1 259:1 / /boot rw - vfat /dev/nvme0n1p1 rw" >"$MI"
MM_MOUNTINFO=$MI run_setup "y\n" "$BIN"
expect "no entry for / is refused" 1 "$BIN could not be checked: /proc/self/mountinfo has no entry for /."
no_sudo "no / entry"
if grep -qF "Refusing" <<<"$OUT" && ! grep -qF "Rebuild" <<<"$OUT"; then ok "a mountinfo that cannot be checked does not blame the binary"; else fail "unexpected hint for an unchecked mountinfo"; quote "$OUT"; fi

# A FUSE mount appearing over the folder while sudo runs: the re-check after
# the folder stops before the copy.
make_tree "$T/fm"
FMBIN=$T/fm/opt/msi-mux-switch/msi-mux-switch
mi
printf '%s\n' "$MI_ROOT" "40 22 0:50 / $(mi_esc "$T/fm/opt") rw - fuse.sshfs x rw" >"$T/mountinfo-fuse-fm"
MM_MOUNTINFO=$MI MM_SUDO_MOUNTINFO=$T/mountinfo-fuse-fm run_setup "y\n" "$FMBIN"
expect "a FUSE mount appearing during sudo: stops after the folder" 1 "is on a FUSE mount at $(mi_esc "$T/fm/opt")"
if [[ $(wc -l <"$SUDO_LOG") == 2 ]]; then ok "FUSE during sudo: only the folder's two commands ran"; else fail "sudo ran: $(tr '\n' '|' <"$SUDO_LOG")"; fi
fresh_copy_hint "FUSE mount during sudo" "Stopped after making"

# ... or after the move: the final check says so.
make_tree "$T/fv"
FVBIN=$T/fv/opt/msi-mux-switch/msi-mux-switch
mi
printf '%s\n' "$MI_ROOT" "40 22 0:50 / $(mi_esc "$T/fv") rw - fuse.sshfs x rw" >"$T/mountinfo-fuse-fv"
MM_MOUNTINFO=$MI MM_SUDO_MV_MOUNTINFO=$T/mountinfo-fuse-fv run_setup "y\n" "$FVBIN"
expect "a FUSE mount appearing after the move: still not safe" 1 "Still not safe:"
if grep -qF "  $FVBIN is on a FUSE mount at $(mi_esc "$T/fv")" <<<"$OUT"; then ok "the final check names the mount"; else fail "the final check does not name the mount"; quote "$OUT"; fi

# --- the mount check's window: nothing but the mountinfo read between the
# two stats; the parse comes after the second.

# The trace of one passing run: the first take_snapshot, the cat, the second
# take_snapshot, and only then mount_problem (the parse) and mi_decode.
TRACE=$T/trace
printf 'n\n' | env PATH="$FAKE:$PATH" HOME="$T/home" bash -x "$SETUP" "$BIN" >/dev/null 2>"$TRACE"
snaps=$(grep -nE '^\++ take_snapshot$' "$TRACE" | head -n 2 | cut -d: -f1 | tr '\n' ' ')
read -r snap1 snap2 <<<"$snaps"
cat_at=$(grep -nE '^\++ cat -- /proc/self/mountinfo$' "$TRACE" | head -n 1 | cut -d: -f1)
parse_at=$(grep -nE '^\++ (mount_problem|mi_decode) ' "$TRACE" | head -n 1 | cut -d: -f1)
if [[ -n ${snap1:-} && -n ${snap2:-} && -n $cat_at && -n $parse_at ]] &&
  ((snap1 < cat_at && cat_at < snap2 && snap2 < parse_at)); then
  ok "mount check order: stat, read mountinfo, stat, then parse"
else
  fail "mount check order (stats at ${snaps:-none}, cat at ${cat_at:-none}, parse at ${parse_at:-none})"
fi
# Between the cat and the second stat: no other command than the snapshot's.
between=$(sed -n "$((cat_at + 1)),$((snap2 - 1))p" "$TRACE" | grep -vE '^\++ (\(\(|\[\[|read_ok=|text=|local |take_snapshot)' || true)
if [[ -z $between ]]; then ok "nothing runs between the mountinfo read and the second stat"; else fail "between the read and the second stat:"; quote "$between"; fi
# The read failing still loses to a changed stat: the change is reported.
make_tree "$T/fu"
MM_MOUNTINFO=unreadable MM_CAT_FLIP=$T/fu/opt run_setup "y\n" "$T/fu/opt/msi-mux-switch/msi-mux-switch"
expect "a change across an unreadable mountinfo read: the change wins" 1 "changed while it was being checked."
no_sudo "change across an unreadable read"

# --- the stats around the mount check must agree (a FUSE mount can forge a
# stat, then unmount lazily before mountinfo is read)

# Forged as root-owned 755 for the first stat, really yours after: without
# the second stat this would pass as already set up.
make_tree "$T/fg"
FGBIN=$T/fg/opt/msi-mux-switch/msi-mux-switch
printf '%s\n' "$FGBIN" "$T/fg/opt/msi-mux-switch" >>"$ROOTS"
run_setup "y\n" "$FGBIN"
expect "a forged root-owned binary: the control run is already set up" 0 "Already set up"
MM_CAT_UNROOT=$FGBIN run_setup "y\n" "$FGBIN"
expect "a forged stat that changes after the mount check is refused" 1 \
  "$FGBIN, or a directory above it, changed while it was being checked."
fresh_copy_hint "forged stat" "changed while it was being checked"
no_sudo "forged stat"
if grep -qF "Already set up" <<<"$OUT"; then fail "forged stat: still reported as set up"; else ok "forged stat: not reported as set up"; fi

make_tree "$T/f1"
F1BIN=$T/f1/opt/msi-mux-switch/msi-mux-switch
MM_CAT_FLIP=$F1BIN run_setup "y\n" "$F1BIN"
expect "the binary's owner changing across the first mount check is refused" 1 \
  "$F1BIN, or a directory above it, changed while it was being checked."
fresh_copy_hint "binary changed across the first mount check" "changed while it was being checked"
no_sudo "binary changed across the first mount check"
make_tree "$T/f2"
MM_CAT_FLIP=$T/f2/opt run_setup "y\n" "$T/f2/opt/msi-mux-switch/msi-mux-switch"
expect "an ancestor's owner changing across the first mount check is refused" 1 "changed while it was being checked."
no_sudo "ancestor changed across the first mount check"

# The re-check after the folder: its own stats around its mount check.
make_tree "$T/f3"
F3BIN=$T/f3/opt/msi-mux-switch/msi-mux-switch
MM_CAT_FLIP=$T/f3/opt/msi-mux-switch MM_CAT_FLIP_AT=2 run_setup "y\n" "$F3BIN"
expect "a change across the re-check's mount check stops after the folder" 1 \
  "$F3BIN, or a directory above it, changed while it was being checked."
if grep -qF "Stopped after making" <<<"$OUT"; then ok "re-check change: stopped after the folder"; else fail "re-check change: not stopped after the folder"; quote "$OUT"; fi
if [[ $(wc -l <"$SUDO_LOG") == 2 ]]; then ok "re-check change: only the folder's two commands ran"; else fail "sudo ran: $(tr '\n' '|' <"$SUDO_LOG")"; fi
fresh_copy_hint "change across the re-check" "Stopped after making"

# The final check: the same.
make_tree "$T/f4"
F4BIN=$T/f4/opt/msi-mux-switch/msi-mux-switch
MM_CAT_FLIP=$T/f4/opt MM_CAT_FLIP_AT=3 run_setup "y\n" "$F4BIN"
expect "a change across the final mount check: still not safe" 1 "Still not safe:"
if grep -qF "  $F4BIN, or a directory above it, changed while it was being checked." <<<"$OUT"; then
  ok "the final check names the change"
else
  fail "the final check does not name the change"; quote "$OUT"
fi
fresh_copy_hint "change across the final check" "Still not safe:"

# --- /etc/fuse.conf: user_allow_other on refuses, before anything else

FUSE_ON="user_allow_other is turned on in /etc/fuse.conf."
FUSE_UNREAD="/etc/fuse.conf exists but could not be read, so setup cannot check that user_allow_other is off"
FUSE_BIG="/etc/fuse.conf could not be checked for user_allow_other (it is too large or not plain text)."
# fuse_refused <name> <fuse.conf> <pattern>: refused, nothing run, no fix in
# place, the mount check never reached.
fuse_refused() {
  MM_FUSE_CONF=$2 run_setup "y\n" "$BIN"
  expect "$1" 1 "$3"
  if grep -qF "Refusing to set up $BIN:" <<<"$OUT" && grep -qF "Nothing was changed." <<<"$OUT"; then
    ok "$1: refused, nothing was changed"
  else
    fail "$1: not refused as setup, or no 'Nothing was changed.'"; quote "$OUT"
  fi
  if grep -qiE 'chmod|chown|by hand|run this again' <<<"$OUT"; then fail "$1: advice to fix in place or retry"; quote "$OUT"; else ok "$1: no fix in place, no retry"; fi
  if [[ -s $CAT_READS ]]; then fail "$1: mountinfo was read"; else ok "$1: refused before the mount check"; fi
  no_sudo "$1"
}
# fuse_passes <name> <fuse.conf>: the run goes on to ask.
fuse_passes() {
  MM_FUSE_CONF=$2 run_setup "n\n" "$BIN"
  expect "$1" 1 "Cancelled."
  if grep -qF "fuse.conf" <<<"$OUT"; then fail "$1: fuse.conf mentioned"; quote "$OUT"; else ok "$1: fuse.conf not mentioned"; fi
  no_sudo "$1"
}

for f in on indented inline-comment crlf; do
  fuse_refused "fuse.conf $f: refused" "$FIXTURES/fuse-conf-$f" "$FUSE_ON"
done
if grep -qF "Turn it off (comment out that line) and run setup again." <<<"$OUT"; then ok "fuse.conf on: the advice is to turn it off"; else fail "fuse.conf on: no advice to turn it off"; quote "$OUT"; fi
for f in off commented near-miss empty; do
  fuse_passes "fuse.conf $f: passes" "$FIXTURES/fuse-conf-$f"
done
printf 'mount_max = 1000\n\vuser_allow_other' >"$T/fuse-nonl"
fuse_refused "fuse.conf on without a final newline (after \\v): refused" "$T/fuse-nonl" "$FUSE_ON"
printf '\fuser_allow_other\t# x\n' >"$T/fuse-ff"
fuse_refused "fuse.conf on after \\f, before a tab: refused" "$T/fuse-ff" "$FUSE_ON"
printf 'user_allow_other#x\n' >"$T/fuse-hash"
fuse_refused "fuse.conf on with # right after the word: refused" "$T/fuse-hash" "$FUSE_ON"
fuse_passes "fuse.conf missing: passes" "$T/no-such-fuse.conf"
# A link there is not missing, even when its target cannot be reached.
ln -s "$T/no-such-target" "$T/fuse-dangling"
fuse_refused "fuse.conf a dangling link: refused as unread" "$T/fuse-dangling" "$FUSE_UNREAD"
ln -s "$T/fuse-loop-b" "$T/fuse-loop-a"
ln -s "$T/fuse-loop-a" "$T/fuse-loop-b"
fuse_refused "fuse.conf a link loop: refused as unread" "$T/fuse-loop-a" "$FUSE_UNREAD"
ln -s "$FIXTURES/fuse-conf-off" "$T/fuse-link-ok"
fuse_passes "fuse.conf a link to an off file: passes" "$T/fuse-link-ok"
if (($(id -u) == 0)); then
  echo "skip the unreadable fuse.conf case (running as root, which reads a mode-000 file)"
else
  cp -- "$FIXTURES/fuse-conf-off" "$T/fuse-unreadable"
  chmod 000 "$T/fuse-unreadable"
  fuse_refused "fuse.conf unreadable: refused" "$T/fuse-unreadable" "$FUSE_UNREAD"
  mkdir -p "$T/fuse-locked"
  cp -- "$FIXTURES/fuse-conf-off" "$T/fuse-locked/fuse.conf"
  chmod 000 "$T/fuse-locked"
  ln -s "$T/fuse-locked/fuse.conf" "$T/fuse-link-locked"
  fuse_refused "fuse.conf a link into an unsearchable folder: refused as unread" "$T/fuse-link-locked" "$FUSE_UNREAD"
  chmod 755 "$T/fuse-locked"
fi
mkdir -p "$T/fuse-dir"
fuse_refused "fuse.conf a directory: refused" "$T/fuse-dir" "$FUSE_UNREAD"
# 65536 bytes pass, 65537 refuse; multibyte bytes count as bytes.
head -c 65536 /dev/zero | tr '\0' '#' >"$T/fuse-max"
fuse_passes "fuse.conf of 65536 bytes: passes" "$T/fuse-max"
head -c 65537 /dev/zero | tr '\0' '#' >"$T/fuse-big"
fuse_refused "fuse.conf of 65537 bytes: refused" "$T/fuse-big" "$FUSE_BIG"
{ printf '# '; for ((i = 0; i < 32768; i++)); do printf '\303\251'; done; } >"$T/fuse-big-utf8"
fuse_refused "fuse.conf of 65538 bytes in two-byte characters: refused" "$T/fuse-big-utf8" "$FUSE_BIG"
printf '%s\n\n\n\n' "$(head -c 65534 /dev/zero | tr '\0' '#')" >"$T/fuse-big-nl"
fuse_refused "fuse.conf over the cap in final newlines: refused" "$T/fuse-big-nl" "$FUSE_BIG"
printf 'mount_max = 1000\n\0\n' >"$T/fuse-nul"
fuse_refused "fuse.conf with a NUL byte: refused" "$T/fuse-nul" "$FUSE_BIG"
printf 'mount_max = 1000\n' >"$T/fuse-nul-end"
printf '\0' >>"$T/fuse-nul-end"
fuse_refused "fuse.conf ending in a NUL byte: refused" "$T/fuse-nul-end" "$FUSE_BIG"
printf '\0user_allow_other\n' >"$T/fuse-nul-on"
fuse_refused "fuse.conf with a NUL before user_allow_other: refused as unchecked" "$T/fuse-nul-on" "$FUSE_BIG"
# A NUL then at least 64 KiB more: head is not left to die of SIGPIPE.
{ printf '\0'; head -c 65536 /dev/zero | tr '\0' '#'; } >"$T/fuse-nul-big"
fuse_refused "fuse.conf with a NUL then 65536 bytes: refused as not plain text" "$T/fuse-nul-big" "$FUSE_BIG"
{ printf 'mount_max = 1000\n\0'; head -c 200000 /dev/zero | tr '\0' '#'; } >"$T/fuse-nul-huge"
fuse_refused "fuse.conf with a NUL then 200000 bytes: refused as not plain text" "$T/fuse-nul-huge" "$FUSE_BIG"

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
fresh_copy_hint "binary swapped during sudo" "Stopped after making"
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
fresh_copy_hint "binary changed after the check" "changed after it was checked"

# The binary made other-writable during sudo: the recheck stops before the copy.
make_tree "$T/m"
MBIN=$T/m/opt/msi-mux-switch/msi-mux-switch
MM_SUDO_CHMOD=$MBIN run_setup "y\n" "$MBIN"
expect "a binary made writable during sudo: stops after the folder" 1 "$MBIN is writable by group or others."
if [[ $(wc -l <"$SUDO_LOG") == 2 ]]; then ok "only the folder's two commands ran"; else fail "sudo ran: $(tr '\n' '|' <"$SUDO_LOG")"; fi
fresh_copy_hint "binary made writable during sudo" "Stopped after making"

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
