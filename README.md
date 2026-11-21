# MSI GPU MUX

A bar widget for [Omarchy](https://omarchy.org) that shows and switches the
hardware GPU MUX of supported MSI laptops from the top bar, and sets which GPU
Hyprland renders on.

![The MSI GPU MUX panel](preview.png)

The bar icon shows the current mode, with a badge while a switch is staged.
Click it for the panel: current and staged mode, AC state, the three modes with
a **Switch** button each, and the **Hyprland base GPU** dropdown. A disabled
button says why on its row. The panel is keyboard-driven too: any key shows a
cursor, arrows (or `j`/`k`) move it, Enter or Space activates, Esc closes. In a
confirmation dialog only the arrows, Tab, Enter and Esc act (letters and Space
do nothing), and it always opens on **Cancel** or **Later**. A panel that
reopened by itself to show a finished switch ignores every key but Esc until you
move the pointer over it, click it, or open the panel yourself.

The widget is hidden on non-MSI machines. On an MSI machine it is greyed, with
the reason and the fix, when the backend is missing or unsafe or the model is
not supported.

## Modes

| Mode | What it does |
|---|---|
| **Discrete** | RTX only. Fastest, highest battery use. |
| **MSHybrid** | The laptop panel runs on the Intel GPU; every external output (DP, HDMI) runs on the RTX. Verified on an MS-15M3. |
| **Integrated** | Intel only. Best battery. External outputs are wired to the RTX, so they are likely dark. Not tested. |

Two separate settings are involved:

| | Changes | Applied |
|---|---|---|
| **MUX mode** (the Switch buttons) | Which GPU the laptop panel is wired to, in firmware. | At power-on, after a full shutdown. |
| **Hyprland base GPU** (the dropdown) | Which GPU Hyprland renders on. | At your next login. |

## Switching

1. Click **Switch** on a mode, confirm, and authenticate in Omarchy's polkit
   prompt. This only **stages** the switch. The confirmation reminds you: "If
   your disk is encrypted, have its recovery key saved off this laptop before
   switching." (msi-mux-switch's own warning: keep any disk-encryption
   recovery key available off the laptop.)
2. Do a **full shutdown** (the panel offers **Shut down now**, which runs
   `omarchy-system shutdown`, or **Later**). A reboot does not apply it. If
   the panel closed during authentication, it reopens to show the result
   without that dialog: use the **Shut down now** button under the modes.
3. Power on. The new mode is active.

Notes:

- The laptop may power itself back on shortly after the power-off. That is
  firmware applying the switch; it is normal and is not a reboot.
- Once staged, the switch can't be changed or cancelled until that shutdown:
  the firmware's apply-ready flag stays set and msi-mux-switch refuses every
  further mode change. While staged, no mode has a Switch button, and the line
  "A switch is staged. It can't be changed or cancelled until after a full
  shutdown." carries a **Shut down now** button.
- A switch that fails and rolls back can leave that flag set with nothing
  staged. The panel then shows "The firmware still has a switch in progress. A
  full shutdown clears it." with **Shut down now** instead of the Switch
  buttons, like the staged case. The plugin remembers this in the shell,
  tagged with the boot id (`/proc/sys/kernel/random/boot_id`), so it survives
  closing and reopening the panel. It forgets it when the boot id changes
  (a full shutdown), when a later status read shows a different current or
  target mode, or when the ownership check refuses. The memory is in the
  shell's memory only: after a shell restart it is gone, and the next switch
  attempt shows the refusal again.
- AC power is required. On battery the buttons are disabled.
- Integrated asks for an extra confirmation about external screens (setting
  `warnBeforeIntegrated`).

## Requirements

- An Omarchy desktop and a supported MSI laptop (see
  [Supported machines](#supported-machines-and-the-override-flags)).
- **msi-mux-switch**, the command-line tool that does the firmware switch:
  [github.com/steelbrain/msi-gpu-mux-switch](https://github.com/steelbrain/msi-gpu-mux-switch)
  (MIT, by its own author; the plugin was written against commit `223ca06`).
  The plugin only calls it; it never builds, bundles, downloads or updates it.
- **`user_allow_other` must be off** in `/etc/fuse.conf`, meaning commented out
  or absent (a missing file counts as off). It is off by default on Arch and
  Omarchy. With it on, another account can mount a FUSE filesystem over a
  folder it owns and report its files as owned by root. The plugin and
  `setup.sh` both refuse while it is on (see
  [Make it root-owned](#2-make-it-root-owned)).

## Install, update, remove

Install (the plugin folder must be named by its id):

```bash
omarchy plugin add https://github.com/rsd/omarchy-msi-mux-plugin.git --enable
```

Or copy or clone this repository to
`~/.config/omarchy/plugins/io.github.rsd.msi-mux` and run
`omarchy plugin enable io.github.rsd.msi-mux`. Then set up the backend (next
section); until then the icon is greyed and the panel says why.

**Update or develop:** after changing the plugin's files (an edit, a
`git pull`), run

```bash
omarchy-restart-shell
```

This is the only thing that reloads the plugin's code. `omarchy-shell shell
rescanPlugins` and disabling and re-enabling the plugin do not: the shell keeps
running the old code. Do not use `omarchy-refresh-shell`; it resets your
`shell.json`.

**Remove:**

1. `omarchy plugin disable io.github.rsd.msi-mux`, and `omarchy plugin remove
   io.github.rsd.msi-mux` to delete the folder too.
2. If you ever picked Intel or RTX as the base GPU, delete the file the
   plugin writes and its two temporary names (the same command **Auto**
   runs), then log out and in:
   `cd ~/.config/uwsm/env.d && rm -f -- 90-msi-mux-gpu .90-msi-mux-gpu.tmp 90-msi-mux-gpu.new`

That pick is the plugin's only write. It runs `mkdir -p ~/.config/uwsm/env.d`
(the folder is uwsm's; leave it), removes `90-msi-mux-gpu.new` there (a
temporary file an earlier version could leave), writes the text to the
temporary file `.90-msi-mux-gpu.tmp` beside the env file and renames it over
`90-msi-mux-gpu` with `mv -fT`; on a failure it removes the temporary file.
Nothing else is written; after a pick, `90-msi-mux-gpu` is the only one of
these files left.
msi-mux-switch and its folder are yours to keep or delete (`yay -R` the
package if you installed it from the AUR).

## Backend setup

### 1. Install msi-mux-switch

From the AUR, either package:

```bash
yay -S msi-gpu-mux-switch-bin   # upstream's official prebuilt binary
yay -S msi-gpu-mux-switch       # built from source
```

Both install `/usr/bin/msi-mux-switch`, owned by root with mode 755: the file
itself already passes the ownership check below, so step 2 and **Set up
backend** are not needed. The `fuse.conf` and mount checks still apply to it.

Or build it yourself by following its own README (it is a Rust program), put
the binary in a folder of its own, `/opt/msi-mux-switch/msi-mux-switch`, and
make it root-owned with step 2.

Which binary the plugin uses:

1. the **msi-mux-switch path** setting, when it is set: only that path is
   checked, nothing else is looked for;
2. with the setting empty (the default), `/usr/bin/msi-mux-switch` when
   anything is there;
3. otherwise `/opt/msi-mux-switch/msi-mux-switch`.

If the **msi-mux-switch path** setting was saved with a path (for example the
old default, `/opt/msi-mux-switch/msi-mux-switch`), that path keeps winning;
clear the setting (leave it empty) to use the packaged `/usr/bin` binary.

Anything at `/usr/bin/msi-mux-switch` counts as there: a file of any owner,
a symlink (even a dangling one), a folder. If it fails the check, the plugin
refuses with its reason; it does not fall back to `/opt`. So does a check
that cannot tell whether anything is there. With neither present, the panel
says "msi-mux-switch was not found at /usr/bin/msi-mux-switch or
/opt/msi-mux-switch/msi-mux-switch."

### 2. Make it root-owned

The switch runs as root through `pkexec`, which is only safe if nobody but root
can change the binary. The plugin refuses to switch unless:

- the binary is a regular file (not a symlink), owned by root, not writable by
  group or others;
- **every directory above it**, up to `/`, is owned by root and not writable by
  group or others (a folder you can write lets you swap the binary for
  something that then runs as root);
- it is not under `/media`, `/mnt`, `/run/media` or `/run/user`, where a user
  can mount a disk or owns the files;
- `user_allow_other` is not turned on in `/etc/fuse.conf`. With it on, an
  account can mount a FUSE filesystem with `allow_other` over a folder it owns
  and report every file there as owned by root, which `stat` cannot tell apart
  from the real thing. A line counts as turning it on when its first word is
  `user_allow_other` (leading whitespace allowed, everything from a `#` on
  ignored). Comments and blank lines do not count, and a missing file counts as
  off. If the file exists but cannot be read (a symlink whose target cannot be
  reached included), is larger than 64 KiB or holds a NUL byte, the check
  refuses too, because it cannot tell. To fix it, comment out the
  `user_allow_other` line in `/etc/fuse.conf` as root, then reopen the panel;
- no mount at the binary's path or at any folder above it is a FUSE
  filesystem (`fuse`, `fuseblk`, `fuse.*`) or carries `user_id=` other than 0,
  as `/proc/self/mountinfo` lists it. A FUSE or user mount can report every
  file under it as owned by root. If mountinfo cannot be read, is larger than
  1 MiB or does not parse, the check refuses.

The check is one process: it reads `/etc/fuse.conf`, runs `stat`, reads
mountinfo, then runs `stat` again, and refuses if the two answers differ (a
FUSE daemon could unmount itself lazily while answering the first `stat`).
Every value reaches that process as a positional argument, never as part of
the script text.

The same check gates the plugin's automatic read-only `msi-mux-switch --debug
--json` read, which runs as you: a binary that fails it is never run, not even
for that read. The status read and the `pkexec` switch share one verdict, each
from a fresh read.

When the check refuses, at the status read or right before a switch, nothing
read earlier stays on screen. The header says "GPU mode unknown" with the
reason; no mode row shows a status; there is no lock line and no **Shut down
now**; the environment status is neutral. That covers a failed `stat` as well
as a failed mount check.

When the check fails, the panel shows the reason (for example
"/opt/msi-mux-switch/msi-mux-switch is owned by alice, not root.") and, for
an ownership or mode problem, a **Set up backend** button. The button never
appears for a path under `/usr/`, `/bin/` or `/sbin/`, folders the package
manager owns; use `/opt` or another folder of your own. For
`/usr/bin/msi-mux-switch` the file belongs to the package, so reinstall it (`yay -S msi-gpu-mux-switch-bin` or `yay -S msi-gpu-mux-switch`),
and the panel's reason says so for a wrong owner or mode. A mount refusal
(under a user-mount prefix, on a FUSE or user mount, a mount table that could
not be checked, or `user_allow_other` turned on or `/etc/fuse.conf` unchecked)
gets no such button: moving the binary, or for `user_allow_other` turning it
off, is the only fix.
**Set up backend** opens a terminal running the plugin's `setup.sh`,
which checks the binary, shows these commands (only for the binary and its own
folder), asks, runs them, and checks again. Use it only for a binary you built
yourself from source you trust: from then on, that binary runs as root whenever
you confirm a switch.

```bash
sudo chown -h root:root -- /opt/msi-mux-switch
sudo chmod 755 -- /opt/msi-mux-switch
sudo install -o root -g root -m 755 -- /opt/msi-mux-switch/msi-mux-switch /opt/msi-mux-switch/.msi-mux-switch.new
sudo mv -f -- /opt/msi-mux-switch/.msi-mux-switch.new /opt/msi-mux-switch/msi-mux-switch
```

The folder is made root-owned first so nothing in it can be swapped; the binary
is replaced by a fresh root-owned copy, never chowned in place (a process that
still had it open for writing could otherwise change it afterwards).

Before it asks, `setup.sh` opens the binary once, confirms the open file is the
same device and inode as the path, and records its SHA-256 through that
descriptor. After the folder is root-owned it checks the binary's owner, mode
and inode again. After `sudo install` makes the root-owned copy it hashes that
copy, and runs the `mv` only if the hashes match. If they differ, the binary
changed after it was checked: the script prints and runs
`sudo rm -f -- /opt/msi-mux-switch/.msi-mux-switch.new`, replaces nothing and
exits with an error. Every command is printed before it runs.

`setup.sh` refuses, and changes nothing, when:

- `/etc/fuse.conf` turns on `user_allow_other` (same rule and same parse as the
  plugin), or exists but cannot be read, is larger than 64 KiB or holds a NUL
  byte. The advice is to turn it off (comment out that line) and run setup
  again. This is checked first, before the mount check;
- the source binary is not a regular file, is a symbolic link, is not owned by
  you or root, or is writable by group or others;
- the binary's folder is your home, `/`, or directly under `/` or `/home`, or
  the binary is under `/media`, `/mnt`, `/run/media` or `/run/user`;
- the binary or a folder above it is on a FUSE mount (`fuse`, `fuseblk`,
  `fuse.*`) or a mount with `user_id=` other than 0, or `/proc/self/mountinfo`
  cannot be read or parsed. It runs the same stat, mountinfo, stat check as
  the plugin (the two stats with only the mountinfo read between them, parsed
  after the second stat), and refuses if the two stats differ;
- the folder is owned by someone other than you or root, has the sticky bit,
  is writable by group or others, or holds anything besides the binary
  (dotfiles included);
- a folder further up is not owned by root or is writable by group or others.

Where another account could already have changed the binary, `setup.sh` does
not fix anything in place. That means the binary or any folder above it is
writable by group or others or owned by another account, it is on a FUSE or
user mount, `user_allow_other` is on, or the binary changed while or after it
was checked (the stats differ, the open file is not the path's file, or the checksums differ). It
says to rebuild or re-download msi-mux-switch into a folder only you can write,
under folders owned by root and not writable by group or others, then run
setup again on that fresh file.

Never `chmod` such a file and retry. A file another account could write may
already hold that account's content, and a write descriptor it opened earlier
survives a `chmod`: it could keep writing afterwards. Only a fresh file in a
folder only you can write is known to hold only what you built.

For the other refusals (a folder of the wrong shape, for instance one that
holds other files), put the binary in a folder of its own. At the end,
`setup.sh` checks that the binary and every folder above it are owned by root,
writable by no one but root and on no FUSE or user mount. To run it by hand:

```bash
bash ~/.config/omarchy/plugins/io.github.rsd.msi-mux/setup.sh /opt/msi-mux-switch/msi-mux-switch
```

msi-mux-switch keeps a rollback record per switch; run under `pkexec`, it
lands in root's state directory (`/root/.local/state/msi-gpu-mux/backups`).

## Supported machines and the override flags

msi-mux-switch has its own table of characterized machines (exact model, board
and BIOS). At commit `223ca06`:

| Model | Board | BIOS |
|---|---|---|
| Vector 16 HX AI A2XWIG | MS-15M3 | E15M3IMS.116 |
| Stealth 16Studio A13VG | MS-15F2 | E15F2IMS.10F |

On any other machine the tool refuses, even to read state, unless given
`--allow-unsupported-hardware` (and, for a known model with another BIOS,
`--allow-unvalidated-bios`).

The plugin never passes those flags on its own judgment. It has a fixed
**allowlist** of exact combinations it has been used on, and passes both flags,
for reads and switches, only there:

| Model | Board | BIOS |
|---|---|---|
| Vector 16 HX AI A2XWIG | MS-15M3 | E15M3IMS.10E |

That entry is reported upstream as
[steelbrain/msi-gpu-mux-switch#2](https://github.com/steelbrain/msi-gpu-mux-switch/issues/2).
A machine in the tool's own table gets no flags; any other MSI machine is
greyed, naming its model, board and BIOS. No setting widens either table. The
values come from `/sys/class/dmi/id/`.

## Settings

In the bar's widget settings:

| Setting | Default | Meaning |
|---|---|---|
| **msi-mux-switch path** (`binaryPath`) | empty | Absolute path to the binary. Must not contain `..`. Empty: `/usr/bin/msi-mux-switch` when anything is there, else `/opt/msi-mux-switch/msi-mux-switch` (see [Install msi-mux-switch](#1-install-msi-mux-switch)). A path set here is always the one used. |
| **Warn about external screens before Integrated** (`warnBeforeIntegrated`) | on | Adds the external-screen warning to the Integrated confirmation. |

## What this does to your Hyprland config

The **Hyprland base GPU** dropdown is shown in every mode:

| Choice | Effect |
|---|---|
| **Auto** (default) | The plugin owns no file and leaves Hyprland alone. |
| **Intel** | Hyprland renders on the Intel GPU. |
| **RTX** | Hyprland renders on the RTX. Verified: aquamarine logs "gpu /dev/dri/card1 becomes primary drm", and Hyprland starts with all outputs up. |

Intel or RTX writes one file, through a temporary file beside it:

```
~/.config/uwsm/env.d/90-msi-mux-gpu
```

The write runs `mkdir -p ~/.config/uwsm/env.d`, removes
`~/.config/uwsm/env.d/90-msi-mux-gpu.new` (a temporary file an earlier version
could leave there, which uwsm would source), writes the text to
`.90-msi-mux-gpu.tmp` in the same folder (its leading dot keeps uwsm from
sourcing it) and renames that over the file with `mv -fT`. On a failure the
temporary file is removed.

uwsm sources every file in that folder with `sh` at login, before Hyprland
starts. This one sets `AQ_DRM_DEVICES`, which tells Hyprland's backend
(aquamarine) which GPU to use first. The plugin edits no other file: nothing
else in `~/.config/uwsm` or `~/.config/hypr` is read, changed, renamed or
touched.

For the **RTX** choice the file is exactly:

```sh
# Written by the MSI GPU MUX Omarchy plugin (io.github.rsd.msi-mux).
# msi-mux-base: rtx
#
# In MSHybrid mode, makes Hyprland composite on the RTX (NVIDIA) GPU: when both
# an Intel and an NVIDIA GPU are present, AQ_DRM_DEVICES lists that GPU
# first. With only one GPU present (Discrete or Integrated mode) it
# exports nothing. uwsm sources this file at login; it prints nothing.
#
# To remove the effect, pick Auto in the plugin, or delete this file and
# log out.

msi_mux_intel=
msi_mux_nvidia=
for msi_mux_card in /sys/class/drm/card*; do
  case ${msi_mux_card##*/} in
    *-*) continue ;;
  esac
  msi_mux_vendor=$(cat "$msi_mux_card/device/vendor" 2>/dev/null) || msi_mux_vendor=
  case $msi_mux_vendor in
    0x8086) [ -n "$msi_mux_intel" ] || msi_mux_intel=/dev/dri/${msi_mux_card##*/} ;;
    0x10de) [ -n "$msi_mux_nvidia" ] || msi_mux_nvidia=/dev/dri/${msi_mux_card##*/} ;;
  esac
done
if [ -n "$msi_mux_intel" ] && [ -n "$msi_mux_nvidia" ]; then
  export AQ_DRM_DEVICES="$msi_mux_nvidia:$msi_mux_intel"
fi
unset msi_mux_intel msi_mux_nvidia msi_mux_card msi_mux_vendor
```

For **Intel** it is the same, with `intel` in the marker line, "the Intel GPU"
in the comment and the two devices the other way round.

How it behaves:

- At login it finds the GPUs under `/sys/class/drm/card*` (skipping connector
  entries such as `card1-eDP-2`) by PCI vendor: `0x8086` is Intel, `0x10de` is
  NVIDIA. Card numbers change across boots and modes, so none are hard-coded.
- Only when **both** GPUs are present (MSHybrid) does it export
  `AQ_DRM_DEVICES=<base>:<other>`, for example
  `/dev/dri/card1:/dev/dri/card0`. In Discrete or Integrated one GPU is gone, so
  it exports nothing and Hyprland starts as usual.
- It prints nothing, never exits early and leaves no variable behind.
- It takes effect at the next login: **log out to apply**.
- Changing the MUX mode never touches it. Your choice is kept for the next time
  you are in MSHybrid and is inert in the other modes. Only picking **Auto**
  (or deleting the file) removes it.
- If the file was edited outside the plugin, the panel says so; picking an
  option replaces or removes it.

To remove it by hand:

```bash
rm ~/.config/uwsm/env.d/90-msi-mux-gpu
```

then log out and in. If a graphical login ever fails because of it, press
Ctrl+Alt+F2, log in on the text console and run the same `rm`.

## Troubleshooting

| What the panel shows | Meaning and fix |
|---|---|
| Greyed, "...is owned by ..., not root", "...writable by group or others", "...is a symbolic link" | The root-ownership check failed. Use **Set up backend**; it tells you to rebuild into a folder only you can write when another account could already have changed the file. For `/usr/bin/msi-mux-switch` there is no button: reinstall the `msi-gpu-mux-switch` (or `-bin`) package, or, with the path setting empty, remove whatever is at that name so the plugin uses `/opt`. |
| "GPU mode unknown" with "user_allow_other is turned on in /etc/fuse.conf. It lets other accounts fake root-owned folders, so the plugin cannot trust that msi-mux-switch is root's. Turn it off (comment out that line) to use the plugin." | `user_allow_other` is on in `/etc/fuse.conf`. Comment out that line as root, then reopen the panel. No **Set up backend** button. Running `setup.sh` refuses for the same reason until it is off. |
| "/etc/fuse.conf exists but could not be read, so the plugin cannot check that user_allow_other is off..." or "/etc/fuse.conf could not be checked for user_allow_other (it is too large or not plain text)." (or "...could not be checked for user_allow_other, which lets other accounts fake root-owned folders.") | The plugin could not read `/etc/fuse.conf` whole (unreadable, over 64 KiB, or a NUL byte in it, or the check did not finish), so it refuses. Make the file readable plain text under 64 KiB, make sure `user_allow_other` is off, then reopen the panel. If the file is a symlink, its target must be reachable. No **Set up backend** button. |
| "GPU mode unknown" with "...is on a fuse mount at ..., which another account may control." or "...is on a mount at ... owned by user_id ..." | A FUSE or user mount sits on the binary's path or a folder above it. Install the package (`/usr/bin/msi-mux-switch`) or move the binary to `/opt/msi-mux-switch`. No **Set up backend** button. |
| "...could not be checked: /proc/self/mountinfo could not be read." (or "...could not be parsed.", "...has no entry for /.") | The mount table could not be read whole (it is limited to 1 MiB), so the plugin refuses. Try again; if it persists, the table is unusual. No **Set up backend** button. |
| "... or a folder above it changed while it was being checked (stat gave two different answers)." | The binary or a folder above it changed between the two stats. Rebuild into a folder only you can write, then try again. |
| Greyed, "msi-mux-switch was not found at ..." | Install the binary (see [Install msi-mux-switch](#1-install-msi-mux-switch)), or fix the path setting. With the setting empty both places are named. |
| "Not an MSI machine": widget hidden | Expected. |
| Greyed, "...have not been tested on this machine (model, board, BIOS)" | Not in either table; switching stays off. |
| "Under /mnt" (or `/media`, `/run/media`, `/run/user`) | Install the package (`/usr/bin/msi-mux-switch`) or move the binary to `/opt/msi-mux-switch`. |
| "Connect AC power" / "On battery" | The firmware switch requires AC. Plug in; the buttons enable by themselves. |
| "Needs AC power (state unknown)" | The plugin could not find an AC supply under `/sys/class/power_supply`. |
| "Not offered by this firmware" | That mode is not available on this laptop. |
| "A switch is staged..." | A switch is waiting for a full shutdown (see [Switching](#switching)). Use **Shut down now**. |
| "The firmware still has a switch in progress. A full shutdown clears it." | The firmware's apply-ready flag is set with nothing staged, usually after a switch that failed and rolled back. msi-mux-switch refuses ("apply-ready is already set before any write") until a full shutdown. Use **Shut down now**. The plugin remembers this in the shell until the boot changes (see [Switching](#switching)); a shell restart forgets it, and the next switch attempt shows the refusal again. |
| "Authentication cancelled" / "Not authorized" | The polkit prompt was dismissed or refused. Nothing changed. |
| "msi-mux-switch is already running" | Another switch is in progress; wait for it. |
| "msi-mux-switch --debug did not answer within 10 s." / "...printed more than 1 MiB; not read." | The state read was stopped (it is limited to 10 s and 1 MiB). Check the binary path setting and run `msi-mux-switch --debug --json` by hand. |
| "The checks before the switch did not finish in time. Nothing was run." | The ownership, AC or running-process check did not end within 15 s. Try again. |
| The panel looks like an older version after an update | Run `omarchy-restart-shell`. |

## Opening the panel from the Omarchy menu

The plugin adds no menu entry. To add one, put this in
`~/.config/omarchy/extensions/omarchy-menu.jsonc` (an example; adjust it):

```jsonc
{
  "system.gpu-mux": {"icon":"󰢮","label":"GPU Mode","action":"omarchy-shell io.github.rsd.msi-mux open"}
}
```

## For reviewers

What the plugin runs and writes, and when:

- **As root**, only `pkexec --disable-internal-agent <binary> <mode> --json
  [flags]`, an argv array with no shell, after you confirm the mode in the
  switch dialog. Right before it, the binary and every folder above it are
  checked again, by the gate read below: root-owned, not writable by group or
  others, not a symlink, not under a user-mount prefix, on no FUSE or user
  mount, with `user_allow_other` off in `/etc/fuse.conf` (see
  [Make it root-owned](#2-make-it-root-owned)).
- **With sudo**, only `setup.sh`, opened in a visible terminal when you click
  **Set up backend**. It prints every command before it runs and asks before
  running the first. It refuses a source binary that is not a regular file, is
  a symlink, is not owned by you or root, or is writable by group or others;
  its folder must be owned by you or root and not writable by group or others,
  and every folder above it root-owned and not writable by group or others.
  After those checks it opens the binary once, confirms the open file is the
  same device and inode as the path, and records its SHA-256 through that
  descriptor. After the folder is made root-owned it rechecks the binary's
  owner, mode and inode. After `sudo install` makes the root-owned staged copy
  it hashes that copy and runs the `mv` only on a match; otherwise it prints
  and runs `sudo rm -f -- <staged>` and replaces nothing. It also runs the
  fuse.conf check and mount check (see below) before the first change, after
  the folder is made root-owned and at the end. At the end the binary and every folder above it
  must be owned by root, writable by no one but root and on no FUSE or user
  mount. Wherever another account could already have changed the binary
  (writable or foreign-owned binary or folder above it, a FUSE or user mount,
  a change while or after the check) it prints the same advice: rebuild or
  re-download msi-mux-switch into a folder only you can write, then run setup
  again. It never says to `chmod` and retry: the file may already hold another
  account's content, and a write descriptor opened earlier survives a `chmod`.
- **The gate read** (the status read and the switch use the same one): one
  `bash -c` process that reads `/etc/fuse.conf` (at most 64 KiB), runs `stat`
  on the binary and every folder above it, reads `/proc/self/mountinfo` (at
  most 1 MiB), and runs the same `stat` again. `/etc/fuse.conf` is read first,
  before the first `stat`, so the stat, mountinfo, stat window stays as narrow
  as it was. It is argv-only and size-capped, and it is sent back hex-encoded,
  so its text can never pass for a marker line or a `stat` line. The gate
  refuses when `user_allow_other` is on in it (kind "mount", the same verdict
  for the status read and the switch), when it exists but cannot be read
  (including a symlink whose target cannot be reached), is over 64 KiB or
  holds a NUL byte; a missing file counts as off. It also refuses when any
  mount at the binary's path or a folder above it (every such mount, not only
  the topmost) is `fuse`, `fuseblk` or `fuse.*` or carries `user_id=` other
  than 0, when mountinfo is unreadable, over 1 MiB, malformed or has no entry
  for `/`, or when the two `stat` answers differ. The paths and format are
  positional arguments; nothing but the size caps is part of the script text.
  Each gate decision uses a fresh read; the switch never reuses the status
  read's. The panel offers no **Set up backend** for a mount refusal, for
  `user_allow_other`, or for any path under `/usr/`, `/bin/` or `/sbin/`
  (package-managed system folders, `/usr/bin/msi-mux-switch` included).
- **Which binary is gated**: a path set in the settings, alone. With the
  setting empty, the status read gates `/usr/bin/msi-mux-switch` first, and
  gates `/opt/msi-mux-switch/msi-mux-switch` in a second run only when the
  first read finished whole, `stat` printed `/usr/bin`, `/usr` and `/` as
  root-owned directories searchable by others and printed nothing else, not
  even the binary (`stat` never follows a
  symlink, so a link there, dangling or not, counts as present). Any other
  answer keeps `/usr/bin` and its verdict; a refused `/usr/bin` binary is
  never skipped. The chosen path and its own gate read are taken together,
  so the binary the debug read runs is the one whose read just passed; a
  read started for an earlier setting, or overtaken by a newer read, is
  dropped. The switch gates that chosen path again right before `pkexec` and
  refuses if the chosen path changed meanwhile; it does not choose anew.
- **Residual risk**: a check that runs before `pkexec` cannot be atomic with
  the exec. The timing race this left open (an account with `user_allow_other`
  remounting within the ~1 ms between the mountinfo read and the second
  `stat`) is closed by refusing `user_allow_other` outright. With it off, an
  account other than root cannot make its FUSE mount traversable by this user
  or root, so such a mount makes `stat` fail and the gate refuses. What is left:
  only root can turn `user_allow_other` on or change `/etc/fuse.conf` (and root
  is already trusted), and the file is read once per gate read, before the
  `stat`s, so a change by root in that moment is not seen until the next read.
  The path checked is the standard `/etc/fuse.conf`. A `fusermount` built with
  another prefix (for example `/usr/local/etc/fuse.conf`) reads its own file,
  which is not checked.
- **Shutdown**: `omarchy-system shutdown` runs only from **Shut down now** in
  the shutdown confirmation dialog.
- **Files**: it writes only `~/.config/uwsm/env.d/90-msi-mux-gpu` and, for
  the moment of the write, its temporary file `.90-msi-mux-gpu.tmp` in the
  same folder, only when you pick Intel or RTX in the dropdown. That write
  runs `mkdir -p ~/.config/uwsm/env.d`, removes `90-msi-mux-gpu.new` there (a
  temporary file an earlier version could leave) and any leftover
  `.90-msi-mux-gpu.tmp`, writes the text to `.90-msi-mux-gpu.tmp` and renames
  it over the file with `mv -fT`; on a failure it removes the temporary file.
  Auto runs `rm -f --` on the file and those two temporary names.
- **As you**, read-only: the DMI strings under `/sys/class/dmi/id/`, `stat` of
  the binary and its folders, the AC state under `/sys/class/power_supply`,
  `pgrep -x msi-mux-switch`, the env file above, and `msi-mux-switch --debug
  --json`, under a 10 s timeout with each output stream capped at 1 MiB as it
  is read. That last read is gated by the same check as the switch (regular
  file, not a symlink, root-owned, not writable by group or others, every
  folder above it root-owned, not writable by group or others and not a
  symlink, not under a user-mount prefix, on no FUSE or user mount, with
  `user_allow_other` off), judged on
  the gate read taken just before each read. Also read, with each state read:
  `/proc/sys/kernel/random/boot_id`. A binary that fails the gate is never
  run: the panel shows why, the header says "GPU mode unknown", and no earlier
  reading stays on screen. That holds for any refusal (the `stat` or the mount
  check or the fuse.conf check, at the status read or at the switch): no mode row shows a status, there
  is no lock line or **Shut down now**, and the environment status is neutral.
- **Leftover firmware flag**: after a switch that failed, rolled back and
  left the apply-ready flag set with nothing staged, the shell remembers
  `{boot id, current mode, target mode}` in memory (never on disk). While it
  holds, the panel shows "The firmware still has a switch in progress. A full
  shutdown clears it." with **Shut down now** and no Switch buttons, as for a
  staged switch. It is dropped when the boot id changes or cannot be read,
  when a later status read shows a different current or target mode, or when
  the gate refuses. A shell restart forgets it; the next switch attempt shows
  the refusal again.
- **Switch output**: the switch's stdout and stderr are read in raw chunks
  and split into lines by the plugin, and no line it holds grows past
  65,537 characters: the rest of a longer line is dropped up to its next
  newline, and the line is then ignored as overlong. The switch itself has no
  timeout, because pkexec waits for you in its dialog. Two known differences
  from reading whole lines: a multibyte character split across a chunk
  boundary shows as U+FFFD in message text, with the JSON structure
  unaffected (the replacement can push a line right at the cap over it); and
  a line with more than about 65,000 leading whitespace characters changes
  the text quoted after "pkexec said".
- **Network**: none. The plugin makes no network request, and builds,
  bundles and downloads nothing.

## Tests

```bash
bash tests/run.sh
```

runs the manifest validation, QML lint and load checks, the widget live
against fake binaries (including the dialogs' keys and those of a panel that
reopened by itself, a flooding and a hanging binary, and a binary that fails
the ownership or mount check and must never be run, even for the debug read),
the model tests (including mountinfo and `fuse-conf-*` fixtures under
`tests/fixtures`: on, off, commented, indented, inline comment, CRLF, a near
miss and empty, plus missing, unreadable, oversize, NUL byte and symlink
cases), the env file sourced by `sh` against fixture trees, `setup.sh` against a
fake `sudo` (including its source-binary, mount and fuse.conf refusals and the
checksum mismatch path), and shellcheck. The live tests serve a fake
`/etc/fuse.conf` (off, then on), so they do not depend on this machine's. It never runs the real
msi-mux-switch, `pkexec`, `sudo` or a shutdown, and never writes under
`~/.config`.

## Licence

MIT, see [LICENSE](LICENSE). msi-mux-switch is a separate project under its own
MIT licence.
