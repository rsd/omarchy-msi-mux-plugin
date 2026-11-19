#!/bin/bash

# Everything that can be checked without the running shell: manifest
# validation, QML syntax and type checks against the shell's own qs.Ui /
# qs.Commons modules, loading the widget in a throwaway Quickshell (skipped
# outside a Wayland session), the widget and its singleton live against a fake
# msi-mux-switch, the debug read's bounds (a flooding and a hanging fake) and
# the switch checks' watchdog live, the model logic, the debug read's command
# against the fakes, the env file sourced by sh against fixture trees,
# setup.sh against a fake sudo, and shellcheck over setup.sh, tests/*.sh and
# the fake binaries (with a self-test that it can fail).
#
# Nothing here runs the real msi-mux-switch, pkexec, sudo or a shutdown,
# touches the live shell, or writes under ~/.config: the scratch Quickshell
# runs with a temporary HOME and a fake binary, and is stopped by the PID this
# script started, never by name or pattern.

set -o pipefail

PLUGIN_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SHELL_DIR=${OMARCHY_SHELL_DIR:-/usr/share/omarchy/shell}
QMLLINT=/usr/lib/qt6/bin/qmllint
FAILURES=0

SKIPPED=0
SKIP=77   # a suite function returns this when it cannot run here

run() {
  local name=$1 status
  shift
  echo "== $name"
  "$@"
  status=$?
  if ((status == 0)); then
    echo "-- $name passed"
  elif ((status == SKIP)); then
    echo "-- $name SKIPPED (not checked)"
    SKIPPED=$((SKIPPED + 1))
  else
    echo "-- $name FAILED"
    FAILURES=$((FAILURES + 1))
  fi
  echo
}

validate() {
  if ! command -v omarchy-plugin-validate >/dev/null; then
    echo "skipped: omarchy-plugin-validate not found"
    return $SKIP
  fi
  omarchy-plugin-validate "$PLUGIN_DIR"
}

have_qt_lint() {
  [[ -x $QMLLINT && -d $SHELL_DIR/Ui && -d $SHELL_DIR/Commons ]]
}

skip_qt_lint() {
  echo "skipped: need $QMLLINT and the shell sources in $SHELL_DIR (OMARCHY_SHELL_DIR overrides)"
}

# Qt6's linter (/usr/bin/qmllint is Qt5's and rejects valid Qt6 QML) against
# a throwaway shim laid out as <root>/qs/Ui, built outside the plugin because a
# symlink inside a plugin folder is grounds for the shell to refuse it. Judged
# from --json by tests/qmllint-check.js. Fatal: a non-zero exit, any syntax /
# import / unresolved-type warning anywhere, and any other warning in a file
# other than BarWidget.qml except block-scope-var-declaration.
#
# qml_lint [dir] lints the *.qml in dir (default: the plugin).
qml_lint() {
  local dir=${1:-$PLUGIN_DIR}
  if ! have_qt_lint || ! command -v node >/dev/null; then
    skip_qt_lint
    return $SKIP
  fi

  local shim json status
  shim=$(mktemp -d) || return 1
  mkdir -p "$shim/qs"
  ln -s "$SHELL_DIR/Ui" "$shim/qs/Ui"
  ln -s "$SHELL_DIR/Commons" "$shim/qs/Commons"

  local files=("$dir"/*.qml)
  json=$("$QMLLINT" --json - -I "$shim" -I /usr/lib/qt6/qml "${files[@]}" 2>"$shim/stderr")
  status=$?
  if ((status != 0)); then
    head -10 "$shim/stderr"
    echo "qmllint exit status $status"
    rm -rf "$shim"
    return 1
  fi
  rm -rf "$shim"
  node "$PLUGIN_DIR/tests/qmllint-check.js" <<<"$json"
}

# The lint check must be able to fail: an unknown type injected into
# BarWidget.qml and then into MuxState.qml must each be caught, while the
# untouched copy passes.
qml_lint_selftest() {
  if ! have_qt_lint || ! command -v node >/dev/null; then
    skip_qt_lint
    return $SKIP
  fi

  local scratch ok=0 out case
  scratch=$(mktemp -d) || return 1
  for case in clean bar state; do
    mkdir "$scratch/$case"
    cp "$PLUGIN_DIR"/*.qml "$PLUGIN_DIR"/Model.js "$PLUGIN_DIR"/qmldir "$scratch/$case/"
  done
  if out=$(qml_lint "$scratch/clean"); then
    echo "ok   untouched copy passes"
  else
    echo "FAIL untouched copy should pass:"
    echo "$out"
    ok=1
  fi

  sed -i 's/^  BarIconButton {/  BarIconButtonX {/' "$scratch/bar/BarWidget.qml"
  sed -i 's/^  Timer {/  TimerX {/' "$scratch/state/MuxState.qml"
  if cmp -s "$PLUGIN_DIR/BarWidget.qml" "$scratch/bar/BarWidget.qml" ||
    cmp -s "$PLUGIN_DIR/MuxState.qml" "$scratch/state/MuxState.qml"; then
    echo "FAIL the self-test could not inject its unknown type (source changed?)"
    ok=1
  fi
  for case in bar state; do
    if out=$(qml_lint "$scratch/$case"); then
      echo "FAIL unknown type in the $case copy was not caught"
      ok=1
    elif ! grep -q 'X.*\[\(import\|unresolved-type\)\]' <<<"$out"; then
      echo "FAIL the $case copy failed, but not on its unknown type:"
      echo "$out"
      ok=1
    else
      echo "ok   unknown type in the $case copy fails: $(head -1 <<<"$out")"
    fi
  done
  rm -rf "$scratch"
  return $ok
}

# qmllint passes files the engine refuses, so load the widget the way the shell
# does, by absolute file:// URL, in a throwaway Quickshell (a temporary config:
# shell.qml plus symlinks to the shell's Commons and Ui, outside the plugin)
# that creates no windows, calls Qt.createComponent on BarWidget.qml (which
# pulls MuxState through the directory's qmldir), logs READY or ERROR and
# quits. Fatal: an ERROR, any qt.qml warning, no report, or no "done" line
# within LOAD_TIMEOUT_S.
LOAD_TIMEOUT_S=20

have_qs_load() {
  command -v qs >/dev/null && [[ -n ${WAYLAND_DISPLAY:-} && -d $SHELL_DIR/Ui && -d $SHELL_DIR/Commons ]]
}

skip_qs_load() {
  echo "skipped: need qs on PATH, a Wayland session (WAYLAND_DISPLAY) and the shell sources in $SHELL_DIR"
}

# scratch_qs <cfg dir> <marker> [env assignments...]: runs qs on cfg in the
# background, waits for "<marker> DONE" or the timeout, then stops it by PID.
scratch_qs() {
  local cfg=$1 marker=$2 pid i
  shift 2
  env "$@" qs --no-color -p "$cfg" >"$cfg/log" 2>&1 &
  pid=$!
  # A background job of a non-interactive shell ignores SIGINT: stop it here.
  trap 'kill "$pid" 2>/dev/null; rm -rf "$cfg"; exit 130' INT TERM
  for ((i = 0; i < LOAD_TIMEOUT_S * 10; i++)); do
    kill -0 "$pid" 2>/dev/null || break
    grep -sq "$marker DONE" "$cfg/log" && break
    sleep 0.1
  done
  for ((i = 0; i < 20; i++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    sleep 0.5
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  fi
  wait "$pid" 2>/dev/null
  trap - INT TERM
}

qml_load() {
  local dir=${1:-$PLUGIN_DIR}
  if ! have_qs_load; then
    skip_qs_load
    return $SKIP
  fi

  local cfg ok=0
  cfg=$(mktemp -d) || return 1
  ln -s "$SHELL_DIR/Commons" "$cfg/Commons"
  ln -s "$SHELL_DIR/Ui" "$cfg/Ui"
  cat >"$cfg/shell.qml" <<'EOF'
import QtQuick
import Quickshell
ShellRoot {
  Component.onCompleted: {
    var f = Quickshell.env("MM_LOAD_FILE")
    var url = "file://" + f.split("/").map(encodeURIComponent).join("/")
    var c = Qt.createComponent(url, Component.PreferSynchronous)
    var ready = c.status === Component.Ready
    console.log("MMLOAD " + (ready ? "READY " : "ERROR ") + f
      + (ready ? "" : " :: " + c.errorString().replace(/\n/g, " | ")))
    console.log("MMLOAD DONE")
    Qt.callLater(Qt.quit)
  }
}
EOF
  scratch_qs "$cfg" MMLOAD "MM_LOAD_FILE=$dir/BarWidget.qml"

  if ! grep -q 'MMLOAD DONE' "$cfg/log"; then
    echo "FAIL qs did not report within ${LOAD_TIMEOUT_S} s; its log:"
    tail -15 "$cfg/log"
    ok=1
  fi
  if grep -q 'WARN.*qt\.qml' "$cfg/log"; then
    grep 'WARN.*qt\.qml' "$cfg/log" | sed 's/^ *WARN */FAIL engine warning: /' | cut -c1-300
    ok=1
  fi
  if grep -qF "MMLOAD READY $dir/BarWidget.qml" "$cfg/log"; then
    echo "ok   BarWidget.qml loads (with MuxState.qml through qmldir)"
  elif grep -qF "MMLOAD ERROR $dir/BarWidget.qml" "$cfg/log"; then
    echo "FAIL BarWidget.qml: $(grep -F "MMLOAD ERROR" "$cfg/log" | sed 's/.* :: //' | cut -c1-400)"
    ok=1
  else
    echo "FAIL BarWidget.qml was not reported"
    ok=1
  fi
  rm -rf "$cfg"
  return $ok
}

# The load check must be able to fail: a copy whose BarWidget.qml declares a
# property twice and one whose MuxState.qml has a syntax error must both fail.
qml_load_selftest() {
  if ! have_qs_load; then
    skip_qs_load
    return $SKIP
  fi
  local scratch out ok=0 case
  scratch=$(mktemp -d) || return 1
  for case in dup state; do
    mkdir "$scratch/$case"
    cp "$PLUGIN_DIR"/*.qml "$PLUGIN_DIR"/Model.js "$PLUGIN_DIR"/qmldir "$scratch/$case/"
  done
  sed -i 's/^  property bool shutdownOffered: false$/&\n  property bool shutdownOffered: false/' "$scratch/dup/BarWidget.qml"
  sed -i 's/^  function readDmi() {$/  function readDmi() {{/' "$scratch/state/MuxState.qml"
  if cmp -s "$PLUGIN_DIR/BarWidget.qml" "$scratch/dup/BarWidget.qml" ||
    cmp -s "$PLUGIN_DIR/MuxState.qml" "$scratch/state/MuxState.qml"; then
    echo "FAIL the self-test could not inject its fault (source changed?)"
    rm -rf "$scratch"
    return 1
  fi
  for case in dup state; do
    if out=$(qml_load "$scratch/$case"); then
      echo "FAIL the $case fault was not caught"
      ok=1
    else
      echo "ok   the $case fault fails: $(grep FAIL <<<"$out" | head -1 | cut -c1-200)"
    fi
  done
  rm -rf "$scratch"
  return $ok
}

# The widget and its singleton running for real against a fake
# msi-mux-switch (tests/fixtures/fake-msi-mux-switch, which prints the
# fixture capture for --debug --json and refuses anything else), with a
# temporary HOME. A scratch Quickshell creates BarWidget.qml with the fake as
# its binaryPath setting (its panel is never opened, no switch is asked for,
# no env file is written), waits for the DMI read, the stat and the AC read
# (and a while longer, for a debug read that should not come), and reports
# them. The real DMI decides the hardware: on a machine that is not an MSI
# the widget must be hidden and nothing else is read. Checks that the
# singleton is the widget's (one instance), that the temporary binary fails
# the ownership gate (it is not root-owned) and is therefore never run, not
# even for the read-only debug read (the fake logs every run), that the
# panel shows the gate's reason, offers Set up backend and says the mode is
# unknown, and that no binding throws or the engine warns.
widget_live() {
  local dir=${1:-$PLUGIN_DIR}
  if ! have_qs_load; then
    skip_qs_load
    return $SKIP
  fi
  if [[ $dir == *[\"\\]* ]]; then
    echo "skipped: plugin path contains a quote or backslash"
    return $SKIP
  fi
  local cfg home bin ok=0 line
  cfg=$(mktemp -d) || return 1
  home=$cfg/home
  mkdir -p "$home" "$cfg/bin"
  bin=$cfg/bin/msi-mux-switch
  cp "$PLUGIN_DIR/tests/fixtures/fake-msi-mux-switch" "$bin"
  chmod 755 "$bin"
  ln -s "$SHELL_DIR/Commons" "$cfg/Commons"
  ln -s "$SHELL_DIR/Ui" "$cfg/Ui"
  cat >"$cfg/shell.qml" <<EOF
import QtQuick
import Quickshell
import "file://$dir" as Plugin
import "file://$dir/Model.js" as Model
ShellRoot {
  id: shell
  property var widget: null
  property bool reported: false
  Component.onCompleted: {
    var c = Qt.createComponent("file://$dir/BarWidget.qml", Component.PreferSynchronous)
    if (c.status !== Component.Ready) {
      console.log("MMLIVE ERROR " + c.errorString().replace(/\n/g, " | "))
      console.log("MMLIVE DONE")
      Qt.callLater(Qt.quit)
      return
    }
    shell.widget = c.createObject(shell, { settings: { binaryPath: "$bin" } })
    console.log("MMLIVE instance " + (typeof Plugin.MuxState.requestSwitch === "function")
      + " shared " + (Plugin.MuxState.attached.indexOf(shell.widget) !== -1))
  }
  Connections {
    target: Plugin.MuxState
    function onDebugChanged() { shell.maybeReport() }
    function onDmiReadChanged() { shell.maybeReport() }
    function onStatReadChanged() { shell.maybeReport() }
    function onAcChanged() { shell.maybeReport() }
  }
  function maybeReport() {
    var s = Plugin.MuxState
    if (!s.dmiRead) return
    if (s.hardware.state === "available" && !s.statRead) return
    // A refused binary: wait long enough to see a debug read start anyway.
    if (s.hardware.state === "available" && !s.ownership.ok) { settle.start(); return }
    if (s.hardware.state === "available" && (!s.debug.ok && s.debug.error === "")) return
    Qt.callLater(shell.report)
  }
  Timer { id: settle; interval: 1500; onTriggered: shell.report() }
  function report() {
    if (shell.reported) return
    shell.reported = true
    var s = Plugin.MuxState
    var w = shell.widget
    console.log("MMLIVE hardware " + s.hardware.state + " hidden " + s.hidden + " shown " + (w.implicitWidth > 0)
      + " path " + (s.binaryPath === "$bin") + " stat " + s.statRead + " kind " + s.ownership.kind
      + " available " + s.available + " debug " + s.debug.ok + " current " + s.debug.current
      + " modes " + s.debug.modes.join(",") + " rows " + w.rows.length + " env " + s.envChoice
      + " busy " + s.busy + " flags " + s.hardware.flags.join(","))
    console.log("MMLIVE ac " + (s.ac === true || s.ac === false || s.ac === null))
    console.log("MMLIVE panel reason " + (s.unavailableReason !== "" && s.unavailableReason === s.ownership.reason)
      + " setup " + s.canSetUp + " meta " + Model.summary(s.debug, s.debugBlocked))
    w.destroy()
    console.log("MMLIVE DONE")
    Qt.callLater(Qt.quit)
  }
  Timer { interval: 8000; running: true; onTriggered: shell.report() }
}
EOF
  scratch_qs "$cfg" MMLIVE "HOME=$home" "MM_FAKE_LOG=$cfg/fake.log" \
    "MM_FAKE_CAPTURE=$PLUGIN_DIR/tests/fixtures/debug-discrete.json"
  if ! grep -q 'MMLIVE instance true shared true' "$cfg/log"; then
    echo "FAIL the script's MuxState is not the widget's singleton instance:"
    grep 'MMLIVE' "$cfg/log" | head -3
    ok=1
  fi
  line=$(grep -o 'MMLIVE hardware.*' "$cfg/log" | head -1)
  if [[ $line =~ hardware\ hidden\ hidden\ true\ shown\ false ]]; then
    echo "ok   not an MSI machine here: the widget is hidden"
    if [[ -s $cfg/fake.log ]]; then
      echo "FAIL the fake binary ran on hidden hardware"
      ok=1
    fi
  elif [[ $line =~ hardware\ unavailable\ hidden\ false\ shown\ true ]]; then
    echo "ok   an MSI machine neither table lists: shown, unavailable"
    if [[ -s $cfg/fake.log ]]; then
      echo "FAIL the fake binary ran on unvalidated hardware"
      ok=1
    fi
  elif [[ $line =~ hardware\ available\ hidden\ false\ shown\ true\ path\ true\ stat\ true\ kind\ (owner|ancestor)\ available\ false\ debug\ false\ current\ \ modes\ \ rows\ 3\ env\ auto\ busy\ false\ flags ]]; then
    echo "ok   available hardware; the temporary binary fails the ownership gate (${BASH_REMATCH[1]})"
    echo "ok   no debug state: mode unread, three rows; no env file"
    if [[ -e $cfg/fake.log ]]; then
      echo "FAIL the refused fake binary was run: $(tr '\n' '|' <"$cfg/fake.log")"
      ok=1
    else
      echo "ok   the refused fake binary was never run, not even with --debug --json"
    fi
    if grep -q 'MMLIVE panel reason true setup true meta GPU mode unknown$' "$cfg/log"; then
      echo "ok   the panel shows the gate's reason, offers Set up backend, and the mode as unknown"
    else
      echo "FAIL panel: $(grep -o 'MMLIVE panel.*' "$cfg/log" | head -1)"
      ok=1
    fi
  else
    echo "FAIL report: ${line:-none}"
    tail -10 "$cfg/log"
    ok=1
  fi
  if grep -q 'MMLIVE ac true' "$cfg/log"; then
    echo "ok   AC read: true, false or unknown"
  else
    echo "FAIL AC: $(grep -o 'MMLIVE ac.*' "$cfg/log" | head -1)"
    ok=1
  fi
  if [[ -e $home/.config ]]; then
    echo "FAIL something was written under the temporary HOME's .config"
    ok=1
  fi
  if grep -q 'WARN.*qt\.qml\|TypeError\|ReferenceError\|MMLIVE ERROR' "$cfg/log"; then
    grep 'WARN.*qt\.qml\|TypeError\|ReferenceError\|MMLIVE ERROR' "$cfg/log" | head -5 | sed 's/^ */FAIL /' | cut -c1-300
    ok=1
  else
    echo "ok   no binding threw and the engine did not warn"
  fi
  rm -rf "$cfg"
  return $ok
}

# The switch and env-file flow for real, in a scratch Quickshell with a
# temporary HOME and PATH starting with fakes: `stat` (reports every path
# root-owned, mode 755, so the ownership gate passes), `pkexec` (checks
# --disable-internal-agent, logs its argv and runs the rest) and the fake
# msi-mux-switch with switching enabled. No real pkexec can be reached: with
# the real stat the temporary binary fails the gate before any pkexec runs.
# The singleton is driven directly, and the panel's window never maps (its
# visible binding is replaced first; any sign of mapping ends the run), so
# opening the panel only runs the widget's logic: MSHybrid and the
# leftover-flag switch are asked for by the widget with its panel closed, and
# the panel that reopens itself is key-inert (keys, the catcher's signals and
# the cursor change nothing, the focus is on its inert key item; during the
# focus prime neither a press nor a pointer position wakes it; after it a real
# pointer move wakes it and the keys work again, or Esc closes it). In each
# dialog, a hover under a resting pointer cannot select the confirm button,
# one after a real move can.
# Intel/RTX/Auto write and remove the env file under the temporary HOME;
# the base GPU dropdown is shown with Discrete current and with MSHybrid or
# Integrated pending; a second request while one runs is refused; MSHybrid
# is staged (the re-read shows it pending, the file stays, the panel offers
# no button and shows the lock line); a re-stage asked for directly while it
# is pending is refused by the tool and shown as the plain sentence, once,
# with nothing changed; the fake's state is reset (a full shutdown) and
# Integrated is staged and reset the same way (the RTX file is still there
# after the round trip); MSHybrid is staged with the fake printing a line of
# about 300 KB first and its success line without a "\n" (the long line is
# counted as unread, the events are all read, success; then reset); RTX
# then Auto while RTX is written ends in Auto (no file); a write that fails
# (env.d made read-only) shows the error and puts the widget's dropdown
# back on Auto, the state on disk; a write that fails
# with Auto queued behind it keeps its error shown after Auto succeeds; a
# removal that fails shows its error and puts the dropdown back on Intel; a
# switch while a process named msi-mux-switch runs (a copy of sleep) is
# refused before pkexec; a switch after the fake stat turns the binary
# foreign-owned is refused by its own stat before pkexec, and the earlier
# read is dropped (no mode, the read blocked, the header "GPU mode unknown").
# Skipped on hardware that is not available or on battery (the real AC is
# read).
switch_flow_live() {
  local dir=${1:-$PLUGIN_DIR}
  if ! have_qs_load; then
    skip_qs_load
    return $SKIP
  fi
  if [[ $dir == *[\"\\]* ]]; then
    echo "skipped: plugin path contains a quote or backslash"
    return $SKIP
  fi
  local cfg home bin fake ok=0 real_stat
  real_stat=$(command -v stat) || return 1
  cfg=$(mktemp -d) || return 1
  home=$cfg/home fake=$cfg/fakebin bin=$cfg/bin/msi-mux-switch
  mkdir -p "$home" "$fake" "$cfg/bin" "$cfg/run"
  cp "$PLUGIN_DIR/tests/fixtures/fake-msi-mux-switch" "$bin"
  cp "$(command -v sleep)" "$cfg/run/msi-mux-switch"
  chmod 755 "$bin"
  cat >"$fake/stat" <<EOF
#!/bin/bash
# Called as: stat -c <format> -- <paths...>; every path reads as root:root 755,
# or, once $cfg/stat.foreign exists, as owned by uid 1000.
[[ \$1 == -c && \$3 == -- ]] || exit 1
uid=0 user=root
[[ -e "$cfg/stat.foreign" ]] && uid=1000 user=someone
"$real_stat" -c '%u	%f	%U	%n' -- "\${@:4}" | while IFS=\$'\t' read -r _ raw _ name; do
  printf '%s\t%x\t%s\t%s\n' "\$uid" "\$(( (16#\$raw & 16#F000) | 8#755 ))" "\$user" "\$name"
done
EOF
  cat >"$fake/pkexec" <<EOF
#!/bin/bash
printf '%s\n' "\$*" >>"$cfg/pkexec.log"
[[ \$1 == --disable-internal-agent ]] || exit 127
shift
exec "\$@"
EOF
  # A stand-in for the shutdown command: the dialog checks below never
  # confirm a shutdown, and if one ever did, this would only log it.
  cat >"$fake/omarchy-system" <<EOF
#!/bin/bash
printf '%s\n' "\$*" >>"$cfg/shutdown.log"
EOF
  chmod 755 "$fake/stat" "$fake/pkexec" "$fake/omarchy-system"
  if [[ $(PATH="$fake:$PATH" command -v pkexec) != "$fake/pkexec" ||
    $(PATH="$fake:$PATH" command -v omarchy-system) != "$fake/omarchy-system" ]]; then
    echo "FAIL pkexec or omarchy-system does not resolve to the fake; not running"
    rm -rf "$cfg"
    return 1
  fi
  ln -s "$SHELL_DIR/Commons" "$cfg/Commons"
  ln -s "$SHELL_DIR/Ui" "$cfg/Ui"
  cat >"$cfg/shell.qml" <<EOF
import QtQuick
import Quickshell
import Quickshell.Io
import "file://$dir" as Plugin
import "file://$dir/Model.js" as Model
ShellRoot {
  id: shell
  QtObject { id: holder }
  property var widget: null
  property var panel: null
  property int step: 0
  property var outcome: null
  property int ticks: 0
  function log(s) { console.log("MMFLOW " + s) }
  function done() { shell.log("DONE"); shell.step = 99; Qt.callLater(Qt.quit) }
  Component.onCompleted: {
    var c = Qt.createComponent("file://$dir/BarWidget.qml", Component.PreferSynchronous)
    if (c.status !== Component.Ready) { shell.log("ERROR " + c.errorString()); shell.done(); return }
    shell.widget = c.createObject(shell, { settings: { binaryPath: "$bin" } })
    // The panel's window is never mapped: its visible binding is replaced
    // before anything opens the panel, so opening it only runs the widget's
    // logic (no window, no keyboard grab).
    var panels = shell.findAll(shell.widget, function(it) {
      return it.focusTarget !== undefined && it.backingWindowVisible !== undefined }, 0, [])
    if (panels.length !== 1) { shell.log("ERROR panel window not found"); shell.done(); return }
    shell.panel = panels[0]
    shell.panel.visible = false
  }
  // Any sign of the panel's window mapping ends the run at once.
  function unmapped() {
    if (!shell.panel || shell.panel.visible || shell.panel.backingWindowVisible) {
      if (shell.widget) shell.widget.close()
      shell.log("ERROR the panel window would map")
      shell.done()
      return false
    }
    return true
  }
  Connections {
    target: Plugin.MuxState
    function onSwitchFinished(owner, outcome) {
      shell.log("finished owner " + (owner === holder ? "holder" : owner === shell.widget ? "widget" : "other")
        + " kind " + outcome.kind + " offer " + outcome.offerShutdown
        + " warning " + (outcome.warning !== "") + " :: " + outcome.message)
      shell.outcome = outcome
    }
  }
  Timer {
    interval: 100
    repeat: true
    running: shell.step < 99
    onTriggered: {
      if (!shell.unmapped()) return
      var s = Plugin.MuxState
      if (shell.step === 0) {
        if (!s.dmiRead) return
        if (s.hardware.state !== "available") { shell.log("skip hardware " + s.hardware.state); shell.done(); return }
        if (!s.debug.ok || s.ac === null && !s.statRead) return
        if (s.ac !== true) { shell.log("skip ac " + s.ac); shell.done(); return }
        shell.log("ready ownership " + s.ownership.kind + " available " + s.available + " current " + s.debug.current
          + " pending " + s.debug.pending + " env " + s.envChoice)
        shell.logShown("discrete current")
        shell.logPanel("discrete current")
        shell.logSwitchKeys()
        s.setEnvChoice("rtx")
        shell.step = 1
      } else if (shell.step === 1) {
        if (s.envChoice !== "rtx") return
        shell.log("env rtx " + s.envChanged)
        // Asked for by the widget with its panel closed: the panel reopens
        // itself for the result.
        var first = s.requestSwitch(shell.widget, "mshybrid")
        var second = s.requestSwitch(holder, "integrated")
        shell.log("request " + first + " second " + second)
        shell.step = 2
      } else if (shell.step === 2) {
        if (!shell.outcome || s.busy || !s.debug.pending) return
        shell.logReopened("staged", "pointer")
        if (!shell.unmapped()) return
        shell.log("staged pending " + s.debug.pending + " target " + s.debug.target + " env " + s.envChoice)
        shell.logShown("mshybrid pending")
        shell.logPanel("mshybrid pending")
        shell.logLock("mshybrid pending")
        // The staged switch locks the mode: a direct re-stage reaches the
        // tool, which refuses it; the panel says so in plain words.
        shell.outcome = null
        shell.log("restage " + s.requestSwitch(holder, "integrated"))
        shell.step = 3
      } else if (shell.step === 3) {
        if (!shell.outcome || s.busy) return
        shell.log("restage refused pending " + s.debug.pending + " target " + s.debug.target)
        shell.logPanel("restage refused")
        // A full shutdown (the fake's staged target cleared): nothing pending.
        stateReset.running = true
        shell.step = 31
      } else if (shell.step === 31) {
        if (stateReset.running) return
        s.checkBinary()
        shell.step = 32
      } else if (shell.step === 32) {
        if (s.debug.pending) return
        // Read the file back: staging and the shutdown left it.
        shell.reads = 0
        s.rereadEnv()
        shell.step = 33
      } else if (shell.step === 33) {
        if (shell.reads === 0) return
        shell.log("after shutdown pending " + s.debug.pending + " env " + s.envChoice)
        // Integrated staged with RTX chosen: the file stays too.
        shell.outcome = null
        shell.log("integrated request " + s.requestSwitch(holder, "integrated"))
        shell.step = 34
      } else if (shell.step === 34) {
        if (!shell.outcome || s.busy || !s.debug.pending) return
        shell.reads = 0
        s.rereadEnv()
        shell.step = 35
      } else if (shell.step === 35) {
        if (shell.reads === 0) return
        shell.log("integrated pending " + s.debug.pending + " target " + s.debug.target + " env " + s.envChoice)
        shell.logShown("integrated pending")
        shell.logPanel("integrated pending")
        stateReset.running = true
        shell.step = 36
      } else if (shell.step === 36) {
        if (stateReset.running) return
        s.checkBinary()
        shell.step = 37
      } else if (shell.step === 37) {
        if (s.debug.pending) return
        shell.reads = 0
        s.rereadEnv()
        shell.step = 38
      } else if (shell.step === 38) {
        if (shell.reads === 0) return
        shell.log("round trip pending " + s.debug.pending + " env " + s.envChoice)
        // A switch whose output holds one line far over the reader's cap and
        // ends without a "\n": the long line is not read, the rest is.
        floodSet.running = true
        shell.step = 71
      } else if (shell.step === 71) {
        if (floodSet.running) return
        shell.outcome = null
        shell.log("flood request " + s.requestSwitch(holder, "mshybrid"))
        shell.step = 72
      } else if (shell.step === 72) {
        if (!shell.outcome || s.busy || !s.debug.pending) return
        var fr = s.switchRun
        shell.log("flood run other " + fr.other + " events " + fr.events.length + " last " + fr.events[fr.events.length - 1]
          + " errors " + fr.errors.length + " pending " + s.debug.pending + " target " + s.debug.target)
        floodReset.running = true
        shell.step = 73
      } else if (shell.step === 73) {
        if (floodReset.running) return
        s.checkBinary()
        shell.step = 74
      } else if (shell.step === 74) {
        if (s.debug.pending) return
        shell.log("flood reset pending " + s.debug.pending)
        // A leftover firmware flag (a failed switch rolled back): nothing
        // staged, Switch buttons shown, but the tool refuses.
        flagSet.running = true
        shell.step = 41
      } else if (shell.step === 41) {
        if (flagSet.running) return
        shell.logPanel("flag before")
        shell.logLock("flag before")
        shell.outcome = null
        shell.log("flag request " + s.requestSwitch(shell.widget, "integrated"))
        shell.step = 42
      } else if (shell.step === 42) {
        if (!shell.outcome || s.busy) return
        shell.logReopened("flag", "esc")
        if (!shell.unmapped()) return
        shell.log("flag refused pending " + s.debug.pending)
        shell.logPanel("flag refused")
        shell.logLock("flag refused")
        flagClear.running = true
        shell.step = 43
      } else if (shell.step === 43) {
        if (flagClear.running) return
        s.setEnvChoice("intel")
        shell.step = 4
      } else if (shell.step === 4) {
        if (s.envChoice !== "intel") return
        shell.log("env intel")
        s.setEnvChoice("auto")
        shell.step = 5
      } else if (shell.step === 5) {
        if (s.envChoice !== "auto" || s.envBusy) return
        shell.log("env auto")
        // RTX, then Auto while RTX is still being written: Auto wins.
        s.setEnvChoice("rtx")
        s.setEnvChoice("auto")
        shell.log("queued busy " + s.envBusy + " next " + s.envQueued)
        shell.step = 6
      } else if (shell.step === 6) {
        if (s.envBusy || s.envQueued !== "" || s.envChoice !== "auto") return
        shell.log("queue applied env " + s.envChoice)
        // A failed write (env.d read-only): the error is shown and the
        // dropdown goes back to what is on disk (no file: Auto), though
        // envChoice itself never changed.
        var dd = shell.findDropdown(shell.widget, 0)
        if (!dd) { shell.log("ERROR no env dropdown found"); shell.done(); return }
        envDirMode.command = ["chmod", "555", "--", "$home/.config/uwsm/env.d"]
        envDirMode.running = true
        shell.step = 7
      } else if (shell.step === 7) {
        if (envDirMode.running) return
        var d7 = shell.findDropdown(shell.widget, 0)
        shell.reads = 0
        d7.value = "intel"
        s.setEnvChoice("intel")
        shell.step = 8
      } else if (shell.step === 8) {
        if (s.envBusy || shell.reads === 0) return
        var d8 = shell.findDropdown(shell.widget, 0)
        shell.log("failed write env " + s.envChoice + " dropdown " + d8.value + " error " + (s.envError !== ""))
        // A failed write with a choice queued behind it: Intel fails (env.d
        // still read-only), the queued Auto then succeeds (nothing to
        // remove), and the Intel error is still shown after it.
        shell.reads = 0
        s.setEnvChoice("intel")
        s.setEnvChoice("auto")
        shell.log("failed with queue busy " + s.envBusy + " next " + s.envQueued + " error " + (s.envError !== ""))
        shell.step = 81
      } else if (shell.step === 81) {
        if (s.envBusy || s.envQueued !== "" || shell.reads === 0) return
        shell.log("queued after failure env " + s.envChoice + " :: " + s.envError)
        envDirMode.command = ["chmod", "755", "--", "$home/.config/uwsm/env.d"]
        envDirMode.running = true
        shell.step = 9
      } else if (shell.step === 9) {
        if (envDirMode.running) return
        // A failed removal: Intel on disk, env.d read-only, Auto picked. The
        // error is shown and the dropdown goes back to the file (Intel).
        s.setEnvChoice("intel")
        shell.step = 91
      } else if (shell.step === 91) {
        if (s.envBusy || s.envChoice !== "intel") return
        envDirMode.command = ["chmod", "555", "--", "$home/.config/uwsm/env.d"]
        envDirMode.running = true
        shell.step = 92
      } else if (shell.step === 92) {
        if (envDirMode.running) return
        var d92 = shell.findDropdown(shell.widget, 0)
        shell.reads = 0
        d92.value = "auto"
        s.setEnvChoice("auto")
        shell.step = 93
      } else if (shell.step === 93) {
        if (s.envBusy || shell.reads === 0) return
        var d93 = shell.findDropdown(shell.widget, 0)
        shell.log("failed remove env " + s.envChoice + " dropdown " + d93.value + " error " + (s.envError !== "")
          + " :: " + s.envError)
        envDirMode.command = ["chmod", "755", "--", "$home/.config/uwsm/env.d"]
        envDirMode.running = true
        shell.step = 94
      } else if (shell.step === 94) {
        if (envDirMode.running) return
        s.setEnvChoice("auto")
        shell.step = 95
      } else if (shell.step === 95) {
        if (s.envBusy || s.envChoice !== "auto" || s.envError !== "") return
        shell.log("removed after failure env auto")
        // An msi-mux-switch already running (a copy of sleep by that name):
        // the switch is refused before pkexec.
        blocker.running = true
        shell.step = 10
      } else if (shell.step === 10) {
        if (!blocker.running) return
        shell.outcome = null
        shell.log("blocked request " + s.requestSwitch(holder, "integrated"))
        shell.step = 11
      } else if (shell.step === 11) {
        if (!shell.outcome || s.busy) return
        blocker.running = false
        shell.ticks = 0
        shell.step = 12
      } else if (shell.step === 12) {
        // The re-read after that refusal settles; then the binary turns
        // foreign-owned before the next switch's own stat.
        if (!s.debug.ok || ++shell.ticks < 10) return
        shell.log("before foreign ok " + s.debug.ok + " blocked " + s.debugBlocked
          + " meta " + Model.summary(s.debug, s.debugBlocked))
        foreignSet.running = true
        shell.step = 13
      } else if (shell.step === 13) {
        if (foreignSet.running) return
        shell.outcome = null
        shell.log("foreign request " + s.requestSwitch(holder, "integrated"))
        shell.step = 14
      } else if (shell.step === 14) {
        if (!shell.outcome || s.busy) return
        shell.log("foreign refused ok " + s.debug.ok + " current '" + s.debug.current + "' blocked " + s.debugBlocked
          + " meta " + Model.summary(s.debug, s.debugBlocked))
        shell.widget.destroy()
        shell.done()
      }
    }
  }
  Process { id: blocker; command: ["$cfg/run/msi-mux-switch", "30"] }
  Process { id: envDirMode }
  Process { id: stateReset; command: ["rm", "-f", "--", "$cfg/state"] }
  Process { id: foreignSet; command: ["touch", "--", "$cfg/stat.foreign"] }
  Process { id: flagSet; command: ["touch", "--", "$cfg/state.apply-ready"] }
  Process { id: floodSet; command: ["touch", "--", "$cfg/state.flood"] }
  Process { id: floodReset; command: ["rm", "-f", "--", "$cfg/state", "$cfg/state.flood"] }
  Process { id: flagClear; command: ["rm", "-f", "--", "$cfg/state.apply-ready"] }
  // The lock line (its text, shown or not), its Shut down now button and
  // cursor stop; then the button is pressed through the cursor: the shutdown
  // dialog opens with its text and is dismissed (Later). Nothing shuts down.
  function logLock(when) {
    var w = shell.widget
    var btn = shell.findAll(w, function(it) { return it.key === "shutdown" && it.text === "Shut down now" }, 0, [])
    var texts = shell.findAll(w, function(it) { return it.text === w.lockNotice.text && it.wrapMode !== undefined }, 0, [])
    var line = "lockline " + when + " kind " + w.lockNotice.kind + " text " + (w.lockNotice.text !== ""
      && texts.filter(function(t) { return shell.shownSelf(t) }).length === 1)
      + " button " + (btn.length === 1 && shell.shownSelf(btn[0])) + " stop " + (w.cursorStops.indexOf("shutdown") !== -1)
    if (w.lockNotice.kind !== "") {
      w.pointAt("shutdown")
      w.activateCursor()
      var dlg = shell.findAll(w, function(it) { return it.confirmText === "Shut down now" && it.message !== undefined }, 0, [])
      line += " offered " + w.shutdownOffered + " dialog " + w.shutdownKind + " open " + (dlg.length === 1 && dlg[0].opened)
        + " :: " + (dlg.length === 1 ? dlg[0].message : "")
      if (dlg.length === 1 && dlg[0].opened)
        shell.log("shutdown keys " + when + " " + shell.tryKeys(w, dlg[0], function() { return w.shutdownOffered }))
      w.shutdownOffered = false
    }
    shell.log(line + " :: " + w.lockNotice.text)
  }
  // Keys sent to the widget's dialog key handler as an open dialog gets
  // them: stray text keys and Space first (nothing may change), then the
  // dialog's own keys; it is only ever activated on its cancel button, so
  // nothing is confirmed.
  function key(code, text) { return { key: code, text: text, modifiers: 0, accepted: false } }
  // Right after a dialog opened: the shell's ConfirmDialog selects the
  // button under the pointer on hover (selectedIndex = index, as its
  // onEntered does). A hover never selects the confirm button: not under a
  // resting pointer, not after jitter, not after a real pointer move (a
  // layout change can slide it under the pointer). The dialog's keys select
  // it and a hover over it keeps it; a hover over the safe button selects
  // that one, and a hover back over the confirm button does not.
  function tryHover(w, d) {
    d.selectedIndex = 1
    var rest = d.selectedIndex
    w.pointerAt(150, 150)
    w.pointerAt(151.5, 148.5)
    d.selectedIndex = 1
    var jitter = d.selectedIndex
    w.pointerAt(160, 150)
    d.selectedIndex = 1
    var moved = d.selectedIndex
    w.dialogKeyPressed(shell.key(Qt.Key_Right, ""))
    var keyed = d.selectedIndex
    d.selectedIndex = 1
    var kept = d.selectedIndex
    d.selectedIndex = 0
    var back = d.selectedIndex
    d.selectedIndex = 1
    return "hover rest " + rest + " jitter " + jitter + " moved " + moved + " keyed " + keyed + " kept " + kept
      + " back " + back + " again " + d.selectedIndex + " "
  }
  function tryKeys(w, d, isOpen) {
    var hover = shell.tryHover(w, d)
    var start = d.selectedIndex
    var stray = [[Qt.Key_H, "h"], [Qt.Key_L, "l"], [Qt.Key_Space, " "], [Qt.Key_E, "e"], [Qt.Key_O, "o"], [Qt.Key_J, "j"],
      [Qt.Key_K, "k"], [Qt.Key_X, "x"], [Qt.Key_Y, "y"], [Qt.Key_Up, ""], [Qt.Key_Down, ""], [Qt.Key_Space, " "], [Qt.Key_H, "H"]]
    var moved = 0, swallowed = 0
    for (var i = 0; i < stray.length; i++) {
      var e = shell.key(stray[i][0], stray[i][1])
      w.dialogKeyPressed(e)
      if (e.accepted) swallowed++
      if (d.selectedIndex !== start) moved++
    }
    var out = hover + "start " + start + " stray " + stray.length + " moved " + moved + " swallowed " + swallowed + " open " + (isOpen() && d.opened)
    var seq = []
    var toggles = [Qt.Key_Left, Qt.Key_Right, Qt.Key_Tab, Qt.Key_Backtab]
    for (var j = 0; j < toggles.length; j++) { w.dialogKeyPressed(shell.key(toggles[j], "")); seq.push(d.selectedIndex) }
    out += " toggles " + seq.join(",")
    if (d.selectedIndex === 0) {
      w.dialogKeyPressed(shell.key(Qt.Key_Return, ""))
      out += " enter-cancel closed " + !isOpen()
    } else {
      out += " ERROR not on cancel"
      w.dialogKeyPressed(shell.key(Qt.Key_Escape, ""))
    }
    return out
  }
  // The panel after it reopened itself for a finished switch (asked for by
  // the widget with the panel closed): key-inert, with the focus on its
  // inert key item and the catcher blocked. Every key a stray burst of typing
  // could hold (Space, Enter, Tab, arrows, j/k, h/l, the letters of "git
  // status", "git log") is sent the way the inert item gets it, and also as
  // the catcher's own signals; the cursor is pointed at the shutdown stop.
  // Nothing may change: no cursor, no dialog, no env write, no shutdown, the
  // panel still open. Then the deliberate action: "pointer" (a first pointer
  // sample and jitter do nothing, a real move wakes it; the catcher has the
  // focus and the keys work again: the cursor, the shutdown dialog with the
  // focus on its key item, Esc dismissing it; closing ends the state and a
  // user opening is not inert) or "esc" (Esc closes the panel).
  function logReopened(when, ending) {
    var w = shell.widget, p = shell.panel, s = Plugin.MuxState
    var kc = shell.findAll(w, function(it) { return it.blocked !== undefined && it.reorderable !== undefined }, 0, [])
    if (kc.length !== 1) { shell.log("reopened " + when + " ERROR no key catcher"); return }
    kc = kc[0]
    var target = p.focusTarget
    var env = s.envChoice
    var line = "reopened " + when + " open " + w.opened + " inert " + w.keysInert + " target " + w.keyTarget
      + " focus " + (target.parent === kc && target.focus === true && kc.focus === false) + " blocked " + kc.blocked
      + " offered " + w.shutdownOffered + " cursor " + w.cursorActive + " stops " + w.cursorStops.join(",")
    var keys = [[Qt.Key_Space, " "], [Qt.Key_Return, ""], [Qt.Key_Enter, ""], [Qt.Key_Tab, ""], [Qt.Key_Backtab, ""],
      [Qt.Key_Left, ""], [Qt.Key_Right, ""], [Qt.Key_Up, ""], [Qt.Key_Down, ""], [Qt.Key_J, "j"], [Qt.Key_K, "k"],
      [Qt.Key_H, "h"], [Qt.Key_L, "l"], [Qt.Key_Space, " "], [Qt.Key_Return, ""]]
    var typed = "git status\rgit log\t\r j j\r"
    for (var c = 0; c < typed.length; c++) {
      var ch = typed.charAt(c)
      keys.push(ch === "\r" ? [Qt.Key_Return, ""] : ch === "\t" ? [Qt.Key_Tab, ""] : ch === " " ? [Qt.Key_Space, " "]
        : [ch.toUpperCase().charCodeAt(0), ch])
    }
    var swallowed = 0
    for (var i = 0; i < keys.length; i++) {
      var e = shell.key(keys[i][0], keys[i][1])
      w.inertKeyPressed(e)
      if (e.accepted) swallowed++
      kc.activateRequested()
      kc.moveRequested(0, 1)
      kc.moveRequested(1, 0)
      kc.tabRequested(1)
      w.pointAt("shutdown")
    }
    line += " keys " + keys.length + " swallowed " + swallowed + " after open " + w.opened + " inert " + w.keysInert
      + " cursor " + w.cursorActive + " offered " + w.shutdownOffered + " confirm '" + w.confirmMode + "' dialog " + w.dialogOpen
      + " env " + (s.envChoice === env && !s.envBusy) + " busy " + s.busy
    if (ending === "esc") {
      w.inertKeyPressed(shell.key(Qt.Key_Escape, ""))
      line += " esc open " + w.opened + " inert " + w.keysInert
      shell.log(line)
      return
    }
    // The focus prime (the panel's first 75 ms; its window never maps here,
    // so it is ended by hand): a press reaches nothing and positions,
    // however far apart, neither wake the panel nor become the sample.
    var press = { accepted: false }
    w.inertPressed(press)
    w.pointerAt(20, 10)
    w.pointerAt(300, 200)
    line += " prime " + p.focusPrimed + " press swallowed " + press.accepted + " inert " + w.keysInert
      + " sample " + (w.pointerSample === null)
    p.focusPrimed = true
    w.pointerAt(200, 100)
    var afterSample = w.keysInert
    w.pointerAt(201.5, 98.5)
    var afterJitter = w.keysInert
    w.pointerAt(210, 100)
    line += " pointer sample " + afterSample + " jitter " + afterJitter + " moved " + w.keysInert + " target " + w.keyTarget
      + " focus " + (kc.focus === true && target.focus === false) + " blocked " + kc.blocked
    kc.activateRequested()
    line += " cursor " + w.cursorActive + " at " + w.cursorAt
    kc.activateRequested()
    var dialogTarget = p.focusTarget
    line += " offered " + w.shutdownOffered + " target " + w.keyTarget
      + " focus " + (dialogTarget !== target && dialogTarget.parent === kc && dialogTarget.focus === true)
    w.dialogKeyPressed(shell.key(Qt.Key_Escape, ""))
    line += " dismissed " + !w.shutdownOffered + " target " + w.keyTarget + " focus " + (kc.focus === true)
    w.close()
    line += " closed inert " + w.keysInert
    w.open()
    line += " user open inert " + w.keysInert + " target " + w.keyTarget
    w.close()
    shell.log(line)
  }
  // The switch dialog on a mode the panel offers: stray keys, its own keys,
  // Cancel; then opened again after a toggle and Esc: back on Cancel.
  function logSwitchKeys() {
    var w = shell.widget
    var row = w.rows.find(function(r) { return r.action === "switch" && r.enabled })
    if (!row) { shell.log("switch keys ERROR no row"); return }
    var dlg = shell.findAll(w, function(it) { return it.confirmText === "Switch" && it.message !== undefined }, 0, [])
    if (dlg.length !== 1) { shell.log("switch keys ERROR no dialog"); return }
    w.askSwitch(row)
    var line = shell.tryKeys(w, dlg[0], function() { return w.confirmMode !== "" })
    w.askSwitch(row)
    w.dialogKeyPressed(shell.key(Qt.Key_Left, ""))
    var toggled = dlg[0].selectedIndex
    w.dialogKeyPressed(shell.key(Qt.Key_Escape, ""))
    var escClosed = w.confirmMode === ""
    w.askSwitch(row)
    line += " esc closed " + escClosed + " after " + toggled + " reopened on " + dlg[0].selectedIndex
    // A new opening: a hover over Switch keeps Cancel.
    dlg[0].selectedIndex = 1
    line += " reopened hover " + dlg[0].selectedIndex
    w.confirmMode = ""
    shell.log("switch keys " + line + " busy " + Plugin.MuxState.busy)
    // The engine's key codes are the model's.
    shell.log("qt keys " + Model.dialogKeyAction(Qt.Key_Left) + Model.dialogKeyAction(Qt.Key_Right) + Model.dialogKeyAction(Qt.Key_Tab)
      + Model.dialogKeyAction(Qt.Key_Backtab) + Model.dialogKeyAction(Qt.Key_Return) + Model.dialogKeyAction(Qt.Key_Enter)
      + Model.dialogKeyAction(Qt.Key_Escape) + "|" + Model.dialogKeyAction(Qt.Key_Space) + Model.dialogKeyAction(Qt.Key_H)
      + Model.dialogKeyAction(Qt.Key_L) + "|")
  }
  // The widget's env dropdown, found by its label (it has no id outside).
  property int reads: 0
  // Whether the dropdown and every item above it up to the widget are
  // visible (the widget's own window is never shown here).
  function logShown(when) {
    var dd = shell.findDropdown(shell.widget, 0)
    var shown = dd !== null
    for (var it = dd; shown && it && it !== shell.widget; it = it.parent)
      if (it.visible === false && it.parent && it.parent.visible !== false) shown = false
    shell.log("dropdown " + when + " shown " + shown)
  }
  // The mode buttons shown, and whether the staged-lock sentence is shown
  // exactly once (same visibility rule as logShown).
  function shownSelf(item) {
    for (var it = item; it && it !== shell.widget; it = it.parent)
      if (it.visible === false && it.parent && it.parent.visible !== false) return false
    return true
  }
  function findAll(item, pred, depth, out) {
    if (!item || depth > 40) return out
    if (out.indexOf(item) === -1 && pred(item)) out.push(item)
    var kids = [].concat(item.children ? Array.from(item.children) : [], item.data ? Array.from(item.data) : [],
      item.contentItem ? [item.contentItem] : [])
    for (var i = 0; i < kids.length; i++)
      if (kids[i] !== item) shell.findAll(kids[i], pred, depth + 1, out)
    return out
  }
  function logPanel(when) {
    var buttons = shell.findAll(shell.widget, function(it) {
      return typeof it.key === "string" && it.key.indexOf("mode|") === 0 && it.text !== undefined }, 0, [])
    var shownButtons = buttons.filter(function(b) { return shell.shownSelf(b) })
    var lock = shell.findAll(shell.widget, function(it) {
      return it.text === "A switch is staged. It can't be changed or cancelled until after a full shutdown." }, 0, [])
    shell.log("panel " + when + " rows " + buttons.length + " buttons " + shownButtons.length
      + " [" + shownButtons.map(function(b) { return b.text }).join(",") + "] lock " + (lock.filter(function(t) { return shell.shownSelf(t) }).length === 1))
  }
  function findDropdown(item, depth) {
    if (!item || depth > 40) return null
    if (item.label === "Hyprland base GPU (MSHybrid)" && item.options !== undefined) return item
    var kids = [].concat(item.children ? Array.from(item.children) : [], item.data ? Array.from(item.data) : [],
      item.contentItem ? [item.contentItem] : [])
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] === item) continue
      var f = shell.findDropdown(kids[i], depth + 1)
      if (f) return f
    }
    return null
  }
  Connections {
    target: Plugin.MuxState
    function onEnvRead() { shell.reads++ }
  }
  Timer { interval: 20000; running: true; onTriggered: { shell.log("TIMEOUT step " + shell.step); shell.done() } }
}
EOF
  scratch_qs "$cfg" MMFLOW "HOME=$home" "PATH=$fake:$PATH" "MM_FAKE_SWITCH=1" "MM_FAKE_STATE=$cfg/state" \
    "MM_FAKE_LOG=$cfg/fake.log" "MM_FAKE_CAPTURE=$PLUGIN_DIR/tests/fixtures/debug-discrete.json"
  local log=$cfg/log
  if grep -q 'MMFLOW skip' "$log"; then
    echo "skipped: $(grep -o 'MMFLOW skip.*' "$log" | head -1 | cut -c8-)"
    rm -rf "$cfg"
    return $SKIP
  fi
  expect_flow() {
    if grep -qF -- "MMFLOW $1" "$log"; then echo "ok   $2"; else echo "FAIL $2 (no 'MMFLOW $1')"; ok=1; fi
  }
  expect_flow "ready ownership ok available true current discrete pending false env auto" "the gate passes through the fake stat; nothing pending, no env file"
  expect_flow "env rtx true" "RTX writes the plugin's exact text (read back as rtx)"
  expect_flow "request true second false" "a second switch while one runs is refused"
  expect_flow "finished owner widget kind success offer true warning false" "MSHybrid (asked for by the widget, its panel closed): success, the shutdown is offered"
  expect_flow "reopened staged open true inert true target inert focus true blocked true offered false cursor false stops shutdown,env keys 40 swallowed 40 after open true inert true cursor false offered false confirm '' dialog false env true busy false prime false press swallowed true inert true sample true pointer sample true jitter true moved false target panel focus true blocked false cursor true at shutdown offered true target dialog focus true dismissed true target panel focus true closed inert false user open inert false target panel" "the panel reopened itself key-inert after the staged switch: focus on the inert key item, catcher blocked, no shutdown dialog; Space, Enter, Tab, arrows, j/k, h/l and typed text change nothing (no cursor, no dialog, no env write); during the focus prime a press reaches nothing and pointer positions neither wake it nor become the sample; after it a first pointer sample and jitter keep it inert; a real move wakes it: the catcher has the focus, keys reach the cursor and the shutdown dialog (focus on its keys), Esc dismisses; closing ends the state; a user opening is not inert"
  expect_flow "staged pending true target mshybrid env rtx" "the re-read shows MSHybrid pending; the env file stays"
  expect_flow "panel discrete current rows 3 buttons 2 [Switch,Switch] lock false" "nothing staged: two Switch buttons, no lock line"
  expect_flow "panel mshybrid pending rows 3 buttons 0 [] lock true" "MSHybrid staged: no switch or cancel button; the lock line is shown"
  expect_flow "restage true" "a re-stage is asked for directly while MSHybrid is staged"
  expect_flow "finished owner holder kind error offer false warning false :: A switch is staged. It can't be changed or cancelled until after a full shutdown." "the tool's refusal is shown as the plain sentence"
  expect_flow "restage refused pending true target mshybrid" "the refusal changed nothing: MSHybrid stays staged"
  expect_flow "panel restage refused rows 3 buttons 0 [] lock true" "the refusal's sentence is shown once (the lock line steps aside)"
  expect_flow "dropdown discrete current shown true" "the base GPU dropdown is shown in Discrete (current, nothing pending)"
  expect_flow "dropdown mshybrid pending shown true" "the dropdown is shown with MSHybrid pending"
  expect_flow "after shutdown pending false env rtx" "after the shutdown nothing is pending; the env file (RTX) stays"
  expect_flow "integrated request true" "Integrated asked for with RTX chosen"
  expect_flow "integrated pending true target integrated env rtx" "Integrated staged: the env file stays"
  expect_flow "dropdown integrated pending shown true" "the dropdown is shown with Integrated pending"
  expect_flow "panel integrated pending rows 3 buttons 0 [] lock true" "Integrated staged: no button; the lock line is shown"
  expect_flow "round trip pending false env rtx" "after the round trip the RTX choice is still on disk"
  expect_flow "flood request true" "MSHybrid asked for with the fake printing a 300 KB line first"
  expect_flow "finished owner holder kind success offer true warning false :: MSHybrid is staged. It takes effect after a full shutdown." "the overlong line does not break the run: success, its last line (no newline) read at exit"
  expect_flow "flood run other 1 events 9 last success errors 0 pending true target mshybrid" "the 300 KB line is counted as one unread line, not an error event; the nine events are read, the unterminated success last"
  expect_flow "flood reset pending false" "after the flood run's shutdown nothing is pending"
  expect_flow "lockline mshybrid pending kind staged text true button true stop true offered true dialog staged open true :: The switch is staged. Shut down now to apply it?" "staged: Shut down now on the lock line, a cursor stop, opening the shutdown dialog"
  expect_flow "shutdown keys mshybrid pending hover rest 0 jitter 0 moved 0 keyed 1 kept 1 back 0 again 0 start 0 stray 13 moved 0 swallowed 13 open true toggles 1,0,1,0 enter-cancel closed true" "shutdown dialog: opens on Later; a hover never selects Shut down now (resting, jittering or after a real move); its keys select it and a hover over it keeps it; h, l, Space and other text keys change nothing and confirm nothing; arrows and Tab toggle; Enter on Later closes it"
  expect_flow "shutdown keys flag refused hover rest 0 jitter 0 moved 0 keyed 1 kept 1 back 0 again 0 start 0 stray 13 moved 0 swallowed 13 open true toggles 1,0,1,0 enter-cancel closed true" "the same for the leftover-flag shutdown dialog"
  expect_flow "switch keys hover rest 0 jitter 0 moved 0 keyed 1 kept 1 back 0 again 0 start 0 stray 13 moved 0 swallowed 13 open true toggles 1,0,1,0 enter-cancel closed true esc closed true after 1 reopened on 0 reopened hover 0 busy false" "switch dialog: opens on Cancel every time; a hover never selects Switch, even after a real move; its keys do; stray keys do nothing; Esc dismisses; no switch asked for"
  expect_flow "qt keys toggletoggletoggletoggleactivateactivateclose||" "the engine's Qt.Key codes are the model's: the dialog set acts, Space, h and l do not"
  expect_flow "panel flag before rows 3 buttons 2 [Switch,Switch] lock false" "a leftover firmware flag looks like nothing staged: two Switch buttons"
  expect_flow "lockline flag before kind  text false button false stop false :: " "no lock line before the refusal"
  expect_flow "flag request true" "a switch is asked for with the flag left set"
  expect_flow "finished owner widget kind error offer false warning false :: The firmware still has a switch in progress. A full shutdown clears it." "the refusal with nothing staged reads as the leftover flag"
  expect_flow "reopened flag open true inert true target inert focus true blocked true offered false cursor false stops mode|mshybrid,mode|integrated,shutdown,env keys 40 swallowed 40 after open true inert true cursor false offered false confirm '' dialog false env true busy false esc open false inert false" "after the refused switch the panel reopened key-inert: the keys reach neither the switch nor the shutdown dialog; Esc closes it"
  expect_flow "flag refused pending false" "nothing staged after the refusal"
  expect_flow "panel flag refused rows 3 buttons 2 [Switch,Switch] lock false" "the staged sentence is not shown for the leftover flag"
  expect_flow "lockline flag refused kind flag text true button true stop true offered true dialog flag open true :: The firmware still has a switch in progress. Shut down now to clear it?" "the leftover flag: its sentence once, Shut down now, a cursor stop, the shutdown dialog's own text"
  expect_flow "env intel" "Intel writes the plugin's exact text"
  expect_flow "env auto" "Auto removes it"
  expect_flow "queued busy true next auto" "Auto picked while RTX is written waits in the queue"
  expect_flow "queue applied env auto" "the queued Auto is applied after the write: no file"
  expect_flow "failed write env auto dropdown auto error true" "a failed write shows the error; the dropdown reverts to the file on disk (Auto)"
  expect_flow "failed with queue busy true next auto error false" "a fresh choice clears the earlier error; Auto picked while Intel is written waits"
  expect_flow "queued after failure env auto :: Could not write $home/.config/uwsm/env.d/90-msi-mux-gpu." "the failed write's error is still shown after the queued Auto finishes"
  expect_flow "failed remove env intel dropdown intel error true :: Could not remove $home/.config/uwsm/env.d/90-msi-mux-gpu." "a failed removal shows the error; the dropdown reverts to the file on disk (Intel)"
  expect_flow "removed after failure env auto" "Auto then removes it once env.d is writable again"
  expect_flow "blocked request true" "a switch is asked for while an msi-mux-switch runs"
  expect_flow "finished owner holder kind error offer false warning false :: msi-mux-switch is already running" "it is refused before pkexec"
  expect_flow "before foreign ok true blocked false meta Current: Discrete" "after that refusal the mode is read again (Discrete)"
  expect_flow "foreign request true" "a switch is asked for after the binary turned foreign-owned"
  expect_flow "foreign refused ok false current '' blocked true meta GPU mode unknown" "the switch's own stat refuses the binary before pkexec and drops the earlier read: no mode, the read blocked, the header says the mode is unknown"
  # The flags are the ones the debug read got (the hardware's).
  local flags want_pk
  flags=$(sed -n '1s/^--debug --json//p' "$cfg/fake.log" 2>/dev/null)
  want_pk=$(printf '%s\n' "--disable-internal-agent $bin mshybrid --json$flags" "--disable-internal-agent $bin integrated --json$flags" \
    "--disable-internal-agent $bin integrated --json$flags" "--disable-internal-agent $bin mshybrid --json$flags" \
    "--disable-internal-agent $bin integrated --json$flags")
  if [[ -e $cfg/shutdown.log ]]; then
    echo "FAIL the shutdown command was run: $(tr '\n' '|' <"$cfg/shutdown.log")"
    ok=1
  else
    echo "ok   the shutdown command never ran"
  fi
  if [[ $(cat "$cfg/pkexec.log" 2>/dev/null) == "$want_pk" ]]; then
    echo "ok   pkexec ran five times (the refused re-stage, the flood run and the leftover-flag refusal included), with exactly the argv arrays expected"
  else
    echo "FAIL pkexec log: $(tr '\n' '|' <"$cfg/pkexec.log" 2>/dev/null)"
    ok=1
  fi
  if [[ -e $home/.config/uwsm/env.d/90-msi-mux-gpu ]] || [[ -n $(find "$home" -mindepth 1 ! -path "$home/.config" ! -path "$home/.config/uwsm" ! -path "$home/.config/uwsm/env.d" ! -path "$home/.cache*" ! -path "$home/.local*" -print -quit) ]]; then
    echo "FAIL files left in the temporary HOME: $(find "$home" -mindepth 1 ! -path "$home/.cache*" ! -path "$home/.local*" | tr '\n' ' ')"
    ok=1
  else
    echo "ok   the temporary HOME holds only the (now empty) ~/.config/uwsm/env.d"
  fi
  if grep -q 'MMFLOW TIMEOUT\|MMFLOW ERROR\|WARN.*qt\.qml\|TypeError\|ReferenceError' "$log"; then
    grep 'MMFLOW TIMEOUT\|MMFLOW ERROR\|WARN.*qt\.qml\|TypeError\|ReferenceError' "$log" | head -5 | sed 's/^ */FAIL /' | cut -c1-300
    ok=1
  fi
  ((ok)) && grep 'MMFLOW' "$log" | sed 's/^ */     | /' | cut -c1-300
  rm -rf "$cfg"
  return $ok
}

# The debug read's bounds and the switch checks' watchdog for real, in a
# scratch Quickshell with a temporary HOME and PATH starting with fakes:
# `stat` (root-owned, so the gate passes), `pkexec` and `omarchy-system`
# (logging; neither may run) and `pgrep` (logs, then hangs). The binary runs
# one of the fixtures, picked by a file: the plain fake (ready), the flooding
# fake (the read ends at the cap within moments and reads as an error), the
# plain fake again, then the hanging fake with a switch asked for while its
# read runs: the read ends on its timeout (TERM ignored, then KILL), the hung
# pgrep that follows holds the check, and the watchdog refuses the switch
# after Model.CHECK_TIMEOUT_MS: the phase returns to "" and nothing ran. A
# switch asked for right then, while the stopped checks are still ending, is
# refused with Model.CHECKS_ENDING_TEXT.
# Skipped on hardware that is not available or on battery (the real AC is
# read).
debug_bounds_live() {
  local dir=${1:-$PLUGIN_DIR}
  if ! have_qs_load; then
    skip_qs_load
    return $SKIP
  fi
  if [[ $dir == *[\"\\]* ]]; then
    echo "skipped: plugin path contains a quote or backslash"
    return $SKIP
  fi
  local cfg home bin fake ok=0 real_stat f log watchdog_text ending_text
  # The flow lasts about CHECK_TIMEOUT_MS after startup.
  local LOAD_TIMEOUT_S=45
  real_stat=$(command -v stat) || return 1
  watchdog_text=$(node -e 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8").match(/var CHECK_TIMEOUT_TEXT = "([^"]*)"/)[1])' \
    "$PLUGIN_DIR/Model.js") || return 1
  ending_text=$(node -e 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8").match(/var CHECKS_ENDING_TEXT = "([^"]*)"/)[1])' \
    "$PLUGIN_DIR/Model.js") || return 1
  cfg=$(mktemp -d) || return 1
  home=$cfg/home fake=$cfg/fakebin bin=$cfg/bin/msi-mux-switch log=$cfg/log
  mkdir -p "$home" "$fake" "$cfg/bin" "$cfg/fx"
  for f in fake-msi-mux-switch fake-msi-mux-switch-flood fake-msi-mux-switch-hang; do
    cp "$PLUGIN_DIR/tests/fixtures/$f" "$cfg/fx/$f"
    printf '%s' "$f" >"$cfg/mode${f#fake-msi-mux-switch}"
  done
  chmod 755 "$cfg/fx/fake-msi-mux-switch" "$cfg/fx/fake-msi-mux-switch-flood" "$cfg/fx/fake-msi-mux-switch-hang"
  cp "$cfg/mode" "$cfg/mode-plain"
  cat >"$bin" <<END_BIN
#!/bin/bash
exec "$cfg/fx/\$(cat "$cfg/mode")" "\$@"
END_BIN
  cat >"$fake/stat" <<END_STAT
#!/bin/bash
[[ \$1 == -c && \$3 == -- ]] || exit 1
"$real_stat" -c '%u	%f	%U	%n' -- "\${@:4}" | while IFS=\$'\t' read -r _ raw _ name; do
  printf '0\t%x\troot\t%s\n' "\$(( (16#\$raw & 16#F000) | 8#755 ))" "\$name"
done
END_STAT
  cat >"$fake/pkexec" <<END_PKEXEC
#!/bin/bash
printf '%s\n' "\$*" >>"$cfg/pkexec.log"
exit 127
END_PKEXEC
  cat >"$fake/omarchy-system" <<END_SYSTEM
#!/bin/bash
printf '%s\n' "\$*" >>"$cfg/shutdown.log"
END_SYSTEM
  cat >"$fake/pgrep" <<END_PGREP
#!/bin/bash
printf '%s\n' "\$*" >>"$cfg/pgrep.log"
# Hangs, and on the watchdog's TERM takes a moment to end (a stopped check
# still ending); pgrep.term records the TERM and the end.
trap 'kill "\$c" 2>/dev/null; printf "term\n" >>"$cfg/pgrep.term"; sleep 1.5; printf "ended\n" >>"$cfg/pgrep.term"; exit 143' TERM
sleep 60 &
c=\$!
wait "\$c"
END_PGREP
  chmod 755 "$bin" "$fake/stat" "$fake/pkexec" "$fake/omarchy-system" "$fake/pgrep"
  if [[ $(PATH="$fake:$PATH" command -v pkexec) != "$fake/pkexec" ||
    $(PATH="$fake:$PATH" command -v omarchy-system) != "$fake/omarchy-system" ||
    $(PATH="$fake:$PATH" command -v pgrep) != "$fake/pgrep" ]]; then
    echo "FAIL a fake does not resolve first on PATH; not running"
    rm -rf "$cfg"
    return 1
  fi
  ln -s "$SHELL_DIR/Commons" "$cfg/Commons"
  ln -s "$SHELL_DIR/Ui" "$cfg/Ui"
  cat >"$cfg/shell.qml" <<END_QML
import QtQuick
import Quickshell
import Quickshell.Io
import "file://$dir" as Plugin
import "file://$dir/Model.js" as Model
ShellRoot {
  id: shell
  QtObject { id: holder }
  property var widget: null
  property int step: 0
  property int reads: 0
  property real t0: 0
  property real asked: 0
  property var outcome: null
  function log(s) { console.log("MMBOUND " + s) }
  function done() { shell.log("DONE"); shell.step = 99; Qt.callLater(Qt.quit) }
  function ms(t) { return Math.round(Date.now() - t) }
  Component.onCompleted: {
    var c = Qt.createComponent("file://$dir/BarWidget.qml", Component.PreferSynchronous)
    if (c.status !== Component.Ready) { shell.log("ERROR " + c.errorString()); shell.done(); return }
    shell.widget = c.createObject(shell, { settings: { binaryPath: "$bin" } })
  }
  Connections {
    target: Plugin.MuxState
    function onDebugChanged() { shell.reads++ }
    // The watchdog's refusal: once its handler is over (the checks told
    // to stop, the fake pgrep still ending on its TERM), a switch asked for
    // is refused with a reason the panel shows, not dropped in silence.
    function onSwitchFinished(owner, outcome) {
      if (shell.retrying) { shell.retryOutcome = outcome; return }
      shell.outcome = outcome
      if (shell.step < 5 || shell.retried) return
      shell.retried = true
      Qt.callLater(shell.retry)
    }
  }
  property int runs: 0
  property bool retried: false
  property bool retrying: false
  property var retryOutcome: null
  property real retriedAt: 0
  function retry() {
    shell.retrying = true
    var r = Plugin.MuxState.requestSwitch(holder, "mshybrid")
    shell.retrying = false
    shell.retriedAt = Date.now()
    shell.log("retry request " + r + " phase '" + Plugin.MuxState.phase + "' :: "
      + (shell.retryOutcome ? shell.retryOutcome.kind + " " + shell.retryOutcome.message : "nothing shown"))
  }
  Process { id: pick }
  function use(mode) { pick.command = ["cp", "--", "$cfg/mode" + mode, "$cfg/mode"]; pick.running = true }
  Timer {
    interval: 50
    repeat: true
    running: shell.step < 99
    onTriggered: {
      var s = Plugin.MuxState
      if (shell.step === 0) {
        if (!s.dmiRead) return
        if (s.hardware.state !== "available") { shell.log("skip hardware " + s.hardware.state); shell.done(); return }
        if (!s.debug.ok || s.ac === null) return
        if (s.ac !== true) { shell.log("skip ac " + s.ac); shell.done(); return }
        shell.log("ready available " + s.available + " current " + s.debug.current)
        shell.use("-flood")
        shell.step = 1
      } else if (shell.step === 1) {
        if (pick.running) return
        shell.reads = 0
        shell.t0 = Date.now()
        s.checkBinary()
        shell.step = 2
      } else if (shell.step === 2) {
        if (shell.reads === 0) return
        shell.log("flood ok " + s.debug.ok + " fast " + (shell.ms(shell.t0) < 5000) + " :: " + s.debug.error)
        shell.use("-plain")
        shell.step = 3
      } else if (shell.step === 3) {
        if (pick.running) return
        shell.reads = 0
        s.checkBinary()
        shell.step = 4
      } else if (shell.step === 4) {
        if (shell.reads === 0) return
        shell.log("plain again ok " + s.debug.ok)
        shell.use("-hang")
        shell.step = 5
      } else if (shell.step === 5) {
        if (pick.running) return
        shell.reads = 0
        shell.t0 = Date.now()
        // A debug read follows its own stat: wait for it to start.
        shell.runs = s.debugRuns
        s.checkBinary()
        shell.step = 51
      } else if (shell.step === 51) {
        if (s.debugRuns === shell.runs) return
        shell.asked = Date.now()
        shell.log("hang request " + s.requestSwitch(holder, "mshybrid") + " phase " + s.phase)
        shell.step = 6
      } else if (shell.step === 6) {
        if (shell.reads === 0) return
        var ht = shell.ms(shell.t0)
        shell.log("hang ended ok " + s.debug.ok + " in time " + (ht >= (Model.DEBUG_TIMEOUT_S - 1) * 1000
          && ht < (Model.DEBUG_TIMEOUT_S + Model.DEBUG_KILL_AFTER_S + 3) * 1000)
          + " phase " + s.phase + " busy " + s.busy + " :: " + s.debug.error)
        shell.step = 7
      } else if (shell.step === 7) {
        if (!shell.outcome) return
        shell.log("watchdog kind " + shell.outcome.kind + " offer " + shell.outcome.offerShutdown
          + " after " + (shell.ms(shell.asked) >= Model.CHECK_TIMEOUT_MS - 200)
          + " phase '" + s.phase + "' busy " + s.busy + " :: " + shell.outcome.message)
        shell.step = 8
      } else if (shell.step === 8) {
        // The stopped pgrep's end (pgrep.term) is awaited before quitting.
        if (shell.retriedAt === 0 || Date.now() - shell.retriedAt < 3000) return
        shell.widget.destroy()
        shell.done()
      }
    }
  }
  Timer { interval: 40000; running: true; onTriggered: { shell.log("TIMEOUT step " + shell.step); shell.done() } }
}
END_QML
  scratch_qs "$cfg" MMBOUND "HOME=$home" "PATH=$fake:$PATH" "MM_FAKE_LOG=$cfg/fake.log" \
    "MM_FAKE_CAPTURE=$PLUGIN_DIR/tests/fixtures/debug-discrete.json"
  if grep -q 'MMBOUND skip' "$log"; then
    echo "skipped: $(grep -o 'MMBOUND skip.*' "$log" | head -1 | cut -c9-)"
    rm -rf "$cfg"
    return $SKIP
  fi
  expect_bound() {
    if grep -qF -- "MMBOUND $1" "$log"; then echo "ok   $2"; else echo "FAIL $2 (no 'MMBOUND $1')"; ok=1; fi
  }
  expect_bound "ready available true current discrete" "the plain fake reads; the gate passes through the fake stat"
  expect_bound "flood ok false fast true :: msi-mux-switch --debug printed more than 1 MiB; not read." \
    "a flooding binary is cut at the cap within moments and read as an error"
  expect_bound "plain again ok true" "the plain fake reads again afterwards"
  expect_bound "hang request true phase checking" "a switch is asked for while a hanging debug read runs"
  expect_bound "hang ended ok false in time true phase checking busy true :: msi-mux-switch --debug did not answer within 10 s." \
    "the hanging read ends on its timeout (TERM ignored, then KILL) and says so; the switch is still being checked"
  expect_bound "watchdog kind error offer false after true phase '' busy false :: $watchdog_text" \
    "the hung pgrep holds the check; the watchdog refuses the switch and the phase returns to \"\""
  expect_bound "retry request false phase '' :: error $ending_text" \
    "a switch asked for while the stopped checks are still ending is refused with a visible reason, not dropped"
  if [[ $(tr '\n' '|' <"$cfg/pgrep.term" 2>/dev/null) == "term|ended|" ]]; then
    echo "ok   the watchdog stopped the hung pgrep (TERM), which then took a moment to end"
  else
    echo "FAIL pgrep.term: $(tr '\n' '|' <"$cfg/pgrep.term" 2>/dev/null)"
    ok=1
  fi
  if [[ $(cat "$cfg/pgrep.log" 2>/dev/null) == "-x msi-mux-switch" ]]; then
    echo "ok   pgrep was started once, after the debug read ended"
  else
    echo "FAIL pgrep log: $(tr '\n' '|' <"$cfg/pgrep.log" 2>/dev/null)"
    ok=1
  fi
  if [[ -e $cfg/pkexec.log || -e $cfg/shutdown.log ]]; then
    echo "FAIL pkexec or the shutdown command ran"
    ok=1
  else
    echo "ok   neither pkexec nor the shutdown command ran"
  fi
  if [[ -n $cfg && -d $cfg/fx ]] && pgrep -f -- "$cfg/fx/fake-" >/dev/null; then
    echo "FAIL a fake binary is still running: $(pgrep -af -- "$cfg/fx/fake-" | head -3 | tr '\n' '|')"
    ok=1
  fi
  if grep -q 'MMBOUND TIMEOUT\|MMBOUND ERROR\|WARN.*qt\.qml\|TypeError\|ReferenceError' "$log"; then
    grep 'MMBOUND TIMEOUT\|MMBOUND ERROR\|WARN.*qt\.qml\|TypeError\|ReferenceError' "$log" | head -5 | sed 's/^ */FAIL /' | cut -c1-300
    ok=1
  fi
  ((ok)) && grep 'MMBOUND' "$log" | sed 's/^ */     | /' | cut -c1-300
  rm -rf "$cfg"
  return $ok
}

node_suite() {
  if ! command -v node >/dev/null; then
    echo "skipped: node not found"
    return $SKIP
  fi
  node "$@"
}

# Finds a working shellcheck and sets SHELLCHECK_BIN: $SHELLCHECK if set, else
# `shellcheck` on PATH, else the newest mise install. A candidate counts only if
# `--version` exits 0 (a mise shim with no version set is on PATH and fails).
# Returns 1, with what was tried on stdout, when none works.
SHELLCHECK_BIN=
find_shellcheck() {
  local c tried=() installs=()
  SHELLCHECK_BIN=
  if [[ -n ${SHELLCHECK:-} ]]; then
    if "$SHELLCHECK" --version >/dev/null 2>&1; then
      SHELLCHECK_BIN=$SHELLCHECK
      return 0
    fi
    echo "skipped: \$SHELLCHECK=$SHELLCHECK does not run (--version failed)"
    return 1
  fi
  if c=$(command -v shellcheck); then
    if "$c" --version >/dev/null 2>&1; then
      SHELLCHECK_BIN=$c
      return 0
    fi
    tried+=("$c (--version failed)")
  else
    tried+=("shellcheck not on PATH")
  fi
  mapfile -t installs < <(printf '%s\n' \
    "$HOME"/.local/share/mise/installs/shellcheck/*/shellcheck*/shellcheck \
    "$HOME"/.local/share/mise/installs/shellcheck/*/shellcheck | sort -V -r)
  for c in "${installs[@]}"; do
    [[ -x $c ]] || continue
    if "$c" --version >/dev/null 2>&1; then
      SHELLCHECK_BIN=$c
      return 0
    fi
    tried+=("$c (--version failed)")
  done
  tried+=("no runnable ~/.local/share/mise/installs/shellcheck/*/shellcheck*/shellcheck")
  local IFS=';'
  echo "skipped: no working shellcheck (set SHELLCHECK to one); tried: ${tried[*]}"
  return 1
}

# The suites that need shellcheck find it the same way.
export_shellcheck() {
  find_shellcheck >/dev/null && export SHELLCHECK="$SHELLCHECK_BIN"
}

bash_suite() {
  local t=$1
  if [[ ! -f $t ]]; then
    echo "FAIL $t does not exist"
    return 1
  fi
  (export_shellcheck; bash "$t")
}

# Usage: shellcheck_check [dir]. Checks setup.sh, tests/*.sh and the fake
# binaries (tests/fixtures/fake-msi-mux-switch*) of dir (default: the plugin), globbed now so a new script is
# included, at default severity. Any finding is printed (gcc format) and
# fails.
shellcheck_check() {
  local dir=${1:-$PLUGIN_DIR} f out status
  local files=()
  find_shellcheck || return $SKIP
  for f in "$dir/setup.sh" "$dir"/tests/*.sh "$dir"/tests/fixtures/fake-msi-mux-switch*; do
    [[ -f $f ]] && files+=("$f")
  done
  if ((${#files[@]} == 0)); then
    echo "FAIL no scripts found to check under $dir"
    return 1
  fi
  out=$("$SHELLCHECK_BIN" -f gcc "${files[@]}" 2>&1)
  status=$?
  if ((status != 0)); then
    echo "$out"
    echo "shellcheck exit status $status in ${#files[@]} file(s)"
    return 1
  fi
  echo "ok   $("$SHELLCHECK_BIN" --version | sed -n 's/^version: /shellcheck /p'): ${#files[@]} file(s) clean"
}

# The check must be able to fail: a clean scratch copy passes, then an unquoted
# `echo $1` injected into one script must be reported (SC2086).
shellcheck_selftest() {
  local scratch out ok=0
  find_shellcheck || return $SKIP
  scratch=$(mktemp -d) || return 1
  mkdir "$scratch/tests"
  cp "$PLUGIN_DIR/setup.sh" "$scratch/setup.sh"
  if out=$(shellcheck_check "$scratch"); then
    echo "ok   untouched copy passes"
  else
    echo "FAIL untouched copy should pass:"
    echo "$out"
    ok=1
  fi
  # The literal, unquoted $1 is the injected finding.
  # shellcheck disable=SC2016
  printf '\necho $1\n' >>"$scratch/setup.sh"
  if out=$(shellcheck_check "$scratch"); then
    echo "FAIL an injected unquoted \$1 was not caught"
    ok=1
  elif grep -q 'SC2086' <<<"$out"; then
    echo "ok   an injected unquoted \$1 fails: $(grep SC2086 <<<"$out" | head -1 | sed "s|$scratch/||")"
  else
    echo "FAIL the injected copy failed, but not on SC2086:"
    echo "$out"
    ok=1
  fi
  rm -rf "$scratch"
  return $ok
}

run "manifest validation (omarchy-plugin-validate)" validate
run "qmllint (qt6)" qml_lint
run "qmllint self-test (injected unknown type)" qml_lint_selftest
run "QML load (scratch qs)" qml_load
run "QML load self-test (injected faults)" qml_load_selftest
run "widget and singleton live against a fake binary (scratch qs)" widget_live
run "switch and env-file flow against fake pkexec, stat and binary (scratch qs)" switch_flow_live
run "debug read bounds and the check watchdog against flooding and hanging fakes (scratch qs)" debug_bounds_live
run "model" node_suite "$PLUGIN_DIR/tests/model-test.js"
run "debug read command against the fakes (tests/debug-read-test.sh)" bash_suite "$PLUGIN_DIR/tests/debug-read-test.sh"
run "env file sourced by sh (tests/env-file-test.sh)" bash_suite "$PLUGIN_DIR/tests/env-file-test.sh"
run "setup.sh against a fake sudo (tests/setup-test.sh)" bash_suite "$PLUGIN_DIR/tests/setup-test.sh"
run "shellcheck (setup.sh, tests/*.sh, the fake binaries)" shellcheck_check
run "shellcheck self-test (injected unquoted variable)" shellcheck_selftest

if ((FAILURES)); then
  echo "$FAILURES suite(s) failed"
  exit 1
fi
if ((SKIPPED)); then
  echo "all suites that could run passed; $SKIPPED skipped (not checked)"
else
  echo "all suites passed"
fi
