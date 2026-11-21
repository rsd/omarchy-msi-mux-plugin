#!/bin/bash

# MSI GPU MUX: make msi-mux-switch safe to run through pkexec.
#
# Usage: setup.sh [path-to-msi-mux-switch]
#        (default: /opt/msi-mux-switch/msi-mux-switch)
#
# The plugin runs the binary as root through pkexec, so it refuses to unless
# the binary is a regular file owned by root and not writable by group or
# others, and every directory above it is too: a file or folder the user can
# write could be swapped for something else that then runs as root.
#
# This script checks that, and when only the binary and its own folder are
# wrong, shows the commands that fix them, asks, and runs them with sudo:
#
#   sudo chown -h root:root -- <folder>
#   sudo chmod 755 -- <folder>
#   sudo install -o root -g root -m 755 -- <binary> <folder>/.<name>.new
#   sudo mv -f -- <folder>/.<name>.new <binary>
#
# The folder is made root-owned first, so nothing can be swapped in it
# afterwards; the binary is then checked again and replaced by a fresh
# root-owned copy (a file you could still write through an open descriptor is
# never chowned in place).
#
# Before asking, it records the binary's SHA-256, read through one open
# descriptor that is checked to be the same file (device and inode) the path
# names. After install, the root-owned copy is hashed again; if the two
# differ, the binary changed after it was checked: the copy is removed with
# `sudo rm -f -- <folder>/.<name>.new` (shown before it runs), the binary is
# not replaced, and the script exits with an error.
#
# It changes nothing else. It refuses (and changes nothing) when:
#   - the path is relative, a symbolic link, or not a regular file;
#   - the binary is not owned by you or root, or is writable by group or
#     others;
#   - the folder is your home, /, a folder directly under / or directly under
#     /home, or under /media, /mnt, /run/media or /run/user;
#   - the binary, or a directory above it, is on a FUSE mount (fuse, fuseblk,
#     fuse.*) or a mount made for a user (user_id= other than 0), as
#     /proc/self/mountinfo lists them; or that file cannot be read or parsed;
#   - the owner, mode or type of the binary or a directory above it differs
#     between the stat taken before reading mountinfo and the one after (a
#     FUSE mount can forge the first and unmount lazily before the read);
#   - the folder is not owned by you or root, has the sticky bit, is writable
#     by group or others, or holds anything but the binary;
#   - a directory further up is not owned by root or is writable by group or
#     others.
# Wherever another account could already have changed the binary (it, its
# folder or a folder above could be written or mounted by someone else, or
# it changed after the check), nothing is fixed in place: the advice is to
# rebuild or re-download msi-mux-switch into a folder only you can write,
# then run setup again.
# After the folder is made root-owned it checks the binary again (still the
# same regular file, owned by you or root, not writable by group or others,
# on no FUSE or user mount, the same in the stats around the mount check)
# and stops before the copy if not. The final check requires the binary and
# every directory above it to be owned by root and not writable by group or
# others, on no FUSE or user mount, the same in both stats. It builds
# and downloads nothing: see the plugin's README for building msi-mux-switch.

set -u

DEFAULT_BINARY=/opt/msi-mux-switch/msi-mux-switch
README_HINT="See the plugin's README (Backend setup) for building and installing msi-mux-switch."
# The advice whenever another account could already have changed the binary:
# a fix in place (chmod, chown) would keep whatever it holds, and a write
# descriptor opened earlier survives it.
REBUILD_HINT="Rebuild or re-download msi-mux-switch into a folder only you can write, under folders owned by root and not writable by group or others (e.g. $DEFAULT_BINARY; a fresh build from the upstream source, see the README), then run setup again on that fresh file."
SUDO=sudo

say() { printf '%s\n' "$*"; }

# Each line of $1, indented.
indent() {
  local line
  while IFS= read -r line; do say "  $line"; done <<<"$1"
}

refuse() {
  say ""
  say "Nothing was changed."
  say "$README_HINT"
  exit 1
}

# The stat lines of the binary and every directory above it as the last
# checked_mounts took them: the checks after it judge these lines, the ones
# the mount check was made between.
SNAP_PATHS=()
SNAP_LINES=()
SNAP=""

# stat_line <path>: "<uid> <raw mode in hex> <owner>" without following a
# symlink, from the snapshot when it holds the path; fails when the path
# cannot be read.
stat_line() {
  local i
  for i in "${!SNAP_PATHS[@]}"; do
    if [[ ${SNAP_PATHS[i]} == "$1" ]]; then
      [[ -n ${SNAP_LINES[i]} ]] || return 1
      printf '%s\n' "${SNAP_LINES[i]}"
      return 0
    fi
  done
  stat -c '%u %f %U' -- "$1" 2>/dev/null
}

# take_snapshot: stat the binary and every directory above it (an empty line
# for one that cannot be read) into SNAP_PATHS, SNAP_LINES and, as one text
# to compare, SNAP.
take_snapshot() {
  local p line
  SNAP_PATHS=()
  SNAP_LINES=()
  SNAP=""
  for p in "$bin" "${dirs[@]}"; do
    line=$(stat -c '%u %f %U' -- "$p" 2>/dev/null) || line=""
    SNAP_PATHS+=("$p")
    SNAP_LINES+=("$line")
    SNAP+="$p $line"$'\n'
  done
}

# check_entry <path> <file|dir>: prints why the path fails the gate, or
# nothing when it passes.
check_entry() {
  local path=$1 want=$2 line uid raw owner fmt
  if ! line=$(stat_line "$path"); then
    say "$path cannot be checked (missing or not readable)."
    return
  fi
  read -r uid raw owner <<<"$line"
  fmt=$((16#$raw & 16#F000))
  if ((fmt == 16#A000)); then
    say "$path is a symbolic link."
    return
  fi
  if [[ $want == file ]] && ((fmt != 16#8000)); then
    say "$path is not a regular file."
    return
  fi
  if [[ $want == dir ]] && ((fmt != 16#4000)); then
    say "$path is not a directory."
    return
  fi
  if ((uid != 0)); then
    say "$path is owned by $owner, not root."
    return
  fi
  if (((16#$raw & 8#022) != 0)); then
    say "$path is writable by group or others."
  fi
}

# mi_decode <field>: a mountinfo path with its octal escapes (\040 for a
# space, \011, \012, \134 for a backslash) decoded into MI_DECODED; fails on
# a backslash not followed by three octal digits.
mi_decode() {
  local s=$1 out="" ch
  while [[ $s == *\\* ]]; do
    out+=${s%%\\*}
    s=${s#*\\}
    [[ $s =~ ^[0-7][0-7][0-7] ]] || return 1
    # %b reads \0NNN as octal; the digits were checked just above.
    printf -v ch '%b' "\\0${s:0:3}"
    out+=$ch
    s=${s:3}
  done
  MI_DECODED=$out$s
}

# mount_problem <path>: why the path sits on a mount another account may
# control, or nothing. With user_allow_other in /etc/fuse.conf, an account can
# FUSE-mount over a folder it owns and report every file there as root's, so
# the owner and mode checks cannot see it. Every mount at the path or at a
# directory above it counts, not only the last one stacked there: a FUSE
# mount (fuse, fuseblk, fuse.*) or one made for a user (user_id= other than
# 0) refuses it. Status 1 for such a mount, 2 when mountinfo cannot be read
# or parsed, or has no entry for / (it then cannot be checked: refuse too).
mount_problem() {
  local path=$1 text line rest mp fstype opts o sep i covered=0 parsed=0
  local -a f
  # Through cat so the tests can serve a fixture (as they fake stat).
  if ! text=$(cat -- /proc/self/mountinfo 2>/dev/null); then
    say "$path could not be checked: /proc/self/mountinfo could not be read."
    return 2
  fi
  while IFS= read -r line; do
    # Split on single spaces: an empty source leaves an empty field.
    f=()
    rest=$line
    while [[ $rest == *' '* ]]; do
      f+=("${rest%% *}")
      rest=${rest#* }
    done
    f+=("$rest")
    # id parent maj:min root mountpoint mountopts [optional...] - fstype source superopts
    sep=0
    for ((i = 6; i < ${#f[@]}; i++)); do
      [[ ${f[i]} == - ]] && { sep=$i; break; }
    done
    # The mount id and parent id are decimal numbers, the device maj:min.
    if ((sep == 0 || ${#f[@]} != sep + 4)) || [[ -z ${f[sep + 1]} ]] ||
      [[ ! ${f[0]} =~ ^[0-9]+$ || ! ${f[1]} =~ ^[0-9]+$ || ! ${f[2]} =~ ^[0-9]+:[0-9]+$ ]] ||
      ! mi_decode "${f[4]}" || [[ $MI_DECODED != /* ]]; then
      parsed=0
      break
    fi
    parsed=1
    mp=$MI_DECODED
    [[ $mp == / || $path == "$mp" || $path == "$mp"/* ]] || continue
    [[ $mp == / ]] && covered=1
    fstype=${f[sep + 1]}
    if [[ $fstype == fuse || $fstype == fuseblk || $fstype == fuse.* ]]; then
      say "$path is on a FUSE mount at ${f[4]} ($fstype), which another account may control."
      return 1
    fi
    IFS=, read -r -a opts <<<"${f[5]},${f[sep + 3]}"
    for o in "${opts[@]}"; do
      # user_id= must be decimal digits worth 0; empty or anything else is
      # a mount made for another user.
      if [[ $o == user_id=* && ! ${o#user_id=} =~ ^0+$ ]]; then
        say "$path is on a user mount at ${f[4]} ($o), which another account may control."
        return 1
      fi
    done
  done <<<"$text"
  if ((!parsed)); then
    say "$path could not be checked: /proc/self/mountinfo could not be parsed."
    return 2
  fi
  if ((!covered)); then
    say "$path could not be checked: /proc/self/mountinfo has no entry for /."
    return 2
  fi
}

# checked_mounts: the mount check (mount_problem) between two stats of the
# binary and every directory above it, which must be the same. A FUSE daemon
# can answer the first stat with a forged root owner and then lazily unmount
# (fusermount3 -u -z) before mountinfo is read: the second stat then sees
# what is really there. The checks after it read these stat lines.
# Sets MOUNT_MSG to why it fails; status 1 for a FUSE or user mount, 2 when
# mountinfo cannot be checked, 3 when the two stats differ.
MOUNT_MSG=""
checked_mounts() {
  local before status
  take_snapshot
  before=$SNAP
  MOUNT_MSG=$(mount_problem "$bin")
  status=$?
  take_snapshot
  if [[ $SNAP != "$before" ]]; then
    MOUNT_MSG="$bin, or a directory above it, changed while it was being checked."
    return 3
  fi
  if ((status == 0)) && [[ -n $MOUNT_MSG ]]; then status=2; fi
  return "$status"
}

# Every directory above <path>, nearest first, ending with /.
ancestors() {
  local p=$1
  while [[ $p != / ]]; do
    p=${p%/*}
    [[ -z $p ]] && p=/
    printf '%s\n' "$p"
  done
}

bin=${1:-$DEFAULT_BINARY}

say "MSI GPU MUX backend setup"
say "Binary: $bin"
say ""

case $bin in
  /*) ;;
  *)
    say "The path must be absolute."
    refuse
    ;;
esac
if [[ $bin == *..* || $bin == *$'\n'* || $bin == */ || $bin == *//* || $bin == */./* ]]; then
  say "The path must not contain \"..\", \"//\", \"/./\" or a newline, nor end in /."
  refuse
fi

# Folders a user can mount or own: the plugin refuses a binary there anyway.
for m in /media /mnt /run/media /run/user; do
  if [[ $bin == "$m"/* ]]; then
    say "$bin is under $m, where a user can mount or replace files. Install msi-mux-switch somewhere like $DEFAULT_BINARY instead."
    refuse
  fi
done

dir=${bin%/*}
[[ -z $dir ]] && dir=/
mapfile -t dirs < <(ancestors "$bin")

# The same for a FUSE or user mount anywhere at or above it.
checked_mounts
mount_status=$?
if ((mount_status != 0)); then
  say "Refusing to set up $bin:"
  indent "$MOUNT_MSG"
  case $mount_status in
    1) say "$REBUILD_HINT It must not be on a FUSE or user mount." ;;
    3) say "$REBUILD_HINT" ;;
  esac
  refuse
fi

if [[ -L $bin ]]; then
  say "$bin is a symbolic link. Point the plugin's binaryPath setting at the real file."
  refuse
fi
if [[ ! -e $bin ]]; then
  say "msi-mux-switch was not found at $bin."
  refuse
fi
if [[ ! -f $bin ]]; then
  say "$bin is not a regular file."
  refuse
fi

# Already safe: nothing to do.
problems=$(
  check_entry "$bin" file
  for d in "${dirs[@]}"; do check_entry "$d" dir; done
)
if [[ -z $problems ]]; then
  say "Already set up: the binary and every directory above it are owned by root and not writable by group or others."
  say "Nothing to do."
  exit 0
fi
say "Problems found:"
indent "$problems"
say ""

# The folder this script would change must be the binary's own.
home=${HOME%/}
parent_of_dir=${dir%/*}
[[ -z $parent_of_dir ]] && parent_of_dir=/
if [[ $dir == / || $dir == "$home" || $parent_of_dir == / || $parent_of_dir == /home ]]; then
  say "Refusing to change $dir: it is your home, /, or a folder directly under / or /home."
  say "Move msi-mux-switch into a folder of its own (e.g. $DEFAULT_BINARY) and point the plugin's setting there."
  refuse
fi

# Directories further up are not this script's to change.
further=$(for d in "${dirs[@]:1}"; do check_entry "$d" dir; done)
if [[ -n $further ]]; then
  say "A directory above $dir fails the check:"
  indent "$further"
  # Not a fix by hand: whoever could write there may have swapped the
  # binary's folder, so the binary may be theirs.
  say "$REBUILD_HINT"
  refuse
fi

# own_dir_problem: why the binary's folder may not be changed, or nothing.
# It must be a real directory owned by you or root, without the sticky bit,
# not writable by group or others, holding the binary and nothing else.
# Status 2 when another account could have changed what is in it.
own_dir_problem() {
  local line uid raw owner fmt me entries
  if ! line=$(stat_line "$dir"); then
    say "$dir cannot be checked (missing or not readable)."
    return 2
  fi
  read -r uid raw owner <<<"$line"
  fmt=$((16#$raw & 16#F000))
  me=$(id -u)
  if ((fmt != 16#4000)); then
    say "$dir is not a directory."
    return 2
  elif ((uid != 0 && uid != me)); then
    say "$dir is owned by $owner, not by you or root."
    return 2
  elif (((16#$raw & 8#1000) != 0)); then
    say "$dir has the sticky bit: it is a shared folder."
    return 2
  elif (((16#$raw & 8#022) != 0)); then
    say "$dir is writable by group or others."
    return 2
  else
    shopt -s nullglob dotglob
    entries=("$dir"/*)
    shopt -u nullglob dotglob
    if [[ ! -r $dir || ! -x $dir ]]; then
      say "$dir cannot be listed."
    elif ((${#entries[@]} != 1)) || [[ ${entries[0]} != "$bin" ]]; then
      say "$dir holds other files besides msi-mux-switch."
    fi
  fi
}

dir_problem=$(own_dir_problem)
dir_status=$?
if [[ -n $dir_problem ]]; then
  say "Refusing to change $dir:"
  indent "$dir_problem"
  if ((dir_status == 2)); then
    # Another account could have put its own content there.
    say "$REBUILD_HINT"
  else
    say "Put msi-mux-switch alone in a folder of its own (e.g. $DEFAULT_BINARY), owned by you or root, and point the plugin's setting there."
  fi
  refuse
fi

me=$(id -u)

# bin_problem: why the binary itself may not be installed, or nothing. It
# must be a regular file owned by you or root, not writable by group or
# others: a binary another account can write could be changed to run as root.
bin_problem() {
  local line uid raw owner
  if ! line=$(stat_line "$bin"); then
    say "$bin cannot be checked (missing or not readable)."
    return
  fi
  read -r uid raw owner <<<"$line"
  if (((16#$raw & 16#F000) != 16#8000)); then
    say "$bin is not a regular file."
  elif ((uid != 0 && uid != me)); then
    say "$bin is owned by $owner, not by you or root."
  elif (((16#$raw & 8#022) != 0)); then
    say "$bin is writable by group or others."
  fi
}

# dev_ino <path>: "<device>:<inode>" of the path itself (not following a link).
dev_ino() {
  stat -c '%d:%i' -- "$1" 2>/dev/null
}

bin_refusal=$(bin_problem)
if [[ -n $bin_refusal ]]; then
  say "Refusing to install $bin:"
  indent "$bin_refusal"
  # Not chmod: a file others could write may already hold their content, and
  # they may still write through a descriptor opened earlier.
  say "$REBUILD_HINT"
  refuse
fi

# The checksum of what was checked: read through one descriptor that must be
# the same file the path names.
if ! exec 3<"$bin"; then
  say "$bin cannot be read."
  refuse
fi
bin_id=$(dev_ino "$bin")
fd_id=$(stat -L -c '%d:%i' -- /proc/self/fd/3 2>/dev/null)
if [[ -z $bin_id || $bin_id != "$fd_id" ]]; then
  say "$bin changed while it was being checked."
  say "$REBUILD_HINT"
  refuse
fi
checked_sum=$(sha256sum <&3 2>/dev/null)
checked_sum=${checked_sum%% *}
exec 3<&-
if [[ ! $checked_sum =~ ^[0-9a-f]{64}$ ]]; then
  say "The checksum of $bin could not be taken (sha256sum)."
  refuse
fi

name=${bin##*/}
staged=$dir/.$name.new
chown_cmd=("$SUDO" chown -h root:root -- "$dir")
chmod_cmd=("$SUDO" chmod 755 -- "$dir")
install_cmd=("$SUDO" install -o root -g root -m 755 -- "$bin" "$staged")
mv_cmd=("$SUDO" mv -f -- "$staged" "$bin")
rm_cmd=("$SUDO" rm -f -- "$staged")
shown() {
  local line
  printf -v line '%q ' "$@"
  say "  ${line% }"
}
say "This will run:"
shown "${chown_cmd[@]}"
shown "${chmod_cmd[@]}"
shown "${install_cmd[@]}"
shown "${mv_cmd[@]}"
say "(the folder first, then a fresh root-owned copy replaces the binary)"
say "(if the copy does not match the binary as checked, it is removed instead and the binary is not replaced)"
say ""
printf 'Run these commands? [y/N] '
answer=""
read -r answer || answer=""
case $answer in
  y | Y | yes | YES) ;;
  *)
    say "Cancelled."
    say "Nothing was changed."
    exit 1
    ;;
esac

failed() {
  say ""
  say "A command failed; check the messages above."
  exit 1
}

# 1. The folder: once root-owned, nothing in it can be swapped any more.
"${chown_cmd[@]}" || failed
"${chmod_cmd[@]}" || failed

# 2. The binary again, now that the folder is fixed: still the same regular
# file (not a link), owned by you or root, not writable by group or others,
# still alone in the folder, on no FUSE or user mount.
recheck=$(
  checked_mounts || say "$MOUNT_MSG"
  line=$(stat_line "$bin") || { say "$bin cannot be checked any more."; exit 0; }
  read -r _ raw _ <<<"$line"
  if (((16#$raw & 16#F000) != 16#8000)); then
    say "$bin is no longer a regular file."
  else
    bin_problem
    [[ $(dev_ino "$bin") == "$bin_id" ]] || say "$bin was replaced by another file after it was checked."
  fi
  own_dir_problem
)
if [[ -n $recheck ]]; then
  say ""
  say "Stopped after making $dir root-owned:"
  indent "$recheck"
  # Whatever changed since the check may have changed the binary too.
  say "The binary was not touched. $REBUILD_HINT"
  exit 1
fi

# 3. A fresh root-owned copy, in the root-owned folder, where only root can
# change it; it replaces the binary only if it is what was checked.
"${install_cmd[@]}" || failed
staged_sum=$(sha256sum -- "$staged" 2>/dev/null)
staged_sum=${staged_sum%% *}
if [[ $staged_sum != "$checked_sum" ]]; then
  say ""
  if [[ -z $staged_sum ]]; then
    say "The copy $staged cannot be checked (it was not made, or cannot be read)."
    hint="Check the messages above and run this again."
  else
    say "$bin changed after it was checked: the copy does not match it."
    # Someone wrote to it: whatever it holds now is not what was checked.
    hint=$REBUILD_HINT
  fi
  say "Removing the copy; the binary is not replaced:"
  shown "${rm_cmd[@]}"
  "${rm_cmd[@]}" || failed
  say "$hint"
  exit 1
fi
"${mv_cmd[@]}" || failed

problems=$(
  checked_mounts || say "$MOUNT_MSG"
  check_entry "$bin" file
  for d in "${dirs[@]}"; do check_entry "$d" dir; done
)
say ""
if [[ -n $problems ]]; then
  say "Still not safe:"
  indent "$problems"
  say "$REBUILD_HINT"
  exit 1
fi
say "Done: $bin and $dir are owned by root with mode 755."
say "Open the MSI GPU MUX panel again to switch."
