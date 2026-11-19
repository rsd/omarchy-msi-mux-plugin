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
#     others (it is not fixed in place: rebuild or re-download it into a
#     folder only you can write, then run this on that fresh file);
#   - the folder is your home, /, a folder directly under / or directly under
#     /home, or under /media, /mnt, /run/media or /run/user;
#   - the folder is not owned by you or root, has the sticky bit, is writable
#     by group or others, or holds anything but the binary;
#   - a directory further up is not owned by root or is writable by group or
#     others.
# After the folder is made root-owned it checks the binary again (still the
# same regular file, owned by you or root, not writable by group or others)
# and stops before the copy if not. The final check requires the binary and
# every directory above it to be owned by root and not writable by group or
# others. It builds and downloads nothing: see the plugin's README for
# building msi-mux-switch.

set -u

DEFAULT_BINARY=/opt/msi-mux-switch/msi-mux-switch
README_HINT="See the plugin's README (Backend setup) for building and installing msi-mux-switch."
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

# stat_line <path>: "<uid> <raw mode in hex> <owner>" without following a
# symlink; fails when the path cannot be read.
stat_line() {
  stat -c '%u %f %U' -- "$1" 2>/dev/null
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

dir=${bin%/*}
[[ -z $dir ]] && dir=/
mapfile -t dirs < <(ancestors "$bin")

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
  say "Fix that by hand (it is not the binary's own folder), or move msi-mux-switch somewhere that passes."
  refuse
fi

# own_dir_problem: why the binary's folder may not be changed, or nothing.
# It must be a real directory owned by you or root, without the sticky bit,
# not writable by group or others, holding the binary and nothing else.
own_dir_problem() {
  local line uid raw owner fmt me entries
  if ! line=$(stat_line "$dir"); then
    say "$dir cannot be checked (missing or not readable)."
    return
  fi
  read -r uid raw owner <<<"$line"
  fmt=$((16#$raw & 16#F000))
  me=$(id -u)
  if ((fmt != 16#4000)); then
    say "$dir is not a directory."
  elif ((uid != 0 && uid != me)); then
    say "$dir is owned by $owner, not by you or root."
  elif (((16#$raw & 8#1000) != 0)); then
    say "$dir has the sticky bit: it is a shared folder."
  elif (((16#$raw & 8#022) != 0)); then
    say "$dir is writable by group or others."
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
if [[ -n $dir_problem ]]; then
  say "Refusing to change $dir:"
  indent "$dir_problem"
  say "Put msi-mux-switch alone in a folder of its own (e.g. $DEFAULT_BINARY), owned by you or root, and point the plugin's setting there."
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
  say "Rebuild or re-download msi-mux-switch into a folder only you can write (for example a fresh build from the upstream source; see the README), then run this on that fresh file."
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
# still alone in the folder.
recheck=$(
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
  say "The binary was not touched. Check $dir by hand."
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
  else
    say "$bin changed after it was checked: the copy does not match it."
  fi
  say "Removing the copy; the binary is not replaced:"
  shown "${rm_cmd[@]}"
  "${rm_cmd[@]}" || failed
  say "Check $bin and run this again."
  exit 1
fi
"${mv_cmd[@]}" || failed

problems=$(
  check_entry "$bin" file
  for d in "${dirs[@]}"; do check_entry "$d" dir; done
)
say ""
if [[ -n $problems ]]; then
  say "Still not safe:"
  indent "$problems"
  exit 1
fi
say "Done: $bin and $dir are owned by root with mode 755."
say "Open the MSI GPU MUX panel again to switch."
