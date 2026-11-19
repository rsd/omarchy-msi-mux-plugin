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
   prompt. This only **stages** the switch.
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
msi-mux-switch and its folder are yours to keep or delete.

## Backend setup

### 1. Install msi-mux-switch

Build it by following its own README (it is a Rust program) and put the binary
in a folder of its own. The plugin looks for
`/opt/msi-mux-switch/msi-mux-switch`; the **msi-mux-switch path** setting
changes that.

### 2. Make it root-owned

The switch runs as root through `pkexec`, which is only safe if nobody but root
can change the binary. The plugin refuses to switch unless:

- the binary is a regular file (not a symlink), owned by root, not writable by
  group or others;
- **every directory above it**, up to `/`, is owned by root and not writable by
  group or others (a folder you can write lets you swap the binary for
  something that then runs as root);
- it is not under `/media`, `/mnt`, `/run/media` or `/run/user`, where a user
  can mount a disk or owns the files.

When the check fails, the panel shows the reason (for example
"/opt/msi-mux-switch/msi-mux-switch is owned by alice, not root.") and a
**Set up backend** button. It opens a terminal running the plugin's `setup.sh`,
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

`setup.sh` refuses, and changes nothing, when:

- the binary's folder is your home, `/`, or directly under `/` or `/home`, or
  the binary is under `/media`, `/mnt`, `/run/media` or `/run/user`;
- the folder is owned by someone other than you or root, has the sticky bit,
  is writable by group or others, or holds anything besides the binary
  (dotfiles included);
- a folder further up fails the check.

Move the binary to a folder of its own instead. To run it by hand:

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
| **msi-mux-switch path** (`binaryPath`) | `/opt/msi-mux-switch/msi-mux-switch` | Absolute path to the binary. Must not contain `..`. |
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
| Greyed, "...is owned by ..., not root", "...writable by group or others", "...is a symbolic link" | The root-ownership check failed. Use **Set up backend**. |
| Greyed, "msi-mux-switch was not found at ..." | Install the binary, or fix the path setting. |
| "Not an MSI machine": widget hidden | Expected. |
| Greyed, "...have not been tested on this machine (model, board, BIOS)" | Not in either table; switching stays off. |
| "Under /mnt" (or `/media`, `/run/media`, `/run/user`) | Move the binary to a folder like `/opt/msi-mux-switch`. |
| "Connect AC power" / "On battery" | The firmware switch requires AC. Plug in; the buttons enable by themselves. |
| "Needs AC power (state unknown)" | The plugin could not find an AC supply under `/sys/class/power_supply`. |
| "Not offered by this firmware" | That mode is not available on this laptop. |
| "A switch is staged..." | A switch is waiting for a full shutdown (see [Switching](#switching)). Use **Shut down now**. |
| "The firmware still has a switch in progress. A full shutdown clears it." | The firmware's apply-ready flag is set with nothing staged, usually after a switch that failed and rolled back. msi-mux-switch refuses ("apply-ready is already set before any write") until a full shutdown. Use **Shut down now**. |
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
  checked again: root-owned, not writable by group or others, not a symlink,
  not under a user mount (see [Make it root-owned](#2-make-it-root-owned)).
- **With sudo**, only `setup.sh`, opened in a visible terminal when you click
  **Set up backend**. It shows its commands and asks before running any of
  them.
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
  is read.
- **Network**: none. The plugin makes no network request, and builds,
  bundles and downloads nothing.

## Tests

```bash
bash tests/run.sh
```

runs the manifest validation, QML lint and load checks, the widget live
against fake binaries (including the dialogs' keys and those of a panel that
reopened by itself, and a flooding and a hanging binary), the model tests, the env file sourced by `sh` against fixture
trees, `setup.sh` against a fake `sudo`, and shellcheck. It never runs the real
msi-mux-switch, `pkexec`, `sudo` or a shutdown, and never writes under
`~/.config`.

## Licence

MIT, see [LICENSE](LICENSE). msi-mux-switch is a separate project under its own
MIT licence.
