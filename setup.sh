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
# It changes nothing else. It refuses (and changes nothing) when the folder is
# your home, /, a folder directly under / or directly under /home, under
# /media, /mnt, /run/media or /run/user, when the folder is not owned by you or
# root, has the sticky bit, is writable by group or others, or holds anything
# but the binary, or when a directory further up fails the same check. It
# builds and downloads nothing: see the plugin's README for building
# msi-mux-switch.

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

name=${bin##*/}
staged=$dir/.$name.new
chown_cmd=("$SUDO" chown -h root:root -- "$dir")
chmod_cmd=("$SUDO" chmod 755 -- "$dir")
install_cmd=("$SUDO" install -o root -g root -m 755 -- "$bin" "$staged")
mv_cmd=("$SUDO" mv -f -- "$staged" "$bin")
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

# 2. The binary again, now that the folder is fixed: still a regular file
# (not a link), still alone in the folder.
recheck=$(
  line=$(stat_line "$bin") || { say "$bin cannot be checked any more."; exit 0; }
  read -r _ raw _ <<<"$line"
  (((16#$raw & 16#F000) == 16#8000)) || say "$bin is no longer a regular file."
  own_dir_problem
)
if [[ -n $recheck ]]; then
  say ""
  say "Stopped after making $dir root-owned:"
  indent "$recheck"
  say "The binary was not touched. Check $dir by hand."
  exit 1
fi

# 3. A fresh root-owned copy replaces the binary.
"${install_cmd[@]}" || failed
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
