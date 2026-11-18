#!/bin/bash

# Everything that can be checked without the running shell: manifest
# validation, QML syntax and type checks against the shell's own qs.Ui /
# qs.Commons modules, loading the widget in a throwaway Quickshell (skipped
# outside a Wayland session), the widget and its singleton live against a fake
# msi-mux-switch, the model logic, the env file sourced by sh against fixture
# trees, setup.sh against a fake sudo, and shellcheck over setup.sh and
# tests/*.sh (with a self-test that it can fail).
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
    grep -q "$marker DONE" "$cfg/log" && break
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
# no env file is written), waits for the DMI read, the stat, the debug read
# and the AC read, and reports them. The real DMI decides the hardware: on a
# machine that is not an MSI the widget must be hidden and nothing else is
# read. Checks that the singleton is the widget's (one instance), that the
# fake was run with exactly --debug --json and the hardware's flags, that the
# temporary binary fails the ownership gate (it is not root-owned), and that
# no binding throws or the engine warns.
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
    if (s.hardware.state === "available" && (!s.debug.ok && s.debug.error === "")) return
    Qt.callLater(shell.report)
  }
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
  elif [[ $line =~ hardware\ available\ hidden\ false\ shown\ true\ path\ true\ stat\ true\ kind\ (owner|ancestor)\ available\ false\ debug\ true\ current\ discrete\ modes\ discrete,mshybrid,integrated\ rows\ 3\ env\ auto\ busy\ false\ flags\ (.*)$ ]]; then
    echo "ok   available hardware; the temporary binary fails the ownership gate (${BASH_REMATCH[1]})"
    echo "ok   one debug read through the fake: current discrete, three modes, three rows; no env file"
    local want="--debug --json"
    [[ -n ${BASH_REMATCH[2]} ]] && want+=" ${BASH_REMATCH[2]//,/ }"
    if [[ $(cat "$cfg/fake.log" 2>/dev/null) == "$want" ]]; then
      echo "ok   the fake ran once, with exactly: $want"
    else
      echo "FAIL the fake's arguments: $(tr '\n' '|' <"$cfg/fake.log" 2>/dev/null) (want: $want)"
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
# The singleton is driven directly (no panel, so no window and no dialog):
# Intel/RTX/Auto write and remove the env file under the temporary HOME;
# the base GPU dropdown is shown with Discrete current and with MSHybrid or
# Integrated pending; MSHybrid is staged (the re-read shows it pending, the
# file stays), then the pending switch is cancelled (no shutdown offered;
# staging Discrete leaves the file), Integrated is staged and cancelled too
# (the RTX file is still there after the round trip);
# a second request while one runs is refused; RTX then Auto while RTX is
# written ends in Auto (no file); a write that fails (env.d made read-only)
# shows the error and puts the widget's dropdown back on Auto, the state on
# disk; a switch while a process named
# msi-mux-switch runs (a copy of sleep) is refused before pkexec. Skipped on
# hardware that is not available or on battery (the real AC is read).
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
# Called as: stat -c <format> -- <paths...>; every path reads as root:root 755.
[[ \$1 == -c && \$3 == -- ]] || exit 1
"$real_stat" -c '%u	%f	%U	%n' -- "\${@:4}" | while IFS=\$'\t' read -r _ raw _ name; do
  printf '0\t%x\troot\t%s\n' "\$(( (16#\$raw & 16#F000) | 8#755 ))" "\$name"
done
EOF
  cat >"$fake/pkexec" <<EOF
#!/bin/bash
printf '%s\n' "\$*" >>"$cfg/pkexec.log"
[[ \$1 == --disable-internal-agent ]] || exit 127
shift
exec "\$@"
EOF
  chmod 755 "$fake/stat" "$fake/pkexec"
  if [[ $(PATH="$fake:$PATH" command -v pkexec) != "$fake/pkexec" ]]; then
    echo "FAIL pkexec does not resolve to the fake; not running"
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
ShellRoot {
  id: shell
  QtObject { id: holder }
  property var widget: null
  property int step: 0
  property var outcome: null
  function log(s) { console.log("MMFLOW " + s) }
  function done() { shell.log("DONE"); shell.step = 99; Qt.callLater(Qt.quit) }
  Component.onCompleted: {
    var c = Qt.createComponent("file://$dir/BarWidget.qml", Component.PreferSynchronous)
    if (c.status !== Component.Ready) { shell.log("ERROR " + c.errorString()); shell.done(); return }
    shell.widget = c.createObject(shell, { settings: { binaryPath: "$bin" } })
  }
  Connections {
    target: Plugin.MuxState
    function onSwitchFinished(owner, outcome) {
      shell.log("finished owner " + (owner === holder) + " kind " + outcome.kind + " offer " + outcome.offerShutdown
        + " warning " + (outcome.warning !== "") + " :: " + outcome.message)
      shell.outcome = outcome
    }
  }
  Timer {
    interval: 100
    repeat: true
    running: shell.step < 99
    onTriggered: {
      var s = Plugin.MuxState
      if (shell.step === 0) {
        if (!s.dmiRead) return
        if (s.hardware.state !== "available") { shell.log("skip hardware " + s.hardware.state); shell.done(); return }
        if (!s.debug.ok || s.ac === null && !s.statRead) return
        if (s.ac !== true) { shell.log("skip ac " + s.ac); shell.done(); return }
        shell.log("ready ownership " + s.ownership.kind + " available " + s.available + " current " + s.debug.current
          + " pending " + s.debug.pending + " env " + s.envChoice)
        shell.logShown("discrete current")
        s.setEnvChoice("rtx")
        shell.step = 1
      } else if (shell.step === 1) {
        if (s.envChoice !== "rtx") return
        shell.log("env rtx " + s.envChanged)
        var first = s.requestSwitch(holder, "mshybrid", false)
        var second = s.requestSwitch(holder, "integrated", false)
        shell.log("request " + first + " second " + second)
        shell.step = 2
      } else if (shell.step === 2) {
        if (!shell.outcome || s.busy || !s.debug.pending) return
        shell.log("staged pending " + s.debug.pending + " target " + s.debug.target + " env " + s.envChoice)
        shell.logShown("mshybrid pending")
        shell.outcome = null
        shell.log("cancel " + s.requestSwitch(holder, "discrete", true))
        shell.step = 3
      } else if (shell.step === 3) {
        if (!shell.outcome || s.busy || s.debug.pending) return
        // Read the file back: staging Discrete (the cancel) left it.
        shell.reads = 0
        s.rereadEnv()
        shell.step = 31
      } else if (shell.step === 31) {
        if (shell.reads === 0) return
        shell.log("cancelled pending " + s.debug.pending + " env " + s.envChoice)
        // Integrated staged with RTX chosen: the file stays too.
        shell.outcome = null
        shell.log("integrated request " + s.requestSwitch(holder, "integrated", false))
        shell.step = 32
      } else if (shell.step === 32) {
        if (!shell.outcome || s.busy || !s.debug.pending) return
        shell.reads = 0
        s.rereadEnv()
        shell.step = 33
      } else if (shell.step === 33) {
        if (shell.reads === 0) return
        shell.log("integrated pending " + s.debug.pending + " target " + s.debug.target + " env " + s.envChoice)
        shell.logShown("integrated pending")
        shell.outcome = null
        shell.log("cancel integrated " + s.requestSwitch(holder, "discrete", true))
        shell.step = 34
      } else if (shell.step === 34) {
        if (!shell.outcome || s.busy || s.debug.pending) return
        shell.reads = 0
        s.rereadEnv()
        shell.step = 35
      } else if (shell.step === 35) {
        if (shell.reads === 0) return
        shell.log("round trip pending " + s.debug.pending + " env " + s.envChoice)
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
        envDirMode.command = ["chmod", "755", "--", "$home/.config/uwsm/env.d"]
        envDirMode.running = true
        shell.step = 9
      } else if (shell.step === 9) {
        if (envDirMode.running) return
        // An msi-mux-switch already running (a copy of sleep by that name):
        // the switch is refused before pkexec.
        blocker.running = true
        shell.step = 10
      } else if (shell.step === 10) {
        if (!blocker.running) return
        shell.outcome = null
        shell.log("blocked request " + s.requestSwitch(holder, "integrated", false))
        shell.step = 11
      } else if (shell.step === 11) {
        if (!shell.outcome || s.busy) return
        blocker.running = false
        shell.widget.destroy()
        shell.done()
      }
    }
  }
  Process { id: blocker; command: ["$cfg/run/msi-mux-switch", "30"] }
  Process { id: envDirMode }
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
  expect_flow "finished owner true kind success offer true warning false" "MSHybrid: success, the shutdown is offered"
  expect_flow "staged pending true target mshybrid env rtx" "the re-read shows MSHybrid pending; the env file stays"
  expect_flow "cancel true" "cancel asked"
  expect_flow "finished owner true kind cancelled offer false warning false :: Pending switch cancelled" "cancelled: no shutdown offered"
  expect_flow "dropdown discrete current shown true" "the base GPU dropdown is shown in Discrete (current, nothing pending)"
  expect_flow "dropdown mshybrid pending shown true" "the dropdown is shown with MSHybrid pending"
  expect_flow "cancelled pending false env rtx" "nothing pending; staging Discrete left the env file (RTX)"
  expect_flow "integrated request true" "Integrated asked for with RTX chosen"
  expect_flow "integrated pending true target integrated env rtx" "Integrated staged: the env file stays"
  expect_flow "dropdown integrated pending shown true" "the dropdown is shown with Integrated pending"
  expect_flow "cancel integrated true" "the pending Integrated is cancelled"
  expect_flow "round trip pending false env rtx" "after the round trip the RTX choice is still on disk"
  expect_flow "env intel" "Intel writes the plugin's exact text"
  expect_flow "env auto" "Auto removes it"
  expect_flow "queued busy true next auto" "Auto picked while RTX is written waits in the queue"
  expect_flow "queue applied env auto" "the queued Auto is applied after the write: no file"
  expect_flow "failed write env auto dropdown auto error true" "a failed write shows the error; the dropdown reverts to the file on disk (Auto)"
  expect_flow "blocked request true" "a switch is asked for while an msi-mux-switch runs"
  expect_flow "finished owner true kind error offer false warning false :: msi-mux-switch is already running" "it is refused before pkexec"
  # The flags are the ones the debug read got (the hardware's).
  local flags want_pk
  flags=$(sed -n '1s/^--debug --json//p' "$cfg/fake.log" 2>/dev/null)
  want_pk=$(printf '%s\n' "--disable-internal-agent $bin mshybrid --json$flags" "--disable-internal-agent $bin discrete --json$flags" \
    "--disable-internal-agent $bin integrated --json$flags" "--disable-internal-agent $bin discrete --json$flags")
  if [[ $(cat "$cfg/pkexec.log" 2>/dev/null) == "$want_pk" ]]; then
    echo "ok   pkexec ran four times, with exactly the argv arrays expected"
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
# binary of dir (default: the plugin), globbed now so a new script is
# included, at default severity. Any finding is printed (gcc format) and
# fails.
shellcheck_check() {
  local dir=${1:-$PLUGIN_DIR} f out status
  local files=()
  find_shellcheck || return $SKIP
  for f in "$dir/setup.sh" "$dir"/tests/*.sh "$dir/tests/fixtures/fake-msi-mux-switch"; do
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
run "model" node_suite "$PLUGIN_DIR/tests/model-test.js"
run "env file sourced by sh (tests/env-file-test.sh)" bash_suite "$PLUGIN_DIR/tests/env-file-test.sh"
run "setup.sh against a fake sudo (tests/setup-test.sh)" bash_suite "$PLUGIN_DIR/tests/setup-test.sh"
run "shellcheck (setup.sh, tests/*.sh, the fake binary)" shellcheck_check
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
