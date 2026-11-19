// MSI GPU MUX: the pure logic. Every parse, argv, verdict and string the
// QML shows is here, so tests/model-test.js can check it without a shell.
//
// Written as a QML JS module: bare function declarations and vars, no
// exports. Nothing here starts a process, reads a file or touches state.

// ------------------------------------------------------------------ identity

var PLUGIN_ID = "io.github.rsd.msi-mux"
var DISPLAY_NAME = "MSI GPU MUX"
var DEFAULT_BINARY = "/opt/msi-mux-switch/msi-mux-switch"
var UPSTREAM_URL = "https://github.com/steelbrain/msi-gpu-mux-switch"

// --------------------------------------------------------------------- modes

// The CLI's mode arguments (what the plugin passes), in the order shown.
var MODES = ["discrete", "mshybrid", "integrated"]

var MODE_LABELS = {
  discrete: "Discrete",
  mshybrid: "MSHybrid",
  integrated: "Integrated"
}

var MODE_DESCRIPTIONS = {
  discrete: "RTX only. Fastest, most power.",
  mshybrid: "Intel + RTX. Hyprland's base GPU is chosen below.",
  integrated: "Intel only. Best battery life."
}

// Nerd Font glyphs (Material Design range), built from code points so the
// source stays ASCII.
var ICON = {
  discrete: String.fromCodePoint(0xF08AE),   // expansion card
  mshybrid: String.fromCodePoint(0xF0328),   // layers
  integrated: String.fromCodePoint(0xF061A), // chip
  unknown: String.fromCodePoint(0xF08AE),
  setup: String.fromCodePoint(0xF0493),      // cog
  power: String.fromCodePoint(0xF0425)       // power
}

// The tool's JSON mode strings are kebab-case ("ms-hybrid"); its CLI accepts
// "mshybrid". Anything else (including null) is "".
function modeFromJson(value) {
  if (value === "ms-hybrid" || value === "mshybrid") return "mshybrid"
  if (value === "discrete") return "discrete"
  if (value === "integrated") return "integrated"
  return ""
}

function isMode(mode) {
  return MODES.indexOf(mode) !== -1
}

function modeLabel(mode) {
  return isMode(mode) ? MODE_LABELS[mode] : "Unknown"
}

function modeIcon(mode) {
  return isMode(mode) ? ICON[mode] : ICON.unknown
}

// ------------------------------------------------------------------ hardware

// Machines the plugin knows the tool works on although its own table does not
// list them: exact model, board and BIOS. Reads and switches on these pass
// OVERRIDE_FLAGS (reported upstream as steelbrain/msi-gpu-mux-switch#2).
var ALLOWLIST = [
  { model: "Vector 16 HX AI A2XWIG", board: "MS-15M3", bios: "E15M3IMS.10E" }
]

// A fixed copy of the tool's own HARDWARE_PROFILES table at commit 223ca06:
// these need no flags.
var NATIVE = [
  { model: "Vector 16 HX AI A2XWIG", board: "MS-15M3", bios: "E15M3IMS.116" },
  { model: "Stealth 16Studio A13VG", board: "MS-15F2", bios: "E15F2IMS.10F" }
]

var OVERRIDE_FLAGS = ["--allow-unsupported-hardware", "--allow-unvalidated-bios"]

// DMI values as the kernel gives them: trimmed, like the tool does.
function trimDmi(value) {
  return value === undefined || value === null ? "" : String(value).trim()
}

function isMsiVendor(vendor) {
  var v = trimDmi(vendor)
  return v === "MSI" || v.indexOf("Micro-Star International") === 0
}

function matchesEntry(table, dmi) {
  for (var i = 0; i < table.length; i++) {
    var e = table[i]
    if (e.model === dmi.model && e.board === dmi.board && e.bios === dmi.bios) return true
  }
  return false
}

// { state: "hidden" | "available" | "unavailable", source: "allowlist" |
// "native" | "", flags: [...], reason }. Hidden only on non-MSI hardware.
// The tables are constants: a setting never widens them.
function hardwareDecision(raw) {
  var r = raw || {}
  var dmi = {
    vendor: trimDmi(r.vendor),
    model: trimDmi(r.model),
    board: trimDmi(r.board),
    bios: trimDmi(r.bios)
  }
  if (!isMsiVendor(dmi.vendor)) return { state: "hidden", source: "", flags: [], reason: "Not an MSI machine." }
  if (matchesEntry(ALLOWLIST, dmi))
    return { state: "available", source: "allowlist", flags: OVERRIDE_FLAGS.slice(), reason: "" }
  if (matchesEntry(NATIVE, dmi))
    return { state: "available", source: "native", flags: [], reason: "" }
  return {
    state: "unavailable", source: "", flags: [],
    reason: "msi-mux-switch and this plugin have not been tested on this machine (model '" + dmi.model
      + "', board '" + dmi.board + "', BIOS '" + dmi.bios + "'), so switching is off."
  }
}

// The DMI read: DMI_SCRIPT prints "key=value" for each file, then "end".
// Arguments: "$1" is the DMI directory.
var DMI_DIR = "/sys/class/dmi/id"
var DMI_KEYS = { sys_vendor: "vendor", product_name: "model", board_name: "board", bios_version: "bios" }
var DMI_SCRIPT = [
  "for f in sys_vendor product_name board_name bios_version; do",
  "  v=$(head -c 256 -- \"$1/$f\" 2>/dev/null | tr -d '\\n\\r')",
  "  printf '%s=%s\\n' \"$f\" \"$v\"",
  "done",
  "printf 'end\\n'"
].join("\n")

function dmiArgv() {
  return ["sh", "-c", DMI_SCRIPT, "msi-mux-dmi", DMI_DIR]
}

// { vendor, model, board, bios } or null without the end line.
function parseDmi(text) {
  var lines = String(text || "").split("\n")
  var out = { vendor: "", model: "", board: "", bios: "" }
  var ended = false
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line === "end") { ended = true; break }
    var eq = line.indexOf("=")
    if (eq < 0) continue
    var key = DMI_KEYS[line.slice(0, eq)]
    if (key) out[key] = trimDmi(line.slice(eq + 1))
  }
  return ended ? out : null
}

// ---------------------------------------------------------- the binary's path

// "" when the path is usable, else why not. Absolute, no "..", no newline or
// other control character, no empty or "." segment, not ending in "/".
function binaryPathProblem(path) {
  var p = path === undefined || path === null ? "" : String(path)
  if (p === "") return "The binary path setting is empty."
  if (p.length > 4096) return "The binary path setting is too long."
  if (p.charAt(0) !== "/") return "The binary path must be absolute (start with /)."
  if (/[\u0000-\u001f\u007f]/.test(p)) return "The binary path must not contain a newline or control character."
  if (p.indexOf("..") !== -1) return "The binary path must not contain \"..\"."
  if (p === "/" || p.charAt(p.length - 1) === "/") return "The binary path must name a file, not a directory."
  var segs = p.slice(1).split("/")
  for (var i = 0; i < segs.length; i++)
    if (segs[i] === "" || segs[i] === ".") return "The binary path must not contain \"//\" or \"/./\"."
  return ""
}

// The setting as the widget reads it: a non-string or empty value is the
// default.
function binaryPathSetting(value) {
  return typeof value === "string" && value !== "" ? value : DEFAULT_BINARY
}

// Every ancestor directory of a valid path, nearest first, ending with "/".
function ancestorDirs(path) {
  if (binaryPathProblem(path) !== "") return []
  var out = []
  var p = String(path)
  while (true) {
    var cut = p.lastIndexOf("/")
    p = cut <= 0 ? "/" : p.slice(0, cut)
    out.push(p)
    if (p === "/") break
  }
  return out
}

// stat as an argv array, never through a shell, never -L (a symlink is
// reported as itself). %f is the raw mode in hex, so the type and the
// permission bits come without locale-dependent words; the name is last
// because it is the only field that can hold a tab.
var STAT_FORMAT = "%u\t%f\t%U\t%n"

function statArgv(path) {
  if (binaryPathProblem(path) !== "") return []
  return ["stat", "-c", STAT_FORMAT, "--", String(path)].concat(ancestorDirs(path))
}

// { path: { uid, mode, type: "file" | "dir" | "symlink" | "other", owner } }
// for every line stat printed (a missing path prints none).
function parseStat(text) {
  var out = {}
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var f = lines[i].split("\t")
    if (f.length < 4) continue
    var uid = parseInt(f[0], 10)
    var raw = parseInt(f[1], 16)
    if (!isFinite(uid) || !isFinite(raw) || !/^[0-9]+$/.test(f[0]) || !/^[0-9a-fA-F]+$/.test(f[1])) continue
    var fmt = raw & 0xF000
    var type = fmt === 0x8000 ? "file" : fmt === 0x4000 ? "dir" : fmt === 0xA000 ? "symlink" : "other"
    out[f.slice(3).join("\t")] = { uid: uid, mode: raw & 0xFFF, type: type, owner: f[2] }
  }
  return out
}

function ownerName(entry) {
  return entry.owner && entry.owner !== "UNKNOWN" ? entry.owner : "uid " + entry.uid
}

// Folders where a user can mount a filesystem or owns the files: a binary
// there is refused whatever stat says (a removable disk can claim any owner).
var USER_MOUNTS = ["/media", "/mnt", "/run/media", "/run/user"]

// The user mount a valid path is under, or "".
function userMountOf(path) {
  if (binaryPathProblem(path) !== "") return ""
  var p = String(path)
  for (var i = 0; i < USER_MOUNTS.length; i++)
    if (p === USER_MOUNTS[i] || p.indexOf(USER_MOUNTS[i] + "/") === 0) return USER_MOUNTS[i]
  return ""
}

// Whether the binary may be run at all, by pkexec for the switch or as the
// user for the debug read (debugReadArgv): { ok, kind, reason }. kind is "ok",
// "invalid" (the setting), "mount" (under a user mount), "missing",
// "symlink", "notfile", "owner", "mode" or "ancestor". The binary must be a regular file owned by root with no
// group or other write bit, and so must every directory above it (a
// directory the user can write lets the user swap the file).
function ownershipVerdict(path, stats) {
  var problem = binaryPathProblem(path)
  if (problem !== "") return { ok: false, kind: "invalid", reason: problem }
  var mount = userMountOf(path)
  if (mount !== "")
    return { ok: false, kind: "mount", reason: String(path) + " is under " + mount
      + ", where a user can mount or replace files. Install msi-mux-switch somewhere like " + DEFAULT_BINARY + "." }
  var s = stats || {}
  var p = String(path)
  var b = s[p]
  if (!b) return { ok: false, kind: "missing", reason: "msi-mux-switch was not found at " + p + "." }
  if (b.type === "symlink")
    return { ok: false, kind: "symlink", reason: p + " is a symbolic link; set the path to the real file." }
  if (b.type !== "file") return { ok: false, kind: "notfile", reason: p + " is not a regular file." }
  if (b.uid !== 0) return { ok: false, kind: "owner", reason: p + " is owned by " + ownerName(b) + ", not root." }
  if ((b.mode & 0x12) !== 0)
    return { ok: false, kind: "mode", reason: p + " is writable by group or others." }
  var dirs = ancestorDirs(p)
  for (var i = 0; i < dirs.length; i++) {
    var d = s[dirs[i]]
    if (!d) return { ok: false, kind: "ancestor", reason: dirs[i] + " could not be checked." }
    if (d.type === "symlink")
      return { ok: false, kind: "ancestor", reason: dirs[i] + " is a symbolic link; set the path to the real location." }
    if (d.type !== "dir") return { ok: false, kind: "ancestor", reason: dirs[i] + " is not a directory." }
    if (d.uid !== 0) return { ok: false, kind: "ancestor", reason: dirs[i] + " is owned by " + ownerName(d) + ", not root." }
    if ((d.mode & 0x12) !== 0)
      return { ok: false, kind: "ancestor", reason: dirs[i] + " is writable by group or others." }
  }
  return { ok: true, kind: "ok", reason: "" }
}

// Set up backend helps with every ownership problem except a bad setting or
// a user mount (setup.sh refuses those too).
function setupHelps(verdict) {
  return !!verdict && !verdict.ok && verdict.kind !== "invalid" && verdict.kind !== "mount" && verdict.kind !== ""
}

// ------------------------------------------------------------------ commands

// The read-only state read, as the user: `<binary> --debug --json [flags]`,
// which prints one pretty-printed JSON object of a few KiB. It runs only
// through debugReadArgv: the binary must pass the switch's own ownership
// gate first, on a stat taken right before the read. It runs under
// `timeout -k DEBUG_KILL_AFTER_S DEBUG_TIMEOUT_S` (TERM, then KILL, sent to
// the tool's whole process group), inside DEBUG_SCRIPT, which caps both
// streams while they are read (see there). The timeout and the tool's argv
// are positional arguments of the script, never part of its text.
var DEBUG_TIMEOUT_S = 10
var DEBUG_KILL_AFTER_S = 2

// The most of either stream of the debug read that is kept, in bytes.
var DEBUG_MAX_BYTES = 1048576

// Run with bash (Omarchy is built on it; setupArgv uses it too) for
// PIPESTATUS. "$@" is the command. Each stream passes through
// `head -c DEBUG_MAX_BYTES+1` while the command runs, so at most that much is
// ever read: once head has its fill it exits, and the command gets SIGPIPE
// on its next write (or the timeout ends it). tr turns NUL bytes into SUB
// (1:1, so the byte count holds; bash would drop them). Each stream is kept
// whole in the script and counted with wc -c (bytes, whatever the locale);
// then the script prints
//   stdout: the command's stdout, "\n", "status <exit status>", "\n"
//   stderr: the command's stderr, "\n", "end", "\n"
// or, for a stream over DEBUG_MAX_BYTES, "\nover\n" on that stream instead.
// The last line is always the script's own (the command's output comes
// before it), and a missing one means the read did not finish
// (parseDebugRead). The command's exit status is the first PIPESTATUS of the
// inner pipeline; the script itself exits 0.
var DEBUG_SCRIPT = [
  "exec 3>&1",
  "err=$(",
  "  {",
  "    out=$(\"$@\" 3>&- | head -c " + (DEBUG_MAX_BYTES + 1) + " | tr '\\000' '\\032'; printf 'x%s' \"${PIPESTATUS[0]}\")",
  "    status=${out##*x}",
  "    out=${out%x*}",
  "    if [ \"$(printf '%s' \"$out\" | wc -c)\" -gt " + DEBUG_MAX_BYTES + " ]; then printf '\\nover\\n' >&3",
  "    else printf '%s\\nstatus %s\\n' \"$out\" \"$status\" >&3",
  "    fi",
  "  } 2>&1 | head -c " + (DEBUG_MAX_BYTES + 1) + " | tr '\\000' '\\032'",
  "  printf x",
  ")",
  "err=${err%x}",
  "if [ \"$(printf '%s' \"$err\" | wc -c)\" -gt " + DEBUG_MAX_BYTES + " ]; then printf '\\nover\\n' >&2",
  "else printf '%s\\nend\\n' \"$err\" >&2",
  "fi"
].join("\n")

// The debug read's command: the tool under the timeout.
//
// The limit of that timeout: it signals the tool's process group, so a
// child of the tool that calls setsid() (or setpgid()) leaves the group and
// is never signalled. If such a child keeps stdout or stderr open, the
// streams stay open and the read does not end until the child exits; the
// byte caps of DEBUG_SCRIPT still hold, and a switch waiting on the read is
// still refused by the checks' watchdog (CHECK_TIMEOUT_MS). The read runs
// the binary the user configured, as the user, and only once it passed the
// ownership gate (debugReadArgv); a root-owned binary doing this on purpose
// is outside what these bounds defend against.
function debugCommand(path, flags) {
  if (binaryPathProblem(path) !== "") return []
  return ["timeout", "-k", String(DEBUG_KILL_AFTER_S), String(DEBUG_TIMEOUT_S), String(path), "--debug", "--json"]
    .concat(flags || [])
}

function debugArgv(path, flags) {
  var command = debugCommand(path, flags)
  return command.length === 0 ? [] : ["bash", "-c", DEBUG_SCRIPT, "msi-mux-debug"].concat(command)
}

// The debug read as the plugin runs it: debugArgv, or [] unless the binary
// passes ownershipVerdict for `stats` (parseStat of a stat taken right before
// it), the same gate as the switch. A binary owned by another account, in a
// folder a user can write or under a user mount, or a symbolic link, is never
// run, not even read-only.
function debugReadArgv(path, stats, flags) {
  if (!ownershipVerdict(path, stats).ok) return []
  return debugArgv(path, flags)
}

// The switch, through pkexec, as an argv array: no shell, nothing joined.
// --disable-internal-agent leaves authentication to the shell's polkit agent.
function switchArgv(path, mode, flags) {
  if (binaryPathProblem(path) !== "" || !isMode(mode)) return []
  return ["pkexec", "--disable-internal-agent", String(path), mode, "--json"].concat(flags || [])
}

var SHUTDOWN_ARGV = ["omarchy-system", "shutdown"]

// Right before pkexec: is an msi-mux-switch already running (a switch from a
// shell instance left behind by a reload, or one started by hand)?
var PGREP_ARGV = ["pgrep", "-x", "msi-mux-switch"]

function pgrepArgv() {
  return PGREP_ARGV.slice()
}

// "" when pgrep found none (exit 1), else why the switch may not start.
function runningProblem(exitCode) {
  if (exitCode === 1) return ""
  if (exitCode === 0) return "msi-mux-switch is already running (another switch may be in progress). Nothing was run."
  return "Could not check whether msi-mux-switch is already running. Nothing was run."
}

// The checks before a switch (stat, AC, and pgrep once this plugin's own
// debug read is over) get this long; then the switch is refused. Longer
// than a debug read can last (DEBUG_TIMEOUT_S + DEBUG_KILL_AFTER_S).
var CHECK_TIMEOUT_MS = 15000
var CHECK_TIMEOUT_TEXT = "The checks before the switch did not finish in time. Nothing was run."

// A switch asked for while checks the watchdog stopped are still ending
// (a stopped process takes a moment to exit): refused with this text, so
// the click is never a silent no-op. `running` says whether any of the stat,
// AC and pgrep checks is still running; "" when none is.
var CHECKS_ENDING_TEXT = "The previous checks are still ending. Try again in a moment. Nothing was run."

function checksEndingProblem(running) {
  return running === true ? CHECKS_ENDING_TEXT : ""
}

// Set up backend: the plugin's setup.sh in a floating terminal that stays
// open on its result. The script and the binary path are "$1" and "$2",
// never part of the script text.
var SETUP_SCRIPT = [
  "bash -- \"$1\" \"$2\"",
  "s=$?",
  "echo",
  "if [ \"$s\" -eq 0 ]; then echo 'setup.sh finished.'; else echo \"setup.sh stopped (exit status $s).\"; fi",
  "printf 'Press Enter to close. '",
  "read -r _"
].join("\n")

// The plugin's folder from the file:// URL of its manifest.json; "" for
// anything that is not a clean absolute path.
function pluginDirFromUrl(url) {
  var u = String(url === undefined || url === null ? "" : url)
  var tail = "/manifest.json"
  if (u.indexOf("file://") !== 0 || u.length > 4096) return ""
  var path
  try { path = decodeURIComponent(u.slice(7)) } catch (e) { return "" }
  if (path.length <= tail.length || path.slice(-tail.length) !== tail) return ""
  var dir = path.slice(0, -tail.length)
  return binaryPathProblem(dir) === "" ? dir : ""
}

function setupArgv(pluginDir, path) {
  if (binaryPathProblem(pluginDir) !== "" || binaryPathProblem(path) !== "") return []
  return ["omarchy-launch-tui", "--app-id=TUI.float", "bash", "-c", SETUP_SCRIPT, "msi-mux-setup",
    String(pluginDir) + "/setup.sh", String(path)]
}

// ---------------------------------------------------------------- debug read

function emptyDebug() {
  return { ok: false, error: "", current: "", target: "", pending: false, modes: [] }
}

// FirmwareInfo::available_modes: none without the new switch; MSHybrid
// always with it, plus Discrete and Integrated where supported.
function availableModes(fw) {
  if (!fw || fw.new_switch_supported !== true) return []
  var out = ["mshybrid"]
  if (fw.discrete_supported === true) out.unshift("discrete")
  if (fw.integrated_supported === true) out.push("integrated")
  return out
}

function isPending(current, target) {
  return isMode(current) && isMode(target) && current !== target
}

// The first error event's message in a stream of JSON lines, or "".
function firstErrorMessage(text) {
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var ev = parseEventLine(lines[i])
    if (ev && ev.level === "error" && ev.message !== "") return ev.message
  }
  return ""
}

// The most of the debug read's output that is parsed (it prints a few KiB).
var DEBUG_MAX_CHARS = 1048576

// The `--debug --json` result: stdout is one JSON object (exit 0); a failure
// is an error line on stderr (exit 1). Output past DEBUG_MAX_CHARS on either
// stream is refused unread.
function parseDebug(stdout, stderr, exitCode) {
  var out = emptyDebug()
  if (String(stdout || "").length > DEBUG_MAX_CHARS || String(stderr || "").length > DEBUG_MAX_CHARS) {
    out.error = "msi-mux-switch --debug printed more than 1 MiB; not read."
    return out
  }
  var err = firstErrorMessage(stderr)
  if (exitCode !== 0 && exitCode !== undefined && exitCode !== null) {
    out.error = err !== "" ? err : "msi-mux-switch --debug failed (exit status " + exitCode + ")."
    return out
  }
  var doc
  try { doc = JSON.parse(String(stdout || "")) } catch (e) { doc = null }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    out.error = err !== "" ? err : "msi-mux-switch --debug gave no readable answer."
    return out
  }
  var fw = doc.firmware
  if (!fw || typeof fw !== "object" || fw.available !== true || !fw.value || typeof fw.value !== "object") {
    var why = fw && typeof fw.error === "string" && fw.error !== "" ? ": " + fw.error : "."
    out.error = "The firmware's GPU mode could not be read" + why
    return out
  }
  out.ok = true
  out.current = modeFromJson(fw.value.current_mode)
  out.target = modeFromJson(fw.value.selected_target_mode)
  out.pending = isPending(out.current, out.target)
  out.modes = availableModes(fw.value)
  return out
}

// One stream of DEBUG_SCRIPT: { body, tail } (tail: its last line, the
// script's own), or null when it does not end in a line of the script's.
function splitDebugStream(text) {
  var t = String(text === undefined || text === null ? "" : text)
  if (t.length === 0 || t.charAt(t.length - 1) !== "\n") return null
  t = t.slice(0, -1)
  var nl = t.lastIndexOf("\n")
  if (nl === -1) return null
  return { body: t.slice(0, nl), tail: t.slice(nl + 1) }
}

var DEBUG_OVER_TEXT = "msi-mux-switch --debug printed more than 1 MiB; not read."
var DEBUG_TIMEOUT_TEXT = "msi-mux-switch --debug did not answer within " + DEBUG_TIMEOUT_S + " s."

// The debug read's result from DEBUG_SCRIPT's two streams and its own exit
// status: a stream over the cap is refused unread, an unfinished read (no
// last line of the script's, or the script failing) is an error, and the
// timeout's exit statuses (124: TERM, 137: KILL) say so; anything else is
// parseDebug of the command's own output and exit status.
function parseDebugRead(stdout, stderr, exitCode) {
  var out = splitDebugStream(stdout)
  var err = splitDebugStream(stderr)
  if ((out && out.tail === "over") || (err && err.tail === "over")) {
    var over = emptyDebug()
    over.error = DEBUG_OVER_TEXT
    return over
  }
  var status = out ? /^status (\d{1,3})$/.exec(out.tail) : null
  if (exitCode !== 0 || !status || !err || err.tail !== "end") {
    var unfinished = emptyDebug()
    unfinished.error = "msi-mux-switch --debug did not finish (exit status " + exitCode + ")."
    return unfinished
  }
  var code = Number(status[1])
  if (code === 124 || code === 137) {
    var late = emptyDebug()
    late.error = DEBUG_TIMEOUT_TEXT
    return late
  }
  return parseDebug(out.body, err.body, code)
}

// ------------------------------------------------------------ switch events

// One line of the switch's stdout or stderr as { event, level, message,
// data }, or null for anything that is not a JSON event object.
function parseEventLine(line) {
  var s = String(line === undefined || line === null ? "" : line).trim()
  if (s === "" || s.charAt(0) !== "{") return null
  var o
  try { o = JSON.parse(s) } catch (e) { return null }
  if (!o || typeof o !== "object" || Array.isArray(o) || typeof o.event !== "string") return null
  return {
    event: o.event,
    level: typeof o.level === "string" ? o.level : "",
    message: typeof o.message === "string" ? o.message : "",
    data: o.data === undefined ? null : o.data
  }
}

// What a run keeps: the last MAX_EVENTS event names, the first MAX_MESSAGES
// errors and warnings, each at most MAX_LINE_CHARS long. Longer lines are
// not parsed.
var MAX_EVENTS = 500
var MAX_MESSAGES = 20
var MAX_LINE_CHARS = 65536
var MAX_MESSAGE_CHARS = 500

function newSwitchRun() {
  return { events: [], success: false, unchanged: false, errors: [], warnings: [], triggerSent: false,
    other: 0, firstOther: "" }
}

// The switch's output arrives in raw chunks and is cut into lines here, not
// by a line-mode parser, so a line that never ends cannot grow without
// bound. A per-stream buffer holds at most MAX_LINE_CHARS + 1 characters:
// past that, the rest of the line is dropped up to the next "\n", and the
// (MAX_LINE_CHARS + 1)-character prefix stands for the line, so
// applySwitchLine still rejects it as too long.
function newLineBuffer() {
  return { text: "", over: false }
}

function addToLine(buf, part) {
  if (buf.over) return
  var room = MAX_LINE_CHARS + 1 - buf.text.length
  buf.text += part.length > room ? part.slice(0, room) : part
  if (buf.text.length > MAX_LINE_CHARS) buf.over = true
}

// Folds a chunk into buf, in place, and returns the lines it completed
// (split on "\n" only; empty lines included).
function splitChunk(buf, chunk) {
  var parts = String(chunk === undefined || chunk === null ? "" : chunk).split("\n")
  var lines = []
  for (var i = 0; i < parts.length; i++) {
    addToLine(buf, parts[i])
    if (i === parts.length - 1) break
    lines.push(buf.text)
    buf.text = ""
    buf.over = false
  }
  return lines
}

// The unterminated tail, or null when the output ended with "\n" (or
// nothing came). Resets buf.
function flushLine(buf) {
  var tail = buf.text === "" ? null : buf.text
  buf.text = ""
  buf.over = false
  return tail
}

function clip(text) {
  var t = String(text)
  return t.length > MAX_MESSAGE_CHARS ? t.slice(0, MAX_MESSAGE_CHARS) + "…" : t
}

function keep(list, text) {
  if (list.length < MAX_MESSAGES) list.push(clip(text))
}

// Folds one output line into a run, in place, and returns it. A line that is
// not a JSON event (pkexec's own messages) is counted, and the first one
// kept. Warnings the user cannot act on here (bitlocker_reminder is a
// Windows reminder the tool always prints on the apply path) are dropped.
function applySwitchLine(run, line) {
  var r = run || newSwitchRun()
  var raw = String(line === undefined || line === null ? "" : line)
  var ev = raw.length > MAX_LINE_CHARS ? null : parseEventLine(raw)
  if (!ev) {
    var t = raw.trim()
    if (t !== "") {
      r.other++
      if (r.firstOther === "") r.firstOther = clip(t)
    }
    return r
  }
  r.events.push(ev.event)
  if (r.events.length > MAX_EVENTS) r.events.splice(0, r.events.length - MAX_EVENTS)
  if (ev.event === "success") r.success = true
  else if (ev.event === "unchanged") r.unchanged = true
  else if (ev.event === "error" || ev.event === "cli_error" || ev.level === "error")
    keep(r.errors, ev.message !== "" ? ev.message : ev.event)
  else if (ev.event === "trigger_sent_before_failure") r.triggerSent = true
  else if (ev.level === "warning" && ev.event !== "bitlocker_reminder")
    keep(r.warnings, ev.message !== "" ? ev.message : ev.event)
  return r
}

var TRIGGER_WARNING = "The firmware may already have received the switch. Save your work and do a full shutdown (not a reboot)."

// Once a switch is staged, the firmware's apply-ready flag stays set until a
// full shutdown, and the tool refuses every further mode run with
// STAGED_LOCK_ERROR: a staged switch can be neither replaced nor cancelled.
// A failed switch that rolled back can leave the flag set with nothing
// staged (target equal to current): the same refusal then reads
// FIRMWARE_FLAG_TEXT.
var STAGED_LOCK_TEXT = "A switch is staged. It can't be changed or cancelled until after a full shutdown."
var FIRMWARE_FLAG_TEXT = "The firmware still has a switch in progress. A full shutdown clears it."
var STAGED_LOCK_ERROR = "apply-ready is already set before any write"

// What a finished run means: { kind, message, warning, offerShutdown }, plus
// lock: true on the tool's apply-ready refusal.
// kind: "success" | "unchanged" | "auth-cancelled" | "not-authorized" |
// "error". Success needs both the success event and exit status 0. pkexec's
// own 126 and 127 are the dialog dismissed and authorization refused;
// pkexec's own explanation (the first line that is not a JSON event, e.g.
// "No authentication agent found.") is added to the 127 message. The tool's
// refusal (STAGED_LOCK_ERROR) is STAGED_LOCK_TEXT while the debug read shows
// a switch staged (`staged`), else FIRMWARE_FLAG_TEXT.
function switchOutcome(run, exitCode, mode, staged) {
  var r = run || newSwitchRun()
  var warning = r.triggerSent ? TRIGGER_WARNING : ""
  var notes = r.warnings.length ? " " + r.warnings.join(" ") : ""
  if (exitCode === 126 && !r.success)
    return { kind: "auth-cancelled", message: "Authentication cancelled. Nothing was changed.", warning: warning, offerShutdown: false }
  if (exitCode === 127 && !r.success) {
    var said = r.firstOther ? " pkexec said: " + r.firstOther : ""
    return { kind: "not-authorized", message: "Not authorized to switch the GPU mode. Nothing was changed." + said, warning: warning, offerShutdown: false }
  }
  if (exitCode === 0 && r.success && r.errors.length === 0)
    return { kind: "success", message: modeLabel(mode) + " is staged. It takes effect after a full shutdown." + notes, warning: warning, offerShutdown: true }
  if (exitCode === 0 && r.unchanged && r.errors.length === 0)
    return { kind: "unchanged", message: "Already in " + modeLabel(mode) + ". Nothing was changed.", warning: warning, offerShutdown: false }
  if (exitCode < 0 && r.events.length === 0)
    return { kind: "error", message: "pkexec could not be started. Nothing was changed.", warning: warning, offerShutdown: false }
  if (r.errors.length && r.errors[0].indexOf(STAGED_LOCK_ERROR) !== -1)
    return { kind: "error", message: staged === true ? STAGED_LOCK_TEXT : FIRMWARE_FLAG_TEXT, warning: warning, offerShutdown: false, lock: true }
  var why = r.errors.length ? r.errors[0] : exitCode === 0
    ? "msi-mux-switch did not report success."
    : "msi-mux-switch failed (exit status " + exitCode + ")."
  return { kind: "error", message: why + notes, warning: warning, offerShutdown: false }
}

// ---------------------------------------------------------------------- AC

// Every power supply whose type is Mains, with its online value, then "end".
// "$1" is the power-supply class directory.
var POWER_SUPPLY_DIR = "/sys/class/power_supply"
var AC_SCRIPT = [
  "for d in \"$1\"/*; do",
  "  t=$(head -c 64 -- \"$d/type\" 2>/dev/null | tr -d '\\n\\r')",
  "  [ \"$t\" = Mains ] || continue",
  "  o=$(head -c 8 -- \"$d/online\" 2>/dev/null | tr -d '\\n\\r')",
  "  printf 'mains %s\\n' \"$o\"",
  "done",
  "printf 'end\\n'"
].join("\n")
var AC_POLL_MS = 2000

function acArgv() {
  return ["sh", "-c", AC_SCRIPT, "msi-mux-ac", POWER_SUPPLY_DIR]
}

// true (a Mains supply is online), false (Mains found, none online), or null
// (no Mains supply, or no end line).
function parseAc(text) {
  var lines = String(text || "").split("\n")
  var found = false, online = false, ended = false
  for (var i = 0; i < lines.length; i++) {
    if (lines[i] === "end") { ended = true; break }
    var m = /^mains (.*)$/.exec(lines[i])
    if (!m) continue
    found = true
    if (m[1].trim() === "1") online = true
  }
  if (!ended || !found) return null
  return online
}

var AC_REQUIRED_TEXT = "Connect AC power — the switch requires it."
var AC_UNKNOWN_TEXT = "The AC power state could not be read — the switch requires AC power."

function acText(ac) {
  if (ac === true) return "AC power connected."
  if (ac === false) return "On battery. " + AC_REQUIRED_TEXT
  return AC_UNKNOWN_TEXT
}

// ------------------------------------------------------------ the env file

// The one file the plugin may write: a uwsm env.d drop-in choosing the GPU
// Hyprland composites on in MSHybrid. Auto means no file.
var ENV_FILE_NAME = "90-msi-mux-gpu"
var ENV_CHOICES = ["auto", "intel", "rtx"]
var ENV_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "intel", label: "Intel" },
  { value: "rtx", label: "RTX" }
]
var ENV_MARKER = "# msi-mux-base: "
var LOGOUT_TEXT = "Log out to apply."
var ENV_PENDING_TEXT = "Applies after the shutdown into MSHybrid."
var ENV_INERT_TEXT = "Saved. Takes effect only in MSHybrid."

function cleanHome(home) {
  var h = home === undefined || home === null ? "" : String(home)
  return binaryPathProblem(h) === "" ? h : ""
}

function envDir(home) {
  var h = cleanHome(home)
  return h === "" ? "" : h + "/.config/uwsm/env.d"
}

function envFilePath(home) {
  var d = envDir(home)
  return d === "" ? "" : d + "/" + ENV_FILE_NAME
}

// The write's temporary file, in env.d: dot-prefixed, so uwsm's `env.d/*`
// never sources it. The previous build's temporary name is still removed.
var ENV_TEMP_NAME = "." + ENV_FILE_NAME + ".tmp"
var ENV_LEGACY_TEMP_NAME = ENV_FILE_NAME + ".new"

// The removal: the file and the two temporary names, nothing else. Never
// recursive: a directory at the path is left in place and the removal fails.
function envRemoveArgv(home) {
  var d = envDir(home)
  if (d === "") return []
  return ["rm", "-f", "--", d + "/" + ENV_FILE_NAME, d + "/" + ENV_TEMP_NAME, d + "/" + ENV_LEGACY_TEMP_NAME]
}

// The read: the file's kind on the first line ("absent", "other" for a
// symbolic link or anything but a regular file, "file"), then for a regular
// file at most ENV_MAX_BYTES + 1 bytes of it. "$1" is the file.
var ENV_MAX_BYTES = 65536
var ENV_READ_SCRIPT = [
  "if [ -L \"$1\" ]; then echo other",
  "elif [ ! -e \"$1\" ]; then echo absent",
  "elif [ ! -f \"$1\" ]; then echo other",
  "else echo file; head -c " + (ENV_MAX_BYTES + 1) + " -- \"$1\"",
  "fi"
].join("\n")

function envReadArgv(home) {
  var f = envFilePath(home)
  return f === "" ? [] : ["sh", "-c", ENV_READ_SCRIPT, "msi-mux-env-read", f]
}

// The dropdown's value from the read's output: absent is "auto"; a regular
// file is read by envChoiceFromFile (over ENV_MAX_BYTES is "modified");
// anything else, including no answer, is "modified".
function parseEnvRead(text) {
  var t = String(text === undefined || text === null ? "" : text)
  var nl = t.indexOf("\n")
  var kind = nl === -1 ? t : t.slice(0, nl)
  if (kind === "absent") return "auto"
  if (kind !== "file" || nl === -1) return "modified"
  var body = t.slice(nl + 1)
  if (body.length > ENV_MAX_BYTES) return "modified"
  return envChoiceFromFile(body)
}

// The write: env.d created, the text written to ENV_TEMP_NAME beside the
// target, then renamed over it with `mv -fT` (a symbolic link there is
// replaced, never followed; a directory there is never moved into: the
// rename fails). The temporary file is removed on any failure. The previous
// build's temporary name (sourced by uwsm, having no dot) is removed first
// when an old build left it: `rm -f`, never recursive, so a symbolic link
// there is removed, not followed, and a directory there stays (the write
// goes on). "$1" is env.d, "$2" the file, "$3" the text.
var ENV_WRITE_SCRIPT = [
  "mkdir -p -- \"$1\" || exit 1",
  "rm -f -- \"$1/" + ENV_LEGACY_TEMP_NAME + "\" 2>/dev/null",
  "t=\"$1/" + ENV_TEMP_NAME + "\"",
  "rm -f -- \"$t\" || exit 1",
  "( umask 022 && printf '%s' \"$3\" >\"$t\" ) || { rm -f -- \"$t\"; exit 1; }",
  "mv -fT -- \"$t\" \"$2\" || { rm -f -- \"$t\"; exit 1; }"
].join("\n")

function envWriteArgv(home, base) {
  var d = envDir(home)
  var text = envFileText(base)
  if (d === "" || text === "") return []
  return ["sh", "-c", ENV_WRITE_SCRIPT, "msi-mux-env-write", d, envFilePath(home), text]
}

// The file's whole text for base "intel" or "rtx"; "" for anything else.
// POSIX sh, sourced by uwsm at login inside a function, with IFS possibly
// changed: it never exits or returns, sets no option, prints nothing on
// either stream, exports AQ_DRM_DEVICES only when both GPUs are present,
// and leaves no variable of its own behind.
function envFileText(base) {
  if (base !== "intel" && base !== "rtx") return ""
  var first = base === "rtx" ? "msi_mux_nvidia" : "msi_mux_intel"
  var second = base === "rtx" ? "msi_mux_intel" : "msi_mux_nvidia"
  var name = base === "rtx" ? "the RTX (NVIDIA) GPU" : "the Intel GPU"
  return [
    "# Written by the MSI GPU MUX Omarchy plugin (" + PLUGIN_ID + ").",
    ENV_MARKER + base,
    "#",
    "# In MSHybrid mode, makes Hyprland composite on " + name + ": when both",
    "# an Intel and an NVIDIA GPU are present, AQ_DRM_DEVICES lists that GPU",
    "# first. With only one GPU present (Discrete or Integrated mode) it",
    "# exports nothing. uwsm sources this file at login; it prints nothing.",
    "#",
    "# To remove the effect, pick Auto in the plugin, or delete this file and",
    "# log out.",
    "",
    "msi_mux_intel=",
    "msi_mux_nvidia=",
    "for msi_mux_card in /sys/class/drm/card*; do",
    "  case ${msi_mux_card##*/} in",
    "    *-*) continue ;;",
    "  esac",
    "  msi_mux_vendor=$(cat \"$msi_mux_card/device/vendor\" 2>/dev/null) || msi_mux_vendor=",
    "  case $msi_mux_vendor in",
    "    0x8086) [ -n \"$msi_mux_intel\" ] || msi_mux_intel=/dev/dri/${msi_mux_card##*/} ;;",
    "    0x10de) [ -n \"$msi_mux_nvidia\" ] || msi_mux_nvidia=/dev/dri/${msi_mux_card##*/} ;;",
    "  esac",
    "done",
    "if [ -n \"$msi_mux_intel\" ] && [ -n \"$msi_mux_nvidia\" ]; then",
    "  export AQ_DRM_DEVICES=\"$" + first + ":$" + second + "\"",
    "fi",
    "unset msi_mux_intel msi_mux_nvidia msi_mux_card msi_mux_vendor",
    ""
  ].join("\n")
}

// The dropdown's value from the file: null (absent) is "auto"; the plugin's
// own text for a base is that base; anything else is "modified" (the file
// exists but is not what the plugin wrote).
function envChoiceFromFile(text) {
  if (text === null || text === undefined) return "auto"
  var t = String(text)
  var m = /^# msi-mux-base: ([a-z]+)$/m.exec(t)
  if (m && (m[1] === "intel" || m[1] === "rtx") && t === envFileText(m[1])) return m[1]
  return "modified"
}

function isEnvChoice(value) {
  return ENV_CHOICES.indexOf(value) !== -1
}

// The status after an env pick, from the MUX state (Model.parseDebug's
// current, pending and target): the file acts only in MSHybrid.
function envStatusText(debug) {
  var d = debug || {}
  if (d.current === "mshybrid") return LOGOUT_TEXT
  if (d.pending === true && d.target === "mshybrid") return ENV_PENDING_TEXT
  return ENV_INERT_TEXT
}

var ENV_MODIFIED_TEXT = "~/.config/uwsm/env.d/" + ENV_FILE_NAME + " was changed outside the plugin. Picking an option replaces or removes it."

// ------------------------------------------------------------- what to show

// The bar glyph and its state: { icon, dimmed, badge }.
function barState(s) {
  var st = s || {}
  var debug = st.debug || emptyDebug()
  return {
    icon: modeIcon(debug.current),
    dimmed: !st.available || !debug.ok,
    badge: debug.ok && debug.pending
  }
}

function pendingText(target) {
  return modeLabel(target) + " after full shutdown"
}

// The panel's one-line meta under the title; short enough not to elide.
// blocked: no debug read can run (the hardware or the backend is refused),
// so the mode is unknown, whatever an earlier read said, rather than still
// coming.
function summary(debug, blocked) {
  var d = debug || emptyDebug()
  if (blocked === true) return "GPU mode unknown"
  if (!d.ok) return d.error !== "" ? "GPU mode unknown" : "Reading the GPU mode…"
  if (!isMode(d.current)) return "Current mode not recognised"
  if (d.pending) return modeLabel(d.current) + " → " + modeLabel(d.target) + " after shutdown"
  return "Current: " + modeLabel(d.current)
}

function tooltipText(s) {
  var st = s || {}
  var d = st.debug || emptyDebug()
  var lines = [DISPLAY_NAME + ": " + (d.ok && isMode(d.current) ? modeLabel(d.current) : "mode unknown")]
  if (d.ok && d.pending) lines.push(pendingText(d.target))
  if (st.unavailableReason) lines.push(st.unavailableReason)
  return lines.join("\n")
}

// Why every switch button is disabled right now, or "" when they may run.
// Order: what the user must fix first.
function switchBlocker(s) {
  var st = s || {}
  if (st.unavailableReason) return st.unavailableReason
  if (!st.debug || !st.debug.ok) return st.debug && st.debug.error ? st.debug.error : "Reading the GPU mode…"
  if (st.busy) return "A switch is in progress."
  if (st.ac !== true) return st.ac === false ? AC_REQUIRED_TEXT : AC_UNKNOWN_TEXT
  return ""
}

// Why a row's button is disabled, short, for the row itself (the full
// reason is shown once, above the modes).
var ROW_REASON = {
  unavailable: "Unavailable: see above.",
  unread: "Waiting for the GPU mode.",
  busy: "Wait for the switch in progress.",
  battery: "Needs AC power.",
  acUnknown: "Needs AC power (state unknown).",
  notOffered: "Not offered by this firmware."
}

function rowReason(st) {
  if (st.unavailableReason) return ROW_REASON.unavailable
  if (!st.debug || !st.debug.ok) return ROW_REASON.unread
  if (st.busy) return ROW_REASON.busy
  if (st.ac !== true) return st.ac === false ? ROW_REASON.battery : ROW_REASON.acUnknown
  return ""
}

// One row per mode: { mode, label, description, icon, status, action:
// "switch" | "", buttonText, enabled, reason }. reason is set whenever the
// row has no enabled button for a reason the user can act on or should know
// (not for the current or the staged mode, which say so in status). While a
// switch is staged no row has a button: the tool refuses any further mode
// run until a full shutdown (STAGED_LOCK_TEXT, shown once by the panel).
function modeRows(s) {
  var st = s || {}
  var d = st.debug || emptyDebug()
  var blocker = switchBlocker(st)
  var why = rowReason(st)
  var rows = []
  for (var i = 0; i < MODES.length; i++) {
    var m = MODES[i]
    var row = { mode: m, label: modeLabel(m), description: MODE_DESCRIPTIONS[m], icon: ICON[m],
      status: "", action: "switch", buttonText: "Switch", enabled: blocker === "", reason: blocker === "" ? "" : why }
    if (d.ok && d.modes.indexOf(m) === -1) {
      row.action = ""
      row.enabled = false
      row.reason = ROW_REASON.notOffered
    } else if (d.ok && m === d.current) {
      row.status = "Current mode."
      row.action = ""
      row.enabled = false
      row.reason = ""
    } else if (d.ok && m === d.target && d.pending) {
      row.status = "Staged: takes effect after a full shutdown."
      row.action = ""
      row.enabled = false
      row.reason = ""
    } else if (d.ok && d.pending) {
      row.action = ""
      row.enabled = false
      row.reason = ""
    }
    rows.push(row)
  }
  return rows
}

// msi-mux-switch's own reminder before a firmware switch (its
// recovery_key_warning): have any full-disk-encryption recovery key
// available off the machine. Shown in every mode's confirmation.
var RECOVERY_KEY_TEXT = "If your disk is encrypted, have its recovery key saved off this laptop before switching."

function confirmMessage(mode, warnIntegrated) {
  var msg = "Switch to " + modeLabel(mode) + "? It takes effect after a full shutdown (a reboot is not enough). You will be asked to authenticate."
  if (mode === "integrated" && warnIntegrated !== false)
    msg += "\n\nIntegrated uses the Intel GPU only: external screens wired to the RTX will probably stay dark."
  return msg + "\n\n" + RECOVERY_KEY_TEXT
}

var SHUTDOWN_MESSAGE = "The switch is staged. Shut down now to apply it? Save your work first. A reboot does not apply it; it needs a full shutdown and power-on. The laptop may power itself back on afterwards; that's normal."
var SHUTDOWN_FLAG_MESSAGE = "The firmware still has a switch in progress. Shut down now to clear it? Save your work first. A reboot is not enough; it needs a full shutdown and power-on. The laptop may power itself back on afterwards; that's normal."

// The shutdown dialog's text for a lockNotice kind ("flag", else staged).
function shutdownMessage(kind) {
  return kind === "flag" ? SHUTDOWN_FLAG_MESSAGE : SHUTDOWN_MESSAGE
}

// The line under the mode rows that offers Shut down now: { kind, text,
// urgent }. kind "staged" while the debug read shows a switch staged,
// "flag" after an apply-ready refusal with nothing staged (the leftover
// firmware flag), else "" (no line). urgent: it answers a refused switch.
function lockNotice(s) {
  var st = s || {}
  var d = st.debug || emptyDebug()
  var refused = st.busy !== true && !!st.outcome && st.outcome.lock === true
  if (d.ok && d.pending) return { kind: "staged", text: STAGED_LOCK_TEXT, urgent: refused }
  if (refused) return { kind: "flag", text: FIRMWARE_FLAG_TEXT, urgent: true }
  return { kind: "", text: "", urgent: false }
}

// After a switch this widget asked for: whether the shutdown dialog opens by
// itself. Never when the panel had to reopen itself to show the result: the
// panel takes the keyboard on opening, and the user may be typing into
// another window by then. The lock line's Shut down now stays the way in.
function offerShutdownAfterSwitch(outcome, reopened) {
  return reopened !== true && !!outcome && outcome.offerShutdown === true
}

// ------------------------------------------------------------ dialog keys

// The Qt key codes (Qt::Key) a dialog in the panel takes.
var KEY = {
  Escape: 0x01000000,
  Tab: 0x01000001,
  Backtab: 0x01000002,
  Return: 0x01000004,
  Enter: 0x01000005,
  Left: 0x01000012,
  Right: 0x01000014
}

// What a key does while a dialog is open, from its key code alone: the set
// of the shell's own ConfirmDialog. "toggle" (Left, Right, Tab, Backtab)
// picks the other button, "activate" (Return, Enter) presses the selected
// one, "close" (Escape) dismisses; "" for every other key, so letters
// (h and l included) and Space do nothing.
function dialogKeyAction(key) {
  if (key === KEY.Escape) return "close"
  if (key === KEY.Left || key === KEY.Right || key === KEY.Tab || key === KEY.Backtab) return "toggle"
  if (key === KEY.Return || key === KEY.Enter) return "activate"
  return ""
}

// The shell's ConfirmDialog selects the button under the pointer when the
// pointer enters it. Qt also sends that enter when the button slides under
// a resting pointer: the dialog opening where Switch or Shut down now was
// just clicked, or a layout change under an open dialog (the panel's
// height animation, a status read changing its content). Enter would then
// press the confirm button. So a hover never selects it: the button a
// dialog keeps after its selection changed to `index` is
//   - the safe button (DIALOG_SAFE_INDEX: Cancel, Later), always;
//   - the confirm button only when the change came from the dialog's keys
//     (o.keyed: Left/Right/Tab/Backtab);
//   - the safe button for anything else, a hover included.
// A click on a button acts on that button whatever is selected.
var DIALOG_SAFE_INDEX = 0

function dialogSelection(index, o) {
  var opt = o || {}
  return index === 1 && opt.keyed === true ? 1 : DIALOG_SAFE_INDEX
}

// ------------------------------------------------------- reopened panel keys

// A panel that reopened itself to show a finished switch takes the keyboard
// on opening, while the user may be typing into another window. Until a
// deliberate action it is key-inert: every key but Esc does nothing, and no
// cursor shows. keysInert is the state after `what` happened, from `inert`,
// the state before:
//   "selfOpen"  the panel reopened itself for the result: inert
//   "userOpen"  any other opening (the bar button, IPC, Tab from another
//               panel): not inert
//   "pointer"   the pointer moved over the panel or pressed on it: not inert
//   "close"     the panel closed: not inert
// Anything else leaves it as it was.
function keysInert(inert, what) {
  if (what === "selfOpen") return true
  if (what === "userOpen" || what === "pointer" || what === "close") return false
  return inert === true
}

// What a key does on a key-inert panel, from its key code alone: "close"
// for Escape, "" (nothing) for every other key.
function inertKeyAction(key) {
  return key === KEY.Escape ? "close" : ""
}

// Which item has the panel's keyboard focus: "inert" (a key-inert panel,
// dialog or not), "dialog" (a dialog is open), else "panel" (the catcher).
function keyTarget(s) {
  var st = s || {}
  if (st.inert === true) return "inert"
  if (st.dialogOpen === true) return "dialog"
  return "panel"
}

// Pointer positions over a key-inert panel, in window coordinates: only a
// real move wakes it. A panel opening under a resting pointer gets a hover
// event without the pointer moving, and so do layout changes, so the first
// position is only a sample: a later one is a move once it is more than
// POINTER_MOVE_PX away from it on either axis. Returns { sample, moved }:
// the sample to keep (null before the first) and whether this was a move.
var POINTER_MOVE_PX = 2

function pointerMove(sample, x, y) {
  var px = Number(x), py = Number(y)
  if (!isFinite(px) || !isFinite(py)) return { sample: sample || null, moved: false }
  if (!sample) return { sample: { x: px, y: py }, moved: false }
  var moved = Math.abs(px - sample.x) > POINTER_MOVE_PX || Math.abs(py - sample.y) > POINTER_MOVE_PX
  return { sample: sample, moved: moved }
}

// The pointer over a key-inert panel during its focus prime (the shell's
// KeyboardPanel.focusPrimed is false for the first 75 ms after it opens):
// the compositor reports where the pointer already is while the window
// comes up, so nothing then is a move or a deliberate press. A position
// before `primed` is dropped, never kept as the sample (the sample is taken
// from the first position after it); after it, this is pointerMove.
function inertPointer(sample, x, y, primed) {
  if (primed !== true) return { sample: null, moved: false }
  return pointerMove(sample, x, y)
}

// A press on a key-inert panel: "wake" after the focus prime (the press
// then goes on to the control under it), "swallow" before it (the press
// reaches nothing and the panel stays inert).
function inertPress(primed) {
  return primed === true ? "wake" : "swallow"
}

// The setting as the widget reads it: anything but false is true.
function warnSetting(value) {
  return value !== false
}

// ---------------------------------------------------------------- cursor

// The panel's keyboard cursor stands on one control, named by a key:
//   setup  mode|<mode>  shutdown  env
// in screen order: Set up backend (when offered), each mode row's enabled
// button (none while a switch is staged), Shut down now on the lock line
// (when shown, see lockNotice), the Hyprland base GPU dropdown (always
// shown). Disabled controls are not stops. Up/Down (and Left/Right) step
// through them.
function cursorStops(rows, o) {
  var opt = o || {}
  var stops = []
  if (opt.canSetUp === true) stops.push("setup")
  var list = Array.isArray(rows) ? rows : []
  for (var i = 0; i < list.length; i++) {
    var r = list[i]
    if (r && r.action !== "" && r.enabled) stops.push("mode|" + r.mode)
  }
  if (opt.canShutDown === true) stops.push("shutdown")
  stops.push("env")
  return stops
}

// { kind: "setup" | "mode" | "shutdown" | "env" | "", arg }
function cursorAction(key) {
  var k = String(key === undefined || key === null ? "" : key)
  if (k === "setup" || k === "env" || k === "shutdown") return { kind: k, arg: "" }
  if (k.indexOf("mode|") === 0 && isMode(k.slice(5))) return { kind: "mode", arg: k.slice(5) }
  return { kind: "", arg: "" }
}

// The key the cursor really stands on: `key` while it is a stop, else the
// first stop ("" when there is none).
function cursorKeyIn(stops, key) {
  if (!stops || stops.length === 0) return ""
  return stops.indexOf(key) !== -1 ? key : stops[0]
}

// One step from `key` (dy, or dx when dy is 0); stops at either end.
function stepCursor(stops, key, dx, dy) {
  if (!stops || stops.length === 0) return ""
  var at = stops.indexOf(key)
  if (at === -1) return stops[0]
  var d = dy !== 0 ? dy : dx
  if (d === 0) return key
  return stops[Math.max(0, Math.min(stops.length - 1, at + (d > 0 ? 1 : -1)))]
}
