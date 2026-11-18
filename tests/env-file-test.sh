#!/bin/bash

# The env file (Model.envFileText) sourced the way uwsm sources it: with `.`
# inside a function of a POSIX sh, IFS set to ":", against fixture trees that
# stand in for /sys/class/drm (the generated text with that one path
# replaced). For each case and each base it checks AQ_DRM_DEVICES, that
# nothing is printed on stdout or stderr, that the sourcing status is 0 and
# that no msi_mux_ variable is left behind; under sh, dash and busybox sh
# when present, and bash --posix. Then `sh -n` (and `dash -n`) and
# `shellcheck -s sh` on the text itself. Then the plugin's own read and
# write commands against a temporary HOME: absent, its own file, a symbolic
# link, a FIFO, a directory, an oversized file, and the previous build's
# temporary name left behind (a file, a symbolic link, a directory).
#
# Nothing under ~/.config is read or written: every file is in a temporary
# directory.

set -u

PLUGIN_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
FAILED=0
CHECKS=0

ok() { CHECKS=$((CHECKS + 1)); echo "ok   $*"; }
fail() { CHECKS=$((CHECKS + 1)); FAILED=$((FAILED + 1)); echo "FAIL $*"; }

T=$(mktemp -d) || exit 1
trap 'chmod -R u+rwx "$T" 2>/dev/null; rm -rf "$T"' EXIT

SHELLS=("sh")
command -v dash >/dev/null && SHELLS+=("dash")
command -v busybox >/dev/null && busybox sh -c 'exit 0' 2>/dev/null && SHELLS+=("busybox sh")
SHELLS+=("bash --posix")

for base in intel rtx; do
  if ! node "$PLUGIN_DIR/tests/env-file-text.js" "$base" >"$T/env-$base"; then
    echo "FAIL could not generate the $base text"
    exit 1
  fi
  if ! grep -qF '/sys/class/drm/card*' "$T/env-$base"; then
    echo "FAIL the $base text does not scan /sys/class/drm/card*"
    exit 1
  fi
done

# card <case> <name> <vendor|"unreadable"|"dir"|"none">
card() {
  local dir=$T/drm-$1/$2
  mkdir -p "$dir/device"
  case $3 in
    none) ;;
    dir) mkdir -p "$dir/device/vendor" ;;
    unreadable)
      printf '0x8086\n' >"$dir/device/vendor"
      chmod 000 "$dir/device/vendor"
      ;;
    *) printf '%s\n' "$3" >"$dir/device/vendor" ;;
  esac
}

mkdir -p "$T/drm-empty"
card both card0 0x8086
card both card1 0x10de
card swapped card0 0x10de
card swapped card1 0x8086
card nvidia card1 0x10de
card nvidia card1-eDP-2 none
card intel card0 0x8086
card connectors card0 0x8086
card connectors card1 0x10de
card connectors card0-eDP-1 0x10de
card connectors card1-DP-1 0x8086
card connectoronly card1 0x10de
card connectoronly card1-eDP-1 0x8086
card unreadable card0 unreadable
card unreadable card1 0x10de
card vendordir card0 dir
card vendordir card1 0x10de
card twointel card0 0x8086
card twointel card1 0x10de
card twointel card2 0x8086
card other card0 0x1002
card other card1 0x10de

# The sourcing shell: uwsm's source_file does `. "$1"` inside a function,
# with IFS=":" at that point. Results go to fd 3; stdout and stderr must stay
# empty. Single quotes on purpose: the sourcing shell expands it.
# shellcheck disable=SC2016
HARNESS='
IFS=:
src() { . "$1"; }
src "$1"
status=$?
IFS=" "
left=$(set | grep "^msi_mux_" || true)
printf "status=%s\n" "$status" >&3
printf "aq=%s\n" "${AQ_DRM_DEVICES-<unset>}" >&3
printf "left=%s\n" "$left" >&3
'

# check <case> <base> <expected AQ_DRM_DEVICES or <unset>> [shell...]
check() {
  local case=$1 base=$2 want=$3 file sh res out err
  file=$T/env-$base-$case
  sed "s|/sys/class/drm|$T/drm-$case|g" "$T/env-$base" >"$file"
  for sh in "${SHELLS[@]}"; do
    for mode in "" "set -u;"; do
      res=$T/res out=$T/out err=$T/err
      # shellcheck disable=SC2086
      env -u AQ_DRM_DEVICES $sh -c "$mode$HARNESS" harness "$file" 3>"$res" >"$out" 2>"$err"
      local label="$case, $base base, $sh${mode:+ (set -u)}"
      if [[ -s $out || -s $err ]]; then
        fail "$label: printed something: $(cat "$out" "$err" | tr '\n' '|')"
        continue
      fi
      if [[ $(sed -n 's/^status=//p' "$res") != 0 ]]; then
        fail "$label: sourcing status $(sed -n 's/^status=//p' "$res")"
        continue
      fi
      if [[ -n $(sed -n 's/^left=//p' "$res") ]]; then
        fail "$label: variables left behind: $(sed -n 's/^left=//p' "$res")"
        continue
      fi
      local got
      got=$(sed -n 's/^aq=//p' "$res")
      if [[ $got == "$want" ]]; then
        ok "$label: AQ_DRM_DEVICES=$got"
      else
        fail "$label: AQ_DRM_DEVICES=$got, want $want"
      fi
    done
  done
}

check both intel /dev/dri/card0:/dev/dri/card1
check both rtx /dev/dri/card1:/dev/dri/card0
check swapped intel /dev/dri/card1:/dev/dri/card0
check swapped rtx /dev/dri/card0:/dev/dri/card1
check nvidia intel "<unset>"
check nvidia rtx "<unset>"
check intel intel "<unset>"
check intel rtx "<unset>"
check empty intel "<unset>"
check empty rtx "<unset>"
check missing intel "<unset>"
check missing rtx "<unset>"
check connectors intel /dev/dri/card0:/dev/dri/card1
check connectors rtx /dev/dri/card1:/dev/dri/card0
check connectoronly rtx "<unset>"
check twointel intel /dev/dri/card0:/dev/dri/card1
check other rtx "<unset>"
check vendordir rtx "<unset>"
if [[ $(id -u) -ne 0 ]]; then
  check unreadable rtx "<unset>"
  check unreadable intel "<unset>"
else
  echo "skip the unreadable vendor case (root reads a mode-000 file)"
fi

# An AQ_DRM_DEVICES set before is left as it was when nothing is exported.
sed "s|/sys/class/drm|$T/drm-nvidia|g" "$T/env-rtx" >"$T/env-keep"
kept=$(AQ_DRM_DEVICES=/dev/dri/card9 sh -c '. "$1"; printf %s "$AQ_DRM_DEVICES"' keep "$T/env-keep" 2>&1)
if [[ $kept == /dev/dri/card9 ]]; then ok "an AQ_DRM_DEVICES set earlier is untouched when one GPU is present"; else fail "earlier AQ_DRM_DEVICES became: $kept"; fi

# The text itself.
for base in intel rtx; do
  if sh -n "$T/env-$base" 2>"$T/err"; then ok "sh -n: the $base text parses"; else fail "sh -n ($base): $(cat "$T/err")"; fi
  if command -v dash >/dev/null; then
    if dash -n "$T/env-$base" 2>"$T/err"; then ok "dash -n: the $base text parses"; else fail "dash -n ($base): $(cat "$T/err")"; fi
  else
    echo "skip dash -n (dash not installed)"
  fi
  if grep -qE '(^|[^_[:alnum:]])(exit|return)([^_[:alnum:]]|$)|set -e|^[[:space:]]*(echo|printf)' "$T/env-$base"; then
    fail "the $base text has an exit, return, set -e or a print"
  else
    ok "the $base text has no exit, return, set -e or print"
  fi
done

SC=${SHELLCHECK:-}
if [[ -z $SC ]] && command -v shellcheck >/dev/null && shellcheck --version >/dev/null 2>&1; then SC=shellcheck; fi
if [[ -n $SC ]]; then
  for base in intel rtx; do
    if out=$("$SC" -s sh -f gcc "$T/env-$base" 2>&1); then
      ok "shellcheck -s sh: the $base text is clean"
    else
      fail "shellcheck -s sh ($base): $out"
    fi
  done
else
  echo "skip shellcheck -s sh (no working shellcheck; run through tests/run.sh, which finds one)"
fi

# --- the plugin's own read and write (Model.envReadArgv / envWriteArgv), run
# as the widget runs them, against a temporary HOME.

H=$T/home
F=$H/.config/uwsm/env.d/90-msi-mux-gpu
helper() { node "$PLUGIN_DIR/tests/env-file-text.js" "$@"; }
argv_of() { mapfile -d '' -t ARGV < <(helper "$@"); }

# read_choice: runs the read (bounded by `timeout`, so a blocking read fails
# the case instead of hanging the suite) and parses its output.
read_choice() {
  argv_of --read-argv "$H"
  timeout 5 "${ARGV[@]}" 2>/dev/null | helper --parse-read
}

mkdir -p "$H"
choice=$(read_choice)
if [[ $choice == auto ]]; then ok "read: no file is Auto"; else fail "read: no file gave '$choice'"; fi

argv_of --write-argv "$H" intel
if "${ARGV[@]}" && cmp -s "$F" "$T/env-intel"; then ok "write: env.d created, the Intel text written exactly"; else fail "write: Intel"; fi
left=$(find "${F%/*}" -mindepth 1 -printf '%f ')
if [[ $left == "90-msi-mux-gpu " ]]; then ok "write: no temporary file left"; else fail "write left: $left"; fi
choice=$(read_choice)
if [[ $choice == intel ]]; then ok "read: the plugin's Intel file is Intel"; else fail "read: Intel file gave '$choice'"; fi

# A symbolic link at the path: read as modified, replaced (not followed) by a
# write.
printf 'keep\n' >"$T/target"
rm -f "$F"
ln -s "$T/target" "$F"
choice=$(read_choice)
if [[ $choice == modified ]]; then ok "read: a symbolic link is modified, not followed"; else fail "read: symlink gave '$choice'"; fi
argv_of --write-argv "$H" rtx
"${ARGV[@]}"
if [[ ! -L $F && $(cat "$T/target") == keep ]] && cmp -s "$F" "$T/env-rtx"; then
  ok "write: a symbolic link is replaced by the file; its target is untouched"
else
  fail "write over a symbolic link"
fi

# A symbolic link to a directory: the rename never moves into it; the link
# is replaced, and nothing is written in the directory it points to.
rm -f "$F"
mkdir "$T/pointed"
ln -s "$T/pointed" "$F"
argv_of --write-argv "$H" intel
"${ARGV[@]}" 2>/dev/null
if [[ -z $(find "$T/pointed" -mindepth 1 -print -quit) && ! -L $F ]] && cmp -s "$F" "$T/env-intel"; then
  ok "write: a symbolic link to a directory is replaced; nothing is written in that directory"
else
  fail "write over a symbolic link to a directory: $(find "$T/pointed" -mindepth 1 -printf '%f ')"
fi
left=$(find "${F%/*}" -mindepth 1 -printf '%f ')
if [[ $left == "90-msi-mux-gpu " ]]; then ok "write over a link to a directory: no temporary file left"; else fail "link to a directory left: $left"; fi

# A directory at the path: the write fails, nothing is moved into it, and no
# temporary file is left; the removal fails too and leaves it (never
# recursive).
rm -f "$F"
mkdir "$F"
argv_of --write-argv "$H" rtx
if "${ARGV[@]}" 2>/dev/null; then fail "write: a directory at the path was reported written"; else ok "write: a directory at the path fails"; fi
left=$(find "${F%/*}" -mindepth 1 -printf '%P ')
if [[ $left == "90-msi-mux-gpu " ]]; then ok "write into a directory: nothing moved into it, no temporary file left"; else fail "write into a directory left: $left"; fi
printf 'keep\n' >"$F/inside"
argv_of --remove-argv "$H"
if "${ARGV[@]}" 2>/dev/null; then fail "remove: a directory at the path was reported removed"; else ok "remove: a directory at the path fails"; fi
if [[ -d $F && $(cat "$F/inside") == keep ]]; then ok "remove: the directory and its content are left in place"; else fail "remove: the directory was removed or emptied"; fi
rm -rf "$F"

# The rename fails (an mv that always fails, first on PATH): an error, and the
# temporary file is removed.
mkdir -p "$T/failmv"
printf '#!/bin/sh\nexit 1\n' >"$T/failmv/mv"
chmod 755 "$T/failmv/mv"
argv_of --write-argv "$H" intel
if PATH="$T/failmv:$PATH" "${ARGV[@]}"; then fail "write: a failing mv was reported written"; else ok "write: a failing rename fails the write"; fi
left=$(find "${F%/*}" -mindepth 1 -printf '%f ')
if [[ -z $left ]]; then ok "write: a failing rename leaves no temporary file"; else fail "failing rename left: $left"; fi

# Auto removes the file, a leftover temporary file and the previous build's
# temporary name, and nothing else in env.d.
argv_of --write-argv "$H" intel
"${ARGV[@]}"
printf 'x\n' >"${F%/*}/.90-msi-mux-gpu.tmp"
printf 'x\n' >"${F%/*}/90-msi-mux-gpu.new"
printf 'x\n' >"${F%/*}/90-other"
argv_of --remove-argv "$H"
if "${ARGV[@]}"; then ok "remove: succeeds"; else fail "remove failed"; fi
left=$(find "${F%/*}" -mindepth 1 -printf '%f ')
if [[ $left == "90-other " ]]; then ok "remove: the file and both temporary names are gone; other files stay"; else fail "remove left: $left"; fi
rm -f "${F%/*}/90-other"

# A write removes the previous build's temporary name too (uwsm would source
# it): a regular file there is gone; a symbolic link there is removed, never
# followed; a directory there is left in place and the write still succeeds.
N=${F%/*}/90-msi-mux-gpu.new
printf 'x\n' >"$N"
argv_of --write-argv "$H" rtx
if "${ARGV[@]}" && cmp -s "$F" "$T/env-rtx" && [[ ! -e $N && ! -L $N ]]; then
  ok "write: a stale 90-msi-mux-gpu.new is removed"
else
  fail "write with a stale .new: $(find "${F%/*}" -mindepth 1 -printf '%f ')"
fi
printf 'keep\n' >"$T/new-target"
ln -s "$T/new-target" "$N"
argv_of --write-argv "$H" intel
if "${ARGV[@]}" && cmp -s "$F" "$T/env-intel" && [[ ! -e $N && ! -L $N && $(cat "$T/new-target") == keep ]]; then
  ok "write: a .new symbolic link is removed; its target is untouched"
else
  fail "write with a .new symbolic link: $(find "${F%/*}" -mindepth 1 -printf '%f ')"
fi
mkdir "$T/new-pointed"
printf 'keep\n' >"$T/new-pointed/inside"
ln -s "$T/new-pointed" "$N"
argv_of --write-argv "$H" rtx
if "${ARGV[@]}" && [[ ! -L $N && $(find "$T/new-pointed" -mindepth 1 -printf '%f ') == "inside " && $(cat "$T/new-pointed/inside") == keep ]]; then
  ok "write: a .new link to a directory is removed; nothing in that directory is touched"
else
  fail "write with a .new link to a directory: $(find "$T/new-pointed" -mindepth 1 -printf '%f ')"
fi
mkdir "$N"
printf 'keep\n' >"$N/inside"
argv_of --write-argv "$H" intel
if "${ARGV[@]}" 2>/dev/null && cmp -s "$F" "$T/env-intel"; then
  ok "write: a .new directory does not stop the write"
else
  fail "write with a .new directory failed"
fi
if [[ -d $N && $(cat "$N/inside") == keep ]]; then
  ok "write: a .new directory and its content are left in place"
else
  fail "write: the .new directory was removed or emptied"
fi
rm -rf "$N"
rm -f "$F"

# A FIFO (a read would block) and a directory: modified, without reading.
rm -f "$F"
mkfifo "$F"
choice=$(read_choice)
if [[ $choice == modified ]]; then ok "read: a FIFO is modified, and the read does not block"; else fail "read: FIFO gave '$choice'"; fi
rm -f "$F"
mkdir "$F"
choice=$(read_choice)
if [[ $choice == modified ]]; then ok "read: a directory is modified"; else fail "read: directory gave '$choice'"; fi
rmdir "$F"

# A huge file: at most 64 KiB + 1 byte is read, and it is modified.
head -c 5000000 /dev/zero | tr '\0' 'x' >"$F"
argv_of --read-argv "$H"
bytes=$(timeout 5 "${ARGV[@]}" | wc -c)
if ((bytes == 5 + 65537)); then ok "read: a 5 MB file is read up to 64 KiB + 1 byte"; else fail "read: a 5 MB file gave $bytes bytes"; fi
choice=$(read_choice)
if [[ $choice == modified ]]; then ok "read: an oversized file is modified"; else fail "read: oversized gave '$choice'"; fi
rm -f "$F"

echo "$((CHECKS - FAILED))/$CHECKS passed"
((FAILED == 0))
