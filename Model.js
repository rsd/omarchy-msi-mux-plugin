// MSI GPU MUX: the pure logic. Every parse, argv, verdict and string the
// QML shows is here, so tests/model-test.js can check it without a shell.
//
// Written as a QML JS module: bare function declarations and vars, no
// exports. Nothing here starts a process, reads a file or touches state.

// ------------------------------------------------------------------ identity

var PLUGIN_ID = "io.github.rsd.msi-mux"
var DISPLAY_NAME = "MSI GPU MUX"
// Where msi-mux-switch is looked for when the binaryPath setting is empty
// ("auto", binaryPathSetting): the msi-gpu-mux-switch(-bin) packages'
// /usr/bin first, then the /opt folder setup.sh makes safe for a binary
// built or downloaded by hand (autoChoice).
var USR_BINARY = "/usr/bin/msi-mux-switch"
var OPT_BINARY = "/opt/msi-mux-switch/msi-mux-switch"
var PACKAGE_NAME = "msi-gpu-mux-switch"
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

// The setting as the widget reads it: "" (auto: firstCandidate, then
// autoChoice) for a non-string or empty value, else the value as given, which
// always wins (a bad one is refused, never replaced).
function binaryPathSetting(value) {
  return typeof value === "string" ? value : ""
}

// The path the status read gates first: the setting, or in auto USR_BINARY.
function firstCandidate(setting) {
  return binaryPathSetting(setting) !== "" ? String(setting) : USR_BINARY
}

// Whether a gate read of USR_BINARY (parseGateRead) says, definitively, that
// nothing is there: the read finished whole (fuse.conf line, the same stats
// twice, the mount table read), stat printed every folder above it as a
// directory owned by root and searchable by others, and printed nothing
// else: no line for USR_BINARY, and no line for any path that is not one of
// those folders. stat reports a symlink as itself (never -L), so a link at
// that name, dangling or not, counts as present, and so does anything else
// stat printed there. The gate script discards stat's errors, so a folder
// the user cannot search (EACCES) or a loop (ELOOP) would also print nothing
// for USR_BINARY: hence the owner and search-bit check on the folders, and
// doubt counts as present. A read shaped any other way (another path's read
// credited to this one by a late stream end, garbled, cut short, the stats
// changed, a folder above it missing, not a directory, not root's or not
// searchable) is not "absent".
function autoCandidateAbsent(gate) {
  if (!gate || gate.fuseConf === null || gate.fuseConf === undefined) return false
  if (typeof gate.mounts !== "string") return false
  var s = gate.stats || {}
  var dirs = ancestorDirs(USR_BINARY)
  for (var k in s)
    if (Object.prototype.hasOwnProperty.call(s, k) && dirs.indexOf(k) === -1) return false
  for (var i = 0; i < dirs.length; i++) {
    var d = s[dirs[i]]
    if (!d || d.type !== "dir" || d.uid !== 0 || (d.mode & 0x1) === 0) return false
  }
  return true
}

// After a status gate read of `path` for `setting`: "" when `path` is the
// one chosen (its verdict stands, whatever it is), else the next path to
// gate. Only in auto, only from USR_BINARY, and only when it is absent
// (autoCandidateAbsent) does it move on to OPT_BINARY: a /usr/bin binary
// that is there but fails the gate is refused, never skipped.
function autoChoice(setting, path, gate) {
  if (binaryPathSetting(setting) !== "" || path !== USR_BINARY) return ""
  return autoCandidateAbsent(gate) ? OPT_BINARY : ""
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

// stat with every path as an argument, never -L (a symlink is reported as
// itself); the plugin runs it inside gateArgv. %f is the raw mode in hex, so
// the type and the permission bits come without locale-dependent words; the
// name is last because it is the only field that can hold a tab.
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

// The advice after a mount refusal: the two places auto looks.
var INSTALL_HINT = "Install msi-mux-switch at " + USR_BINARY + " (the " + PACKAGE_NAME + " package) or " + OPT_BINARY + "."

// The mount table, as the kernel writes it (proc(5)), one line per mount:
//   id parent maj:min root mountpoint mountopts [optional...] - fstype source superopts
// The optional fields vary in number; a lone "-" ends them. In a path the
// kernel escapes space, tab, newline and backslash as \040 \011 \012 \134;
// any backslash and three octal digits is decoded as that byte, and any
// other backslash makes the table unparseable.
// With user_allow_other another account can FUSE-mount over a folder it owns
// under a root-owned parent, and the mount can then report any owner, so
// stat alone cannot clear a binary on one. setup.sh applies the same rule.
var MOUNTINFO_PATH = "/proc/self/mountinfo"
// The most of the mount table that is read, in bytes. A larger table is not
// parsed: the gate then refuses (fail safe), it never checks a part of it.
var MOUNTINFO_MAX_BYTES = 1048576

// A mountinfo path field decoded, or null for a backslash not followed by
// three octal digits. The value is taken as one byte (modulo 256, as bash's
// printf %b in setup.sh does).
function decodeMountPath(field) {
  var f = String(field)
  var out = ""
  for (var i = 0; i < f.length; i++) {
    var c = f.charAt(i)
    if (c !== "\\") { out += c; continue }
    var oct = f.slice(i + 1, i + 4)
    if (!/^[0-7]{3}$/.test(oct)) return null
    out += String.fromCharCode(parseInt(oct, 8) & 0xFF)
    i += 3
  }
  return out
}

function optionList(text) {
  return text === "" ? [] : text.split(",")
}

// [{ mountPoint, fstype, options, superOptions }] in table order, or null for
// a table that is empty, does not end in "\n", or has any line that is not a
// mountinfo line: the verdict then refuses (fail safe).
function parseMountinfo(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MOUNTINFO_MAX_BYTES) return null
  if (text.charAt(text.length - 1) !== "\n") return null
  var lines = text.slice(0, -1).split("\n")
  var out = []
  for (var i = 0; i < lines.length; i++) {
    var f = lines[i].split(" ")
    var dash = f.indexOf("-", 6)
    if (dash === -1 || f.length - dash !== 4) return null
    if (!/^[0-9]+$/.test(f[0]) || !/^[0-9]+$/.test(f[1]) || !/^[0-9]+:[0-9]+$/.test(f[2])) return null
    var mp = decodeMountPath(f[4])
    if (mp === null || mp.charAt(0) !== "/" || f[dash + 1] === "") return null
    out.push({ mountPoint: mp, fstype: f[dash + 1], options: optionList(f[5]), superOptions: optionList(f[dash + 3]) })
  }
  return out
}

function isFuseType(fstype) {
  return fstype === "fuse" || fstype === "fuseblk" || fstype.indexOf("fuse.") === 0
}

// The value of the first user_id= in either option list that is not a
// decimal 0 (user_id=0 and user_id=00 pass): another account's number, or an
// empty or non-decimal value, which cannot be read as root's. "" when every
// user_id= is 0 or there is none. setup.sh applies the same rule.
function foreignUserId(entry) {
  var all = entry.options.concat(entry.superOptions)
  for (var i = 0; i < all.length; i++) {
    if (all[i].indexOf("user_id=") !== 0) continue
    var v = all[i].slice(8)
    if (!/^0+$/.test(v)) return v === "" ? "(empty)" : v
  }
  return ""
}

// "" when no mount at or above a valid path can be another account's, else
// why. Every entry whose mount point is the path or a folder above it (whole
// components; "/" covers all) counts, not only the topmost, so the order of
// mounts stacked at one point does not matter. Refused: fstype fuse, fuseblk
// or fuse.*, or a user_id other than 0; and a table that is missing (null),
// malformed or has no entry for / (the one entry that covers every path; a
// table without it is not the kernel's).
function mountProblem(path, mountinfo) {
  var p = String(path)
  var tail = ", which another account may control. " + INSTALL_HINT
  if (isGateChanged(mountinfo))
    return p + " or a folder above it changed while it was being checked (stat gave two different answers)."
  if (typeof mountinfo !== "string") return p + " could not be checked: " + MOUNTINFO_PATH + " could not be read."
  var mounts = parseMountinfo(mountinfo)
  if (mounts === null) return p + " could not be checked: " + MOUNTINFO_PATH + " could not be parsed."
  var rooted = false
  for (var i = 0; i < mounts.length; i++) {
    var m = mounts[i]
    var at = m.mountPoint
    if (!(at === "/" || at === p || p.indexOf(at + "/") === 0)) continue
    if (at === "/") rooted = true
    if (isFuseType(m.fstype)) return p + " is on a " + m.fstype + " mount at " + at + tail
    var uid = foreignUserId(m)
    if (uid !== "") return p + " is on a mount at " + at + " owned by user_id " + uid + tail
  }
  if (!rooted) return p + " could not be checked: " + MOUNTINFO_PATH + " has no entry for /."
  return ""
}

// user_allow_other in /etc/fuse.conf lets every account mount FUSE with
// allow_other, so another account's mount over a folder it owns can show any
// owner to this user too: the gate refuses while it is on. The file is read
// by the gate script (GATE_SCRIPT), before the first stat. setup.sh applies
// the same rule with the same parse.
var FUSE_CONF_PATH = "/etc/fuse.conf"
// The most of it that is read, in bytes. A larger file is not parsed: the
// gate then refuses (fail safe).
var FUSE_CONF_MAX_BYTES = 65536

var FUSE_CONF_ON_TEXT = "user_allow_other is turned on in " + FUSE_CONF_PATH + ". It lets other accounts fake root-owned"
  + " folders, so the plugin cannot trust that msi-mux-switch is root's. Turn it off (comment out that line) to use the plugin."
var FUSE_CONF_UNREAD_TEXT = FUSE_CONF_PATH + " exists but could not be read, so the plugin cannot check that"
  + " user_allow_other is off (it lets other accounts fake root-owned folders)."
var FUSE_CONF_ODD_TEXT = FUSE_CONF_PATH + " could not be checked for user_allow_other (it is too large or not plain text)."
var FUSE_CONF_UNCHECKED_TEXT = FUSE_CONF_PATH + " could not be checked for user_allow_other, which lets other accounts"
  + " fake root-owned folders."

// Whether the text of fuse.conf turns user_allow_other on. Per line (split on
// "\n", a last line without one counts too): everything from the first "#"
// is dropped (fuse does the same, so an inline comment counts), leading
// space, \t, \r, \v and \f are skipped, and the first run of other
// characters is the token; exactly "user_allow_other" is on. Whatever
// follows the token is ignored, which refuses more than fusermount does.
function fuseConfAllowsOther(text) {
  var lines = String(text).split("\n")
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i]
    var hash = l.indexOf("#")
    if (hash !== -1) l = l.slice(0, hash)
    var token = /^[ \t\r\v\f]*([^ \t\r\v\f]*)/.exec(l)[1]
    if (token === "user_allow_other") return true
  }
  return false
}

// "" when fuse.conf (parseGateRead's fuseConf) leaves user_allow_other off,
// else why not. A missing file is off. Anything else that is not a whole,
// plain-text read refuses (fail safe): a file that could not be read, one
// over FUSE_CONF_MAX_BYTES or holding a NUL byte, and no answer at all
// (undefined, null, a gate run that did not finish).
function fuseConfProblem(fuseConf) {
  if (!fuseConf || typeof fuseConf !== "object") return FUSE_CONF_UNCHECKED_TEXT
  if (fuseConf.state === "missing") return ""
  if (fuseConf.state === "unread") return FUSE_CONF_UNREAD_TEXT
  if (fuseConf.state === "over") return FUSE_CONF_ODD_TEXT
  if (fuseConf.state !== "text" || typeof fuseConf.text !== "string") return FUSE_CONF_UNCHECKED_TEXT
  if (fuseConf.text.length > FUSE_CONF_MAX_BYTES || fuseConf.text.indexOf("\u0000") !== -1) return FUSE_CONF_ODD_TEXT
  return fuseConfAllowsOther(fuseConf.text) ? FUSE_CONF_ON_TEXT : ""
}

// The ownership gate's one read, in one run: stat of the binary and every
// folder above it, then the mount table, then the same stat again, so each
// gate decision gets all three from the same moment and a fresh table every
// time (the switch never reuses the status read's). The second stat closes
// the gap a FUSE daemon could use: it can answer the first stat with a
// forged owner and only then detach itself (a lazy unmount), so the table
// read after it shows no mount; the second stat then reaches the real files,
// and a read whose two stats differ in any byte is refused (GATE_CHANGED).
// (Matching device numbers instead does not work: on btrfs stat's device is
// not the one mountinfo lists.) One process also keeps the switch's checks
// as they were: one stat check, under the same watchdog. "$1" is
// STAT_FORMAT, "$2" the mount table, "$3" fuse.conf, the rest the paths;
// nothing but the caps is part of the text. fuse.conf is read first, before
// the first stat, so the stat-table-stat window stays as narrow as it was.
// It prints one line for it: "fuseconf missing" (its folder is searchable
// and the name is neither a file nor a symlink of any kind: a link whose
// target this account cannot reach, dangling, a loop or into a folder it
// cannot search, may still be read by fusermount, so it is "unread"),
// "fuseconf unread", or "fuseconf hex " and its first
// FUSE_CONF_MAX_BYTES+1 bytes in lowercase hex, so its text, which the
// script does not control, can never pass for a marker or a stat line. Then
// the first stat's lines, the line "again", the second stat's lines, the
// line "mountinfo", then the table and "end", or "over" past
// MOUNTINFO_MAX_BYTES, or "unread". Every stat line holds a tab
// (STAT_FORMAT) and no path holds a newline (binaryPathProblem), so neither
// marker line can come from stat; the table, the only raw text it does not
// control, comes last.
var GATE_SCRIPT = [
  "f=$1 m=$2 c=$3",
  "shift 3",
  "if [ -d \"${c%/*}\" ] && [ -x \"${c%/*}\" ] && [ ! -e \"$c\" ] && [ ! -L \"$c\" ]; then printf 'fuseconf missing\\n'",
  "elif h=$(set -o pipefail; head -c " + (FUSE_CONF_MAX_BYTES + 1) + " -- \"$c\" 2>/dev/null | od -An -v -tx1 | tr -d ' \\n'); then",
  "  printf 'fuseconf hex %s\\n' \"$h\"",
  "else printf 'fuseconf unread\\n'",
  "fi",
  "stat -c \"$f\" -- \"$@\" 2>/dev/null",
  "if t=$(head -c " + (MOUNTINFO_MAX_BYTES + 1) + " -- \"$m\" && printf x); then r=read; else r=unread; fi",
  "printf 'again\\n'",
  "stat -c \"$f\" -- \"$@\" 2>/dev/null",
  "printf 'mountinfo\\n'",
  "if [ \"$r\" = read ]; then",
  "  t=${t%x}",
  "  if [ \"$(printf '%s' \"$t\" | wc -c)\" -gt " + MOUNTINFO_MAX_BYTES + " ]; then printf 'over\\n'",
  "  else printf '%send\\n' \"$t\"",
  "  fi",
  "else printf 'unread\\n'",
  "fi"
].join("\n")

function gateArgv(path) {
  if (binaryPathProblem(path) !== "") return []
  return ["bash", "-c", GATE_SCRIPT, "msi-mux-gate", STAT_FORMAT, MOUNTINFO_PATH, FUSE_CONF_PATH, String(path)]
    .concat(ancestorDirs(path))
}

// What parseGateRead puts in `mounts` when the two stats differ: not a
// table, so every verdict on it refuses (mountProblem).
var GATE_CHANGED = { changed: true }

function isGateChanged(mounts) {
  return mounts !== null && typeof mounts === "object" && mounts.changed === true
}

// The first line of `t` at or after `from` that is exactly `marker`: the
// index of its first character, or -1.
function markerLine(t, marker, from) {
  var at = t.indexOf(marker + "\n", from)
  while (at > from && t.charAt(at - 1) !== "\n") at = t.indexOf(marker + "\n", at + 1)
  return at
}

// The gate script's fuse.conf line: "missing", "unread", or the hex of what
// was read.
var FUSE_CONF_LINE = /^fuseconf (missing|unread|hex ([0-9a-f]*))$/

// The fuseConf of a gate read from the line's match: { state: "missing" },
// { state: "unread" }, { state: "over" } past FUSE_CONF_MAX_BYTES, or
// { state: "text", text } (one character per byte); null for an odd number
// of hex digits (not the script's output).
function fuseConfFromLine(match) {
  if (match[1] === "missing" || match[1] === "unread") return { state: match[1] }
  var hex = match[2]
  if (hex.length % 2 !== 0) return null
  if (hex.length > 2 * FUSE_CONF_MAX_BYTES) return { state: "over" }
  var text = ""
  for (var i = 0; i < hex.length; i += 2) text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
  return { state: "text", text: text }
}

// { stats: parseStat of the first stat's lines, mounts: the table's text, or
// null when it was not read whole, fuseConf: fuseConfFromLine of the first
// line }. Without that first line or both marker lines nothing is taken
// (the run did not finish). When the second stat's lines are not the
// first's, byte for byte, no stat is taken either and `mounts` is
// GATE_CHANGED (fuse.conf, read before both, is kept).
function parseGateRead(text) {
  var all = String(text === undefined || text === null ? "" : text)
  var nl = all.indexOf("\n")
  var line = nl === -1 ? null : FUSE_CONF_LINE.exec(all.slice(0, nl))
  var fuseConf = line ? fuseConfFromLine(line) : null
  if (fuseConf === null) return { stats: {}, mounts: null, fuseConf: null }
  var t = all.slice(nl + 1)
  var again = markerLine(t, "again", 0)
  if (again === -1) return { stats: {}, mounts: null, fuseConf: null }
  var sep = markerLine(t, "mountinfo", again + 6)
  if (sep === -1) return { stats: {}, mounts: null, fuseConf: null }
  if (t.slice(0, again) !== t.slice(again + 6, sep)) return { stats: {}, mounts: GATE_CHANGED, fuseConf: fuseConf }
  var body = t.slice(sep + 10)
  var ended = body.length >= 4 && body.slice(-4) === "end\n"
  return { stats: parseStat(t.slice(0, again)), mounts: ended ? body.slice(0, -4) : null, fuseConf: fuseConf }
}

// Whether the binary may be run at all, by pkexec for the switch or as the
// user for the debug read (debugReadArgv): { ok, kind, reason }. kind is "ok",
// "invalid" (the setting), "mount" (under a user mount; user_allow_other on
// in fuse.conf or fuse.conf could not be checked: fuseConfProblem on
// `fuseConf`, a fresh gate read's; or on a mount another account may
// control, or the mount table could not be checked: mountProblem on
// `mounts`, the text of a fresh mountinfo read), "missing",
// "symlink", "notfile", "owner", "mode" or "ancestor". The binary must be a regular file owned by root with no
// group or other write bit, and so must every directory above it (a
// directory the user can write lets the user swap the file).
function ownershipVerdict(path, stats, mounts, fuseConf) {
  var problem = binaryPathProblem(path)
  if (problem !== "") return { ok: false, kind: "invalid", reason: problem }
  var mount = userMountOf(path)
  if (mount !== "")
    return { ok: false, kind: "mount", reason: String(path) + " is under " + mount
      + ", where a user can mount or replace files. " + INSTALL_HINT }
  var fuse = fuseConfProblem(fuseConf)
  if (fuse !== "") return { ok: false, kind: "mount", reason: fuse }
  var mounted = mountProblem(path, mounts)
  if (mounted !== "") return { ok: false, kind: "mount", reason: mounted }
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

// ownershipVerdict as the panel and the switch show it: the same ok and
// kind, the reason worded for where the path came from. In auto (`setting`
// "") a missing OPT_BINARY was reached only because USR_BINARY was absent,
// so both places are named; a USR_BINARY file with the wrong owner or mode
// is the package's, fixed by reinstalling it.
var REINSTALL_HINT = "Reinstall the " + PACKAGE_NAME + " package."

function binaryVerdict(setting, path, stats, mounts, fuseConf) {
  var v = ownershipVerdict(path, stats, mounts, fuseConf)
  if (v.kind === "missing" && binaryPathSetting(setting) === "" && String(path) === OPT_BINARY)
    return { ok: false, kind: "missing", reason: "msi-mux-switch was not found at " + USR_BINARY + " or " + OPT_BINARY + "." }
  if (String(path) === USR_BINARY && (v.kind === "owner" || v.kind === "mode"))
    return { ok: false, kind: v.kind, reason: v.reason + " " + REINSTALL_HINT }
  return v
}

// Set up backend helps with every ownership problem except a bad setting or
// a mount (a user mount, user_allow_other on or fuse.conf unchecked, a mount
// another account may control, or a mount table that could not be checked):
// setup.sh refuses those too. Never for a path under /usr/, /bin/ or /sbin/
// (USR_BINARY included): package-managed system folders, full of other
// files, that setup.sh refuses to change (on Arch /bin and /sbin are links
// into /usr, so their verdict is "ancestor", which setup.sh cannot fix
// either). Still offered for /opt and any other custom folder.
var SYSTEM_PREFIXES = ["/usr/", "/bin/", "/sbin/"]

function setupHelps(verdict, path) {
  var p = String(path)
  for (var i = 0; i < SYSTEM_PREFIXES.length; i++)
    if (p.indexOf(SYSTEM_PREFIXES[i]) === 0) return false
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
// passes ownershipVerdict for `stats`, `mounts` and `fuseConf` (parseGateRead
// of a gate read taken right before it), the same gate as the switch. A
// binary owned by another account, in a folder a user can write, under a
// user mount or on a mount another account may control, with
// user_allow_other on, or a symbolic link, is never run, not even read-only.
function debugReadArgv(path, stats, mounts, fuseConf, flags) {
  if (!ownershipVerdict(path, stats, mounts, fuseConf).ok) return []
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

// ------------------------------------------------------- the leftover flag

// The leftover-flag refusal (FIRMWARE_FLAG_TEXT) comes from a switch run, and
// the panel clears a run's outcome when it opens; so the refusal is
// remembered as { bootId, current, target }: this boot, and the modes the
// debug read showed at the refusal. While a later read still shows those
// modes in the same boot (flagActive), the panel acts as while staged: the
// flag's lock line with Shut down now, no Switch button. The flag stays set
// until a full shutdown, which is a new boot.
var BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id"

function bootIdArgv() {
  return ["head", "-c", "64", "--", BOOT_ID_PATH]
}

function isBootId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

// The boot id from the read's output, or "" for anything but one UUID line.
function parseBootId(text) {
  if (typeof text !== "string") return ""
  var t = text.charAt(text.length - 1) === "\n" ? text.slice(0, -1) : text
  return isBootId(t) ? t : ""
}

// The record to keep after a finished run, or null: only for the
// leftover-flag refusal, with a boot id and a read that showed nothing
// staged. Without a boot id nothing is remembered (the line then shows only
// until the panel opens again, as before).
function flagMemoryAtRefusal(outcome, bootId, debug) {
  if (!outcome || outcome.lock !== true || outcome.message !== FIRMWARE_FLAG_TEXT) return null
  if (!isBootId(bootId) || !debug || debug.ok !== true || debug.pending === true) return null
  return { bootId: bootId, current: debug.current, target: debug.target }
}

// The record after a new read (debug) or boot id read: kept only while the
// boot id is the record's and the read is one (ok) showing the same current
// and target. Any other read, a refused gate (debug emptied) included, or a
// boot id that differs or cannot be read, drops it.
function flagMemoryAfterRead(record, bootId, debug) {
  if (!record) return null
  if (!isBootId(bootId) || bootId !== record.bootId) return null
  if (!debug || debug.ok !== true) return null
  if (debug.current !== record.current || debug.target !== record.target) return null
  return record
}

// Whether a remembered flag (st.flag) holds for the read shown (st.debug).
// A staged switch wins over it.
function flagActive(s) {
  var st = s || {}
  var r = st.flag
  var d = st.debug
  return !!r && !!d && d.ok === true && d.pending !== true && d.current === r.current && d.target === r.target
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
  if (flagActive(st)) return FIRMWARE_FLAG_TEXT
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
// switch is staged, or the leftover firmware flag is remembered (flagActive),
// no row has a button: the tool refuses any further mode run until a full
// shutdown (STAGED_LOCK_TEXT or FIRMWARE_FLAG_TEXT, shown once by the panel).
function modeRows(s) {
  var st = s || {}
  var d = st.debug || emptyDebug()
  var locked = d.ok === true && (d.pending === true || flagActive(st))
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
    } else if (locked) {
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
// firmware flag) and for as long as it is remembered (flagActive), else ""
// (no line). urgent: it answers a refused switch. None while switching is
// unavailable (st.unavailableReason): the binary or the hardware is refused,
// and nothing an earlier run said is shown.
function lockNotice(s) {
  var st = s || {}
  var d = st.debug || emptyDebug()
  var none = { kind: "", text: "", urgent: false }
  if (st.unavailableReason) return none
  var refused = st.busy !== true && !!st.outcome && st.outcome.lock === true
  if (d.ok && d.pending) return { kind: "staged", text: STAGED_LOCK_TEXT, urgent: refused }
  if (refused) return { kind: "flag", text: FIRMWARE_FLAG_TEXT, urgent: true }
  if (st.busy !== true && flagActive(st)) return { kind: "flag", text: FIRMWARE_FLAG_TEXT, urgent: false }
  return none
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
