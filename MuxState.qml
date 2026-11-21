pragma Singleton
import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// The GPU MUX state every bar reads, and the only place a process is started
// for it. A bar surface exists per monitor, so BarWidget.qml exists once per
// output; the state is the same for all of them (qmldir declares this file a
// singleton, which is load-bearing: without it every property read off the
// name is undefined).
//
// What runs, and when (every command an argv array from Model.js):
//   - DMI read (Model.dmiArgv): once, when the first widget attaches.
//     Decides hidden / available / unavailable and the override flags
//     (Model.hardwareDecision).
//   - the gate read (Model.gateArgv): /etc/fuse.conf (bounded, sent back as
//     hex), stat of the binary and every directory above it, the mount
//     table (/proc/self/mountinfo, bounded) and the same stat again, in one
//     run: after the DMI read, when the binary path setting changes, on a
//     panel opening, before every debug read, and again right before a
//     switch (Model.ownershipVerdict, through Model.binaryVerdict, which
//     also refuses user_allow_other turned on in fuse.conf or a fuse.conf
//     that could not be checked, a FUSE or user_id mount on the binary's
//     way, and a read whose two stats differ). Which binary: the path set
//     in the settings, gated alone; with none set (auto), the status read
//     gates Model.USR_BINARY first and, only when that read says nothing is
//     there (Model.autoChoice), Model.OPT_BINARY in a second run. binaryPath
//     becomes the chosen path together with that path's own gate result, so
//     the binary run is always the one that just passed; the switch gates
//     binaryPath again and does not choose anew.
//   - the read-only state read, `<binary> --debug --json [flags]` as the
//     user (Model.debugReadArgv): only at the end of a gate read
//     (checkBinary), on available hardware, and only if that read passes the
//     same ownership gate as the switch; otherwise the binary is never run
//     and no earlier read's state is kept. With each read, the boot id
//     (Model.bootIdArgv), for the remembered leftover flag. A read asked for
//     while another runs or a switch is being checked, and the read after
//     each switch, start a new gate read first. Never on a timer: only this
//     tool changes the mode. Bounded:
//     under a timeout, and at most Model.DEBUG_MAX_BYTES of each stream is
//     read (Model.DEBUG_SCRIPT).
//   - AC (Model.acArgv): at startup, on a panel opening, every
//     Model.AC_POLL_MS only while a panel is open, and right before a switch.
//   - `pgrep -x msi-mux-switch` (Model.pgrepArgv): right before a switch,
//     once no debug read of this plugin's is running; any msi-mux-switch
//     already running (a switch from a shell instance left behind by a
//     reload, or one started by hand) refuses the switch.
//   - the switch, `pkexec --disable-internal-agent <binary> <mode> --json
//     [flags]` (Model.switchArgv): only from requestSwitch, after the user
//     confirmed, and only when the fresh stat, AC read and pgrep all pass.
//     Those checks get Model.CHECK_TIMEOUT_MS (checkWatchdog); then the
//     switch is refused and nothing runs. One at a time. stdout and stderr
//     are read in raw chunks, cut into capped lines (Model.splitChunk) and
//     folded in by Model.applySwitchLine.
//   - the env file (~/.config/uwsm/env.d/90-msi-mux-gpu): read with a
//     bounded read that refuses anything but a regular file
//     (Model.envReadArgv); written only from setEnvChoice
//     (Model.envWriteArgv: mkdir -p of env.d, the text of Model.envFileText
//     to the dot-prefixed temporary file Model.ENV_TEMP_NAME beside it,
//     renamed over it with `mv -T`, the temporary file removed on failure;
//     a previous build's leftover Model.ENV_LEGACY_TEMP_NAME removed too),
//     removed with `rm -f` (never recursive; also the two temporary names,
//     Model.envRemoveArgv) only on Auto. Staging a mode never touches it:
//     the choice survives a mode round trip (the file acts only in
//     MSHybrid). One change at a time; a choice made while one runs is
//     applied after it (the latest wins); after each, the file is read back
//     and the dropdown follows what is on disk. No other file is read for writing, renamed or touched.
Singleton {
  id: root

  readonly property string home: Model.cleanHome(Quickshell.env("HOME"))
  readonly property string pluginDir: Model.pluginDirFromUrl(Qt.resolvedUrl("manifest.json"))
  readonly property string envFilePath: Model.envFilePath(root.home)

  // The widget's setting (Model.binaryPathSetting: "" is auto), and the
  // binary the last finished status read chose and gated: the setting when
  // one is set, else Model.USR_BINARY or Model.OPT_BINARY; "" until an
  // auto read has chosen.
  property string binarySetting: ""
  property string binaryPath: ""

  // DMI and the hardware decision.
  property bool dmiRead: false
  property var dmi: ({ vendor: "", model: "", board: "", bios: "" })
  readonly property var hardware: Model.hardwareDecision(root.dmi)
  readonly property bool hidden: !root.dmiRead || root.hardware.state === "hidden"

  // The last gate read (stat, the mount table's text and fuse.conf,
  // Model.parseGateRead) and what it means.
  property bool statRead: false
  property var stats: ({})
  property var mounts: null
  property var fuseConf: null
  readonly property var ownership: root.statRead
    ? Model.binaryVerdict(root.binarySetting, root.binaryPath, root.stats, root.mounts, root.fuseConf)
    : { ok: false, kind: "", reason: "Checking the backend…" }
  // No debug read can run: the hardware is not validated, or the last stat
  // refused the binary (the panel shows the mode as unknown).
  readonly property bool debugBlocked: root.hardware.state === "unavailable" || (root.statRead && !root.ownership.ok)

  // Why switching is impossible ("" when it is not): the hardware first,
  // then the binary.
  readonly property string unavailableReason: root.hardware.state === "unavailable" ? root.hardware.reason
    : (root.ownership.ok ? "" : root.ownership.reason)
  readonly property bool available: root.dmiRead && root.hardware.state === "available" && root.ownership.ok
  readonly property bool canSetUp: root.hardware.state === "available" && Model.setupHelps(root.ownership, root.binaryPath)
    && root.pluginDir !== ""

  // The last debug read (Model.parseDebugRead); empty while the binary is
  // refused.
  property var debug: Model.emptyDebug()

  // The boot id read with the last debug read ("" when it could not be),
  // and the leftover firmware flag remembered from a refusal
  // (Model.flagMemoryAtRefusal), or null. Every new debug read or boot id
  // decides again whether it still holds (Model.flagMemoryAfterRead), so an
  // emptied read (a refused gate) drops it too.
  property string bootId: ""
  property var flagRecord: null
  onDebugChanged: root.flagRecord = Model.flagMemoryAfterRead(root.flagRecord, root.bootId, root.debug)
  onBootIdChanged: root.flagRecord = Model.flagMemoryAfterRead(root.flagRecord, root.bootId, root.debug)

  // AC: true, false or null (unknown).
  property var ac: null

  // The switch: "" idle, "checking" (fresh stat and AC), "running".
  property string phase: ""
  property string switchMode: ""
  property var switchOwner: null
  property var switchRun: Model.newSwitchRun()
  // The last finished switch (Model.switchOutcome) and whose it was.
  property var outcome: null
  property var outcomeOwner: null
  property int outcomes: 0
  readonly property bool busy: root.phase !== ""

  // The env file's state for the dropdown (Model.envChoiceFromFile), and
  // whether it was changed this session (then the panel says log out).
  property string envChoice: "auto"
  property bool envChanged: false
  property string envError: ""
  // A write or remove in flight, and the choice asked for meanwhile ("" for
  // none).
  property bool envBusy: false
  property string envQueued: ""

  property var attached: []
  property var openPanels: []
  property bool started: false

  signal switchFinished(var owner, var outcome)
  // The env file was read back and envChoice set from it, changed or not:
  // the dropdown follows it, so a failed pick does not stay shown.
  signal envRead()

  // ------------------------------------------------------------ attachment

  function attach(owner, path) {
    if (root.attached.indexOf(owner) === -1) root.attached = root.attached.concat([owner])
    root.setBinaryPath(path)
    if (!root.started) {
      root.started = true
      startDelay.restart()
    }
  }

  function detach(owner) {
    root.attached = root.attached.filter(function(o) { return o !== owner })
    root.releaseOpen(owner)
  }

  // A new setting drops what the last one chose: a set path is the binary
  // at once; in auto none is until the status read chose one.
  function setBinaryPath(path) {
    var p = Model.binaryPathSetting(path)
    if (p === root.binarySetting) return
    root.binarySetting = p
    root.binaryPath = p
    root.statNext = ""
    root.statRead = false
    root.stats = ({})
    root.mounts = null
    root.fuseConf = null
    root.debug = Model.emptyDebug()
    if (root.started && !startDelay.running) root.checkBinary()
  }

  // A panel opening: everything is read again.
  function holdOpen(owner) {
    if (root.openPanels.indexOf(owner) === -1) root.openPanels = root.openPanels.concat([owner])
    if (!root.dmiRead) root.readDmi()
    else root.checkBinary()
    root.readAc()
    root.rereadEnv()
  }

  // The last switch's result, once seen: a panel opening clears it (except
  // the one that reopens itself to show it).
  function clearOutcome() {
    root.outcome = null
    root.outcomeOwner = null
  }

  function releaseOpen(owner) {
    root.openPanels = root.openPanels.filter(function(o) { return o !== owner })
  }

  // The bar hands a widget its settings right after it completes; the first
  // reads wait for them so they never run against the default by mistake.
  Timer {
    id: startDelay
    interval: 250
    repeat: false
    onTriggered: {
      root.readDmi()
      root.readAc()
    }
  }

  // ------------------------------------------------------------------ reads

  function readDmi() {
    if (dmiProc.running) return
    dmiProc.command = Model.dmiArgv()
    dmiProc.running = true
  }

  Process {
    id: dmiProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var parsed = Model.parseDmi(text)
        if (parsed) root.dmi = parsed
        root.dmiRead = true
        root.checkBinary()
      }
    }
  }

  property bool statAgain: false
  // The auto read's second path (Model.OPT_BINARY), waiting for the first
  // run to end; "" for none. A new read or setting drops it.
  property string statNext: ""
  // Numbers each status gate run, so only the newest one's end is taken.
  property int statRuns: 0

  function checkBinary() {
    if (!root.dmiRead || root.hardware.state !== "available") return
    if (statProc.running) { root.statAgain = true; return }
    root.statNext = ""
    root.gateCandidate(Model.firstCandidate(root.binarySetting))
  }

  // One status gate run on `path`, a candidate for the current setting.
  function gateCandidate(path) {
    var argv = Model.gateArgv(path)
    if (argv.length === 0) {
      root.chosen(path, { stats: ({}), mounts: null, fuseConf: null })
      return
    }
    statProc.path = path
    statProc.setting = root.binarySetting
    statProc.run = ++root.statRuns
    statProc.command = argv
    statProc.running = true
  }

  // The auto read's second run, once the first has ended (whichever of its
  // stream end and its exit comes last starts it).
  function gateNext() {
    if (root.statNext === "" || statProc.running) return
    var p = root.statNext
    root.statNext = ""
    root.gateCandidate(p)
  }

  // The chosen path and its own gate read, set together; what was read for
  // another path is dropped only when the path changes, so a read again of
  // the same binary does not flash "Checking the backend…".
  function chosen(path, gate) {
    if (path !== root.binaryPath) {
      root.binaryPath = path
      root.debug = Model.emptyDebug()
    }
    root.mounts = gate.mounts
    root.fuseConf = gate.fuseConf
    root.stats = gate.stats
    root.statRead = true
    root.readDebug(root.stats, root.mounts, root.fuseConf)
  }

  Process {
    id: statProc
    property string path: ""
    property string setting: ""
    property int run: 0
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        // Stale: the setting changed, or a newer read is asked for.
        if (statProc.setting !== root.binarySetting || statProc.run !== root.statRuns || root.statAgain) return
        var gate = Model.parseGateRead(text)
        var next = Model.autoChoice(statProc.setting, statProc.path, gate)
        if (next !== "") {
          root.statNext = next
          if (!statProc.running) Qt.callLater(root.gateNext)
          return
        }
        root.chosen(statProc.path, gate)
      }
    }
    onRunningChanged: {
      if (statProc.running) return
      if (root.statAgain) {
        root.statAgain = false
        root.statNext = ""
        Qt.callLater(root.checkBinary)
        return
      }
      if (root.statNext !== "") Qt.callLater(root.gateNext)
    }
  }

  property bool debugAgain: false
  // Numbers each debug read, so the end of one cannot be taken for the end
  // of the next one started meanwhile.
  property int debugRuns: 0

  // Called only by the gate read that just finished, with its result: the
  // binary runs only if that read passes the switch's ownership gate
  // (Model.debugReadArgv). A read that has to wait is asked for again
  // through checkBinary, so it too follows a fresh gate read.
  function readDebug(stats, mounts, fuseConf) {
    if (root.hardware.state !== "available") return
    var argv = Model.debugReadArgv(root.binaryPath, stats, mounts, fuseConf, root.hardware.flags)
    if (argv.length === 0) {
      root.debug = Model.emptyDebug()
      return
    }
    // Not while a switch is being checked: pgrep must not see this plugin's
    // own debug read (finish() reads again).
    if (debugProc.running || root.phase === "checking") { root.debugAgain = true; return }
    debugProc.path = root.binaryPath
    debugProc.run = ++root.debugRuns
    debugProc.out = ""
    debugProc.err = ""
    debugProc.outDone = false
    debugProc.errDone = false
    debugProc.exitCode = -1
    debugProc.exited = false
    debugProc.command = argv
    debugProc.running = true
    root.readBootId()
  }

  // Cheap, and within one shell process it does not change: belt and braces
  // for the remembered flag, which a new boot drops.
  function readBootId() {
    if (bootProc.running) return
    bootProc.command = Model.bootIdArgv()
    bootProc.running = true
  }

  Process {
    id: bootProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.bootId = Model.parseBootId(text)
    }
  }

  // Finished only when both streams and the exit status are in, in whatever
  // order they arrive. Dropped if a stat since refused the binary, and so is
  // any earlier read (debugBlocked is then true).
  function finishDebug() {
    if (!debugProc.outDone || !debugProc.errDone || !debugProc.exited) return
    if (debugProc.path !== root.binaryPath) return
    if (!root.ownership.ok) { root.debug = Model.emptyDebug(); return }
    root.debug = Model.parseDebugRead(debugProc.out, debugProc.err, debugProc.exitCode)
  }

  Process {
    id: debugProc
    property string path: ""
    property int run: 0
    property string out: ""
    property string err: ""
    property bool outDone: false
    property bool errDone: false
    property bool exited: false
    property int exitCode: -1
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        debugProc.out = text
        debugProc.outDone = true
        root.finishDebug()
      }
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        debugProc.err = text
        debugProc.errDone = true
        root.finishDebug()
      }
    }
    onExited: function(exitCode, exitStatus) { debugProc.exitCode = exitCode }
    // Also reached when the binary could not be started (no exited signal):
    // the exit status is then -1, which reads as a failure. Handled a turn
    // later, and only if no other read started meanwhile (that one's own end
    // is handled the same way).
    onRunningChanged: {
      if (debugProc.running) return
      var run = debugProc.run
      Qt.callLater(function() {
        if (debugProc.run !== run || debugProc.running) return
        debugProc.exited = true
        root.finishDebug()
        if (root.pgrepWaiting) {
          root.pgrepWaiting = false
          checkRunning.running = true
        }
        if (!root.debugAgain || root.phase === "checking") return
        root.debugAgain = false
        root.checkBinary()
      })
    }
  }

  function readAc() {
    if (acProc.running) return
    acProc.command = Model.acArgv()
    acProc.running = true
  }

  Process {
    id: acProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.ac = Model.parseAc(text)
    }
  }

  Timer {
    interval: Model.AC_POLL_MS
    running: root.openPanels.length > 0
    repeat: true
    onTriggered: root.readAc()
  }

  // ----------------------------------------------------------------- switch

  // Asked by a widget after its confirmation dialog. The ownership and AC
  // checks run again first (checkStat, checkAc), and pgrep looks for an
  // msi-mux-switch already running (checkRunning, started once this plugin's
  // own debug read is over); the switch starts only if all pass
  // (startSwitch).
  property bool pgrepWaiting: false

  function requestSwitch(owner, mode) {
    if (root.busy || !Model.isMode(mode)) return false
    // A check stopped by the watchdog may take a moment to end: refused,
    // and the panel says so (Model.checksEndingProblem). A check that
    // ignores TERM keeps this refusal up until it ends (accepted).
    var ending = Model.checksEndingProblem(checkStat.running || checkAc.running || checkRunning.running)
    if (ending !== "") {
      root.switchOwner = owner
      root.refused(ending)
      return false
    }
    if (Model.switchBlocker({ unavailableReason: root.unavailableReason, debug: root.debug, busy: false, ac: root.ac,
        flag: root.flagRecord }) !== "")
      return false
    root.phase = "checking"
    root.switchMode = mode
    root.switchOwner = owner
    root.switchRun = Model.newSwitchRun()
    root.outcome = null
    checkStat.result = null
    checkAc.result = undefined
    checkRunning.result = undefined
    checkStat.command = Model.gateArgv(root.binaryPath)
    checkStat.path = root.binaryPath
    checkAc.command = Model.acArgv()
    checkRunning.command = Model.pgrepArgv()
    checkStat.running = true
    checkAc.running = true
    if (debugProc.running) root.pgrepWaiting = true
    else checkRunning.running = true
    checkWatchdog.restart()
    return true
  }

  // A check that does not end (a hung stat or pgrep, or a debug read that
  // outlives its timeout) refuses the switch instead of leaving it
  // "checking"; the checks still running are stopped.
  Timer {
    id: checkWatchdog
    interval: Model.CHECK_TIMEOUT_MS
    repeat: false
    onTriggered: {
      if (root.phase !== "checking") return
      // Refused first, so a check that ends as it is stopped finds the
      // phase over and starts nothing.
      root.refused(Model.CHECK_TIMEOUT_TEXT)
      checkStat.running = false
      checkAc.running = false
      checkRunning.running = false
    }
  }

  function finish(outcome) {
    var owner = root.switchOwner
    checkWatchdog.stop()
    root.pgrepWaiting = false
    root.phase = ""
    root.switchOwner = null
    root.outcome = outcome
    root.outcomeOwner = owner
    root.outcomes++
    root.switchFinished(owner, outcome)
    // A debug read asked for while the switch was checked, or after it ran
    // (switchExited): a new stat first, then the read.
    if (root.debugAgain && !debugProc.running) {
      root.debugAgain = false
      root.checkBinary()
    }
  }

  function refused(reason) {
    root.finish({ kind: "error", message: reason, warning: "", offerShutdown: false })
  }

  function startSwitch() {
    if (root.phase !== "checking" || checkStat.result === null || checkAc.result === undefined
        || checkRunning.result === undefined) return
    if (checkStat.path !== root.binaryPath) return root.refused("The binary path changed; nothing was run.")
    // The fresh gate read becomes the last one, so a refusal also blocks the
    // debug read (debugBlocked) and drops the earlier read: its mode came
    // from a binary no longer trusted.
    var gate = checkStat.result
    root.mounts = gate.mounts
    root.fuseConf = gate.fuseConf
    root.stats = gate.stats
    var verdict = Model.binaryVerdict(root.binarySetting, root.binaryPath, gate.stats, gate.mounts, gate.fuseConf)
    if (!verdict.ok) {
      root.debug = Model.emptyDebug()
      return root.refused(verdict.reason + " Nothing was run.")
    }
    root.ac = checkAc.result
    if (checkAc.result !== true) return root.refused(Model.acText(checkAc.result))
    var running = Model.runningProblem(checkRunning.result)
    if (running !== "") return root.refused(running)
    var argv = Model.switchArgv(root.binaryPath, root.switchMode, root.hardware.flags)
    if (argv.length === 0 || root.hardware.state !== "available") return root.refused("The switch could not be prepared.")
    checkWatchdog.stop()
    root.phase = "running"
    switchProc.exitCode = -1
    switchProc.command = argv
    switchProc.stdoutBuf = Model.newLineBuffer()
    switchProc.stderrBuf = Model.newLineBuffer()
    switchProc.running = true
  }

  Process {
    id: checkStat
    property string path: ""
    property var result: null
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        checkStat.result = Model.parseGateRead(text)
        root.startSwitch()
      }
    }
  }

  Process {
    id: checkAc
    property var result: undefined
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        checkAc.result = Model.parseAc(text)
        root.startSwitch()
      }
    }
  }

  // pgrep's exit status (1: none running); -1 when it could not start.
  Process {
    id: checkRunning
    property var result: undefined
    property int exitCode: -1
    onExited: function(exitCode, exitStatus) { checkRunning.exitCode = exitCode }
    onRunningChanged: {
      if (checkRunning.running) { checkRunning.exitCode = -1; return }
      Qt.callLater(function() {
        checkRunning.result = checkRunning.exitCode
        root.startSwitch()
      })
    }
  }

  function ingest(line) {
    root.switchRun = Model.applySwitchLine(root.switchRun, line)
  }

  // Handled a turn after the process stopped (callLater), so the lines
  // still buffered at its exit are folded in first.
  function switchExited() {
    if (root.phase !== "running") return
    // A last line without "\n" is still in its buffer.
    var tail = Model.flushLine(switchProc.stdoutBuf)
    if (tail !== null) root.ingest(tail)
    tail = Model.flushLine(switchProc.stderrBuf)
    if (tail !== null) root.ingest(tail)
    var outcome = Model.switchOutcome(root.switchRun, switchProc.exitCode, root.switchMode,
      root.debug.ok && root.debug.pending)
    // The leftover-flag refusal is remembered past the panel clearing the
    // outcome; the read after the switch keeps or drops it.
    var flag = Model.flagMemoryAtRefusal(outcome, root.bootId, root.debug)
    if (flag !== null) root.flagRecord = flag
    // The mode is read again after the switch, through finish.
    root.debugAgain = true
    root.finish(outcome)
  }

  Process {
    id: switchProc
    property int exitCode: -1
    property var stdoutBuf: Model.newLineBuffer()
    property var stderrBuf: Model.newLineBuffer()
    // Raw chunks, cut into lines by the model, so a line that never ends
    // stays bounded (Model.splitChunk).
    stdout: SplitParser {
      splitMarker: ""
      onRead: function(data) {
        Model.splitChunk(switchProc.stdoutBuf, data).forEach(function(line) { root.ingest(line) })
      }
    }
    stderr: SplitParser {
      splitMarker: ""
      onRead: function(data) {
        Model.splitChunk(switchProc.stderrBuf, data).forEach(function(line) { root.ingest(line) })
      }
    }
    onExited: function(exitCode, exitStatus) { switchProc.exitCode = exitCode }
    // Also reached when pkexec could not be started (exit status stays -1).
    onRunningChanged: if (!switchProc.running) Qt.callLater(root.switchExited)
  }

  // --------------------------------------------------------------- env file

  // The read is bounded and never follows a link or opens a FIFO
  // (Model.envReadArgv); its answer is the dropdown's value.
  function rereadEnv() {
    var argv = Model.envReadArgv(root.home)
    if (argv.length === 0) return
    if (envReadProc.running) { envReadProc.again = true; return }
    envReadProc.command = argv
    envReadProc.running = true
  }

  Process {
    id: envReadProc
    property bool again: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (envReadProc.again || root.envBusy) return
        root.envChoice = Model.parseEnvRead(text)
        root.envRead()
      }
    }
    onRunningChanged: {
      if (envReadProc.running || !envReadProc.again) return
      envReadProc.again = false
      Qt.callLater(root.rereadEnv)
    }
  }

  // Auto removes the file; Intel or RTX writes it. While a change runs, the
  // latest choice waits and is applied after it. envError is cleared only by
  // a choice that starts at once; a queued one leaves the earlier error
  // shown, and replaces it only if it fails too.
  function setEnvChoice(value) {
    if (!Model.isEnvChoice(value) || root.envFilePath === "") return
    if (root.envBusy) {
      root.envQueued = value
      root.envChanged = true
      return
    }
    if (value === root.envChoice) return
    root.envError = ""
    root.startEnv(value)
  }

  function startEnv(value) {
    var argv = value === "auto" ? Model.envRemoveArgv(root.home) : Model.envWriteArgv(root.home, value)
    if (argv.length === 0) return
    root.envChanged = true
    root.envBusy = true
    envProc.value = value
    envProc.command = argv
    envProc.running = true
  }

  // A change finished: the next queued choice, or the file read back.
  function envDone() {
    var done = envProc.value
    root.envBusy = false
    var next = root.envQueued
    root.envQueued = ""
    if (next !== "" && next !== done) {
      root.startEnv(next)
      return
    }
    root.rereadEnv()
  }

  Process {
    id: envProc
    property string value: ""
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0)
        root.envError = (envProc.value === "auto" ? "Could not remove " : "Could not write ") + root.envFilePath + "."
    }
    // Also reached when the command could not be started.
    onRunningChanged: if (!envProc.running) Qt.callLater(root.envDone)
  }
}
