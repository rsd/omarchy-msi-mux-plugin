#!/usr/bin/env node

// Exercises ../Model.js, which is written as a QML JS module (bare function
// declarations, no exports) and so is loaded here by evaluating it and lifting
// the names out. Also checks the QML sources against the model (every
// Model.<name> and MuxState.<name> exists, every Text is plain text, every
// process argv comes from the model), the manifest, the plugin's layout, and
// that the README's env-file block is the generator's text byte for byte.

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const pluginDir = path.join(__dirname, "..")
const read = f => fs.readFileSync(path.join(pluginDir, f), "utf8")
const source = read("Model.js")
const NAMES = [...new Set([...source.matchAll(/^(?:function\s+(\w+)\s*\(|var\s+(\w+)\s*=)/gm)]
  .map(m => m[1] || m[2]))]
const M = new Function(source + "\nreturn {" + NAMES.join(",") + "}")()

const tests = []
const test = (name, fn) => tests.push([name, fn])

const BIN = "/opt/msi-mux-switch/msi-mux-switch"
const FLAGS = ["--allow-unsupported-hardware", "--allow-unvalidated-bios"]
const JUGGERNAUT = { vendor: "Micro-Star International Co., Ltd.", model: "Vector 16 HX AI A2XWIG", board: "MS-15M3", bios: "E15M3IMS.10E" }
const CAPTURE = read("tests/fixtures/debug-discrete.json")
const withFirmware = (over) => {
  const doc = JSON.parse(CAPTURE)
  Object.assign(doc.firmware.value, over)
  return JSON.stringify(doc, null, 2)
}

// ------------------------------------------------------------------ hardware

test("hardware: the allowlisted machine is available, with both override flags", () => {
  const d = M.hardwareDecision(JUGGERNAUT)
  assert.deepStrictEqual(d, { state: "available", source: "allowlist", flags: FLAGS, reason: "" })
  // A copy: changing it does not change the constant.
  d.flags.push("--x")
  assert.deepStrictEqual(M.OVERRIDE_FLAGS, FLAGS)
  assert.deepStrictEqual(M.hardwareDecision(JUGGERNAUT).flags, FLAGS)
})

test("hardware: the tool's native table at 223ca06 needs no flags", () => {
  assert.deepStrictEqual(M.NATIVE, [
    { model: "Vector 16 HX AI A2XWIG", board: "MS-15M3", bios: "E15M3IMS.116" },
    { model: "Stealth 16Studio A13VG", board: "MS-15F2", bios: "E15F2IMS.10F" }
  ])
  for (const e of M.NATIVE) {
    const d = M.hardwareDecision(Object.assign({ vendor: "Micro-Star International Co., Ltd." }, e))
    assert.deepStrictEqual(d, { state: "available", source: "native", flags: [], reason: "" })
  }
  assert.strictEqual(M.hardwareDecision({ vendor: "MSI", model: "Stealth 16Studio A13VG", board: "MS-15F2", bios: "E15F2IMS.10F" }).source, "native")
})

test("hardware: one allowlist entry, exact", () => {
  assert.deepStrictEqual(M.ALLOWLIST, [{ model: "Vector 16 HX AI A2XWIG", board: "MS-15M3", bios: "E15M3IMS.10E" }])
})

test("hardware: any other MSI machine is unavailable, naming model, board and BIOS", () => {
  const cases = [
    Object.assign({}, JUGGERNAUT, { bios: "E15M3IMS.10" }),
    Object.assign({}, JUGGERNAUT, { bios: "E15M3IMS.10F" }),
    Object.assign({}, JUGGERNAUT, { board: "MS-15M2" }),
    Object.assign({}, JUGGERNAUT, { model: "Vector 16 HX AI A2XWIH" }),
    { vendor: "MSI", model: "Raider", board: "MS-1", bios: "X" },
    Object.assign({}, JUGGERNAUT, { bios: "e15m3ims.10e" })
  ]
  for (const c of cases) {
    const d = M.hardwareDecision(c)
    assert.strictEqual(d.state, "unavailable", JSON.stringify(c))
    assert.deepStrictEqual(d.flags, [])
    for (const v of [c.model, c.board, c.bios]) assert.ok(d.reason.includes("'" + v + "'"), d.reason)
  }
})

test("hardware: the unavailable reason is plain English", () => {
  const d = M.hardwareDecision({ vendor: "MSI", model: "Raider", board: "MS-1", bios: "X" })
  assert.strictEqual(d.reason, "msi-mux-switch and this plugin have not been tested on this machine (model 'Raider', board 'MS-1', BIOS 'X'), so switching is off.")
})

test("hardware: values are trimmed like the tool does", () => {
  const d = M.hardwareDecision({ vendor: " Micro-Star International Co., Ltd.\n", model: "Vector 16 HX AI A2XWIG \n",
    board: "\tMS-15M3", bios: "E15M3IMS.10E\n" })
  assert.strictEqual(d.source, "allowlist")
})

test("hardware: non-MSI vendors are hidden, whatever the rest says", () => {
  for (const vendor of ["LENOVO", "ASUSTeK COMPUTER INC.", "", "msi", "Micro-Star", "QEMU", " ", "Dell Inc."]) {
    const d = M.hardwareDecision(Object.assign({}, JUGGERNAUT, { vendor }))
    assert.strictEqual(d.state, "hidden", vendor)
    assert.deepStrictEqual(d.flags, [])
  }
  assert.strictEqual(M.hardwareDecision(null).state, "hidden")
  assert.strictEqual(M.hardwareDecision({ vendor: "MSI", model: "", board: "", bios: "" }).state, "unavailable")
  assert.strictEqual(M.isMsiVendor("Micro-Star International Co., Ltd."), true)
  assert.strictEqual(M.isMsiVendor("MSI"), true)
})

test("DMI: the read script's answer, and nothing without its end line", () => {
  assert.deepStrictEqual(M.dmiArgv(), ["sh", "-c", M.DMI_SCRIPT, "msi-mux-dmi", "/sys/class/dmi/id"])
  const text = "sys_vendor=Micro-Star International Co., Ltd.\nproduct_name=Vector 16 HX AI A2XWIG\nboard_name=MS-15M3\nbios_version=E15M3IMS.10E\nend\n"
  assert.deepStrictEqual(M.parseDmi(text), JUGGERNAUT)
  assert.strictEqual(M.parseDmi(text.replace("end\n", "")), null)
  assert.deepStrictEqual(M.parseDmi("sys_vendor=\nend\n"), { vendor: "", model: "", board: "", bios: "" })
  assert.deepStrictEqual(M.parseDmi("product_name=a=b\nend\n").model, "a=b")
  assert.ok(!/\$\{?[a-z]/i.test(M.DMI_SCRIPT.replace(/\$\(|\$1|\$f|\$v/g, "")), "DMI_SCRIPT uses only $1, $f and $v")
})

// --------------------------------------------------------------- the path

test("binary path: absolute, no .., no newline, no empty or . segment", () => {
  assert.strictEqual(M.binaryPathProblem(BIN), "")
  assert.strictEqual(M.binaryPathProblem("/a"), "")
  assert.strictEqual(M.binaryPathProblem("/opt/a b/$(x);`y`"), "", "shell characters are plain argv here")
  for (const bad of ["", "opt/x", "./x", "~/x", "/opt/../x", "/opt/x..", "/opt/..", "/opt/x\n", "/opt/\nx", "/opt/x\u0000",
    "/opt/x\r", "/", "/opt/", "/opt//x", "/opt/./x", "/" + "a".repeat(4100), null, undefined]) {
    assert.notStrictEqual(M.binaryPathProblem(bad), "", JSON.stringify(bad))
    assert.deepStrictEqual(M.statArgv(bad), [])
    assert.deepStrictEqual(M.debugArgv(bad, []), [])
    assert.deepStrictEqual(M.switchArgv(bad, "discrete", []), [])
  }
  assert.strictEqual(M.binaryPathSetting(""), BIN)
  assert.strictEqual(M.binaryPathSetting(undefined), BIN)
  assert.strictEqual(M.binaryPathSetting(42), BIN)
  assert.strictEqual(M.binaryPathSetting("/usr/local/bin/msi-mux-switch"), "/usr/local/bin/msi-mux-switch")
  // A bad setting is kept as given (and refused), never replaced by the default.
  assert.strictEqual(M.binaryPathSetting("relative"), "relative")
})

test("binary path: every ancestor up to /, and stat as an argv array without -L", () => {
  assert.deepStrictEqual(M.ancestorDirs(BIN), ["/opt/msi-mux-switch", "/opt", "/"])
  assert.deepStrictEqual(M.ancestorDirs("/x"), ["/"])
  assert.deepStrictEqual(M.statArgv(BIN), ["stat", "-c", "%u\t%f\t%U\t%n", "--", BIN, "/opt/msi-mux-switch", "/opt", "/"])
  assert.ok(!M.statArgv(BIN).includes("-L"))
})

// --------------------------------------------------------------- ownership

// stat -c '%u\t%f\t%U\t%n' lines.
const st = (uid, rawHex, owner, name) => [uid, rawHex, owner, name].join("\t")
const ROOT_OK = [
  st(0, "81ed", "root", BIN),               // regular file 0755
  st(0, "41ed", "root", "/opt/msi-mux-switch"),
  st(0, "41ed", "root", "/opt"),
  st(0, "416d", "root", "/")                // directory 0555
].join("\n") + "\n"
const verdict = (text) => M.ownershipVerdict(BIN, M.parseStat(text))
const replaceLine = (text, name, line) => text.split("\n").map(l => l.endsWith("\t" + name) ? line : l).join("\n")

test("stat output parses into type, uid, mode and owner", () => {
  const s = M.parseStat(ROOT_OK)
  assert.deepStrictEqual(s[BIN], { uid: 0, mode: 0o755, type: "file", owner: "root" })
  assert.deepStrictEqual(s["/"], { uid: 0, mode: 0o555, type: "dir", owner: "root" })
  assert.strictEqual(M.parseStat(st(1000, "a1ff", "raul", "/x"))["/x"].type, "symlink")
  assert.strictEqual(M.parseStat(st(0, "21b6", "root", "/dev/null"))["/dev/null"].type, "other")
  assert.strictEqual(M.parseStat(st(0, "81ed", "root", "/a\tb"))["/a\tb"].uid, 0, "a tab in the name is kept")
  assert.deepStrictEqual(M.parseStat("garbage\n\nx\ty\tz\tw\n"), {})
  assert.deepStrictEqual(M.parseStat(""), {})
})

test("ownership: root-owned binary and ancestors, none group/other-writable, pass", () => {
  assert.deepStrictEqual(verdict(ROOT_OK), { ok: true, kind: "ok", reason: "" })
  // 0700 and 0750 are fine; only the write bits matter.
  assert.strictEqual(verdict(replaceLine(ROOT_OK, BIN, st(0, "81c0", "root", BIN))).ok, true)
  assert.strictEqual(verdict(replaceLine(ROOT_OK, "/opt", st(0, "41e8", "root", "/opt"))).ok, true)
})

test("ownership: a user-owned binary is refused, naming the owner", () => {
  const v = verdict(replaceLine(ROOT_OK, BIN, st(1000, "81ed", "raul", BIN)))
  assert.deepStrictEqual(v, { ok: false, kind: "owner", reason: BIN + " is owned by raul, not root." })
  assert.ok(verdict(replaceLine(ROOT_OK, BIN, st(1000, "81ed", "UNKNOWN", BIN))).reason.includes("uid 1000"))
  assert.ok(M.setupHelps(v))
})

test("ownership: group- or other-writable binary is refused", () => {
  for (const raw of ["81fd", "81ef", "81ff", "81f0"]) {
    const v = verdict(replaceLine(ROOT_OK, BIN, st(0, raw, "root", BIN)))
    assert.strictEqual(v.kind, "mode", raw)
    assert.ok(v.reason.includes("writable by group or others"))
  }
})

test("ownership: a symlink is refused, even root-owned", () => {
  const v = verdict(replaceLine(ROOT_OK, BIN, st(0, "a1ff", "root", BIN)))
  assert.strictEqual(v.kind, "symlink")
  assert.strictEqual(v.ok, false)
  assert.strictEqual(M.binaryPresent(BIN, M.parseStat(replaceLine(ROOT_OK, BIN, st(0, "a1ff", "root", BIN)))), false)
})

test("ownership: a writable or user-owned ancestor is refused, naming it", () => {
  let v = verdict(replaceLine(ROOT_OK, "/opt/msi-mux-switch", st(1000, "41ed", "raul", "/opt/msi-mux-switch")))
  assert.deepStrictEqual(v, { ok: false, kind: "ancestor", reason: "/opt/msi-mux-switch is owned by raul, not root." })
  v = verdict(replaceLine(ROOT_OK, "/opt", st(0, "41ff", "root", "/opt")))
  assert.deepStrictEqual(v, { ok: false, kind: "ancestor", reason: "/opt is writable by group or others." })
  // /tmp-like: sticky, world-writable.
  v = verdict(replaceLine(ROOT_OK, "/opt", st(0, "43ff", "root", "/opt")))
  assert.strictEqual(v.kind, "ancestor")
  v = verdict(replaceLine(ROOT_OK, "/", st(0, "41fd", "root", "/")))
  assert.strictEqual(v.reason, "/ is writable by group or others.")
  v = verdict(replaceLine(ROOT_OK, "/opt", st(0, "a1ff", "root", "/opt")))
  assert.ok(v.reason.includes("/opt is a symbolic link"))
  v = verdict(ROOT_OK.split("\n").filter(l => !l.endsWith("\t/opt")).join("\n"))
  assert.deepStrictEqual(v, { ok: false, kind: "ancestor", reason: "/opt could not be checked." })
})

test("ownership: the machine as it is today (file and folder owned by raul)", () => {
  const today = [st(1000, "81ed", "raul", BIN), st(1000, "41ed", "raul", "/opt/msi-mux-switch"), st(0, "41ed", "root", "/opt"), st(0, "416d", "root", "/")].join("\n")
  const v = verdict(today)
  assert.strictEqual(v.reason, BIN + " is owned by raul, not root.")
  assert.strictEqual(M.binaryPresent(BIN, M.parseStat(today)), true, "the read-only debug read still runs")
})

test("ownership: missing binary, not a file, and a bad setting", () => {
  const missing = ROOT_OK.split("\n").filter(l => !l.endsWith("\t" + BIN)).join("\n")
  assert.deepStrictEqual(verdict(missing), { ok: false, kind: "missing", reason: "msi-mux-switch was not found at " + BIN + "." })
  assert.ok(M.setupHelps(verdict(missing)))
  assert.strictEqual(M.binaryPresent(BIN, M.parseStat(missing)), false)
  assert.strictEqual(verdict(replaceLine(ROOT_OK, BIN, st(0, "41ed", "root", BIN))).kind, "notfile")
  const bad = M.ownershipVerdict("relative", {})
  assert.strictEqual(bad.kind, "invalid")
  assert.strictEqual(M.setupHelps(bad), false, "setup.sh cannot fix a bad setting")
  assert.strictEqual(M.setupHelps({ ok: true, kind: "ok", reason: "" }), false)
})

test("ownership: a binary under a user mount is refused, whatever stat says", () => {
  for (const m of ["/mnt", "/media", "/run/media", "/run/user"]) {
    const p = m + "/x/msi-mux-switch"
    const all = [st(0, "81ed", "root", p)].concat(M.ancestorDirs(p).map(d => st(0, "41ed", "root", d))).join("\n")
    const v = M.ownershipVerdict(p, M.parseStat(all))
    assert.strictEqual(v.kind, "mount", p)
    assert.ok(v.reason.startsWith(p + " is under " + m + ", where a user can mount"), v.reason)
    assert.strictEqual(M.setupHelps(v), false, "setup.sh refuses it too")
  }
  assert.strictEqual(M.ownershipVerdict("/run/user/1000/msi-mux-switch", {}).kind, "mount")
  // Only whole path segments: /mntx and /run/username are not mounts.
  assert.strictEqual(M.userMountOf("/mntx/msi-mux-switch"), "")
  assert.strictEqual(M.userMountOf("/run/username/msi-mux-switch"), "")
  assert.strictEqual(M.userMountOf(BIN), "")
})

// ---------------------------------------------------------------- commands

test("argv: pgrep for a running msi-mux-switch before a switch; only 'none running' passes", () => {
  assert.deepStrictEqual(M.pgrepArgv(), ["pgrep", "-x", "msi-mux-switch"])
  const a = M.pgrepArgv()
  a.push("x")
  assert.deepStrictEqual(M.pgrepArgv(), ["pgrep", "-x", "msi-mux-switch"], "a copy")
  assert.strictEqual(M.runningProblem(1), "")
  assert.ok(/already running/.test(M.runningProblem(0)))
  for (const code of [2, 3, -1, undefined]) assert.ok(/Could not check/.test(M.runningProblem(code)), String(code))
})

test("argv: the debug read, as the user, with the hardware's flags", () => {
  assert.deepStrictEqual(M.debugArgv(BIN, FLAGS), [BIN, "--debug", "--json", "--allow-unsupported-hardware", "--allow-unvalidated-bios"])
  assert.deepStrictEqual(M.debugArgv(BIN, []), [BIN, "--debug", "--json"])
})

test("argv: pkexec switch, exact array, no shell", () => {
  assert.deepStrictEqual(M.switchArgv(BIN, "mshybrid", FLAGS),
    ["pkexec", "--disable-internal-agent", BIN, "mshybrid", "--json", "--allow-unsupported-hardware", "--allow-unvalidated-bios"])
  assert.deepStrictEqual(M.switchArgv(BIN, "discrete", []), ["pkexec", "--disable-internal-agent", BIN, "discrete", "--json"])
  assert.deepStrictEqual(M.switchArgv(BIN, "integrated", []), ["pkexec", "--disable-internal-agent", BIN, "integrated", "--json"])
  for (const bad of ["", "ms-hybrid", "hybrid", "Discrete", "dgpu", "--debug", "discrete; reboot", null]) assert.deepStrictEqual(M.switchArgv(BIN, bad, []), [], String(bad))
  const odd = "/opt/a b/$(rm -rf ~)/msi"
  assert.deepStrictEqual(M.switchArgv(odd, "discrete", []).slice(2, 3), [odd], "an odd path stays one argv element")
  assert.ok(!M.switchArgv(BIN, "discrete", FLAGS).some(a => a === "sh" || a === "bash" || a === "-c"))
})

test("argv: shutdown is omarchy-system shutdown; setup runs setup.sh with the path as an argument", () => {
  assert.deepStrictEqual(M.SHUTDOWN_ARGV, ["omarchy-system", "shutdown"])
  const dir = "/home/u/.config/omarchy/plugins/io.github.rsd.msi-mux"
  assert.deepStrictEqual(M.setupArgv(dir, BIN), ["omarchy-launch-tui", "--app-id=TUI.float", "bash", "-c", M.SETUP_SCRIPT,
    "msi-mux-setup", dir + "/setup.sh", BIN])
  assert.ok(!M.SETUP_SCRIPT.includes("/opt") && !M.SETUP_SCRIPT.includes("setup.sh\""), "nothing interpolated into the script")
  assert.ok(M.SETUP_SCRIPT.includes("bash -- \"$1\" \"$2\"") && M.SETUP_SCRIPT.includes("Press Enter to close"))
  assert.deepStrictEqual(M.setupArgv("", BIN), [])
  assert.deepStrictEqual(M.setupArgv(dir, "x/../y"), [])
  assert.strictEqual(M.pluginDirFromUrl("file://" + dir.replace(/\./g, "%2E") + "/manifest.json"), dir)
  assert.strictEqual(M.pluginDirFromUrl("file:///a/../b/manifest.json"), "")
  assert.strictEqual(M.pluginDirFromUrl("http://x/manifest.json"), "")
})

// ---------------------------------------------------------------- debug read

test("debug: the real capture (Discrete, nothing pending)", () => {
  const d = M.parseDebug(CAPTURE, "", 0)
  assert.deepStrictEqual(d, { ok: true, error: "", current: "discrete", target: "discrete", pending: false,
    modes: ["discrete", "mshybrid", "integrated"] })
})

test("debug: pending (target differs from current)", () => {
  const d = M.parseDebug(withFirmware({ selected_target_mode: "ms-hybrid", selected_target_value: 0 }), "", 0)
  assert.strictEqual(d.ok, true)
  assert.strictEqual(d.current, "discrete")
  assert.strictEqual(d.target, "mshybrid")
  assert.strictEqual(d.pending, true)
  assert.strictEqual(M.pendingText(d.target), "MSHybrid after full shutdown")
  assert.strictEqual(M.summary(d), "Discrete → MSHybrid after shutdown")
  // Short enough for the hero line; "shut down", never "reboot".
  for (const cur of M.MODES) for (const tgt of M.MODES) {
    if (cur === tgt) continue
    const line = M.summary({ ok: true, error: "", current: cur, target: tgt, pending: true, modes: M.MODES })
    assert.ok(line.length <= 38 && /after shutdown$/.test(line) && !/reboot/i.test(line), line)
  }
  assert.strictEqual(M.barState({ available: true, debug: d }).badge, true)
})

test("debug: null modes are unknown and never pending", () => {
  for (const over of [{ current_mode: null }, { selected_target_mode: null }, { current_mode: null, selected_target_mode: null }, { current_mode: "turbo" }]) {
    const d = M.parseDebug(withFirmware(over), "", 0)
    assert.strictEqual(d.ok, true)
    assert.strictEqual(d.pending, false, JSON.stringify(over))
  }
  const d = M.parseDebug(withFirmware({ current_mode: null }), "", 0)
  assert.strictEqual(d.current, "")
  assert.strictEqual(M.summary(d), "Current mode not recognised")
  assert.strictEqual(M.barState({ available: true, debug: d }).icon, M.ICON.unknown)
})

test("debug: available modes follow the firmware's flags", () => {
  assert.deepStrictEqual(M.parseDebug(withFirmware({ integrated_supported: false }), "", 0).modes, ["discrete", "mshybrid"])
  assert.deepStrictEqual(M.parseDebug(withFirmware({ discrete_supported: false, integrated_supported: false }), "", 0).modes, ["mshybrid"])
  assert.deepStrictEqual(M.parseDebug(withFirmware({ new_switch_supported: false }), "", 0).modes, [])
})

test("debug: firmware unavailable, malformed JSON, and a failed run", () => {
  const doc = JSON.parse(CAPTURE)
  doc.firmware = { available: false, error: "read EFI variable: No such file or directory" }
  let d = M.parseDebug(JSON.stringify(doc), "", 0)
  assert.strictEqual(d.ok, false)
  assert.strictEqual(d.error, "The firmware's GPU mode could not be read: read EFI variable: No such file or directory")
  d = M.parseDebug(JSON.stringify(Object.assign(doc, { firmware: { available: true } })), "", 0)
  assert.strictEqual(d.ok, false)
  for (const bad of ["", "{", "[]", "null", "42", CAPTURE.slice(0, 200), "{\"event\":\"x\"}\n{\"event\":\"y\"}"]) {
    d = M.parseDebug(bad, "", 0)
    assert.strictEqual(d.ok, false, bad)
    assert.notStrictEqual(d.error, "")
  }
  const err = "{\"event\":\"error\",\"level\":\"error\",\"message\":\"unsupported hardware: model 'X', board 'Y', BIOS 'Z'; use the explicit override only for a deliberate read-only capture\"}\n"
  d = M.parseDebug("", err, 1)
  assert.strictEqual(d.ok, false)
  assert.ok(d.error.startsWith("unsupported hardware: model 'X'"))
  d = M.parseDebug(CAPTURE, "", 1)
  assert.strictEqual(d.ok, false, "a non-zero exit is a failure even with a document")
  assert.ok(d.error.includes("exit status 1"))
  assert.strictEqual(M.parseDebug("", "", -1).ok, false)
  assert.strictEqual(M.summary(M.emptyDebug()), "Reading the GPU mode…")
})

test("debug: output over 1 MiB is refused unread", () => {
  const big = CAPTURE + " ".repeat(M.DEBUG_MAX_CHARS)
  const d = M.parseDebug(big, "", 0)
  assert.strictEqual(d.ok, false)
  assert.ok(/more than 1 MiB/.test(d.error))
  assert.strictEqual(M.parseDebug(CAPTURE, "x".repeat(M.DEBUG_MAX_CHARS + 1), 0).ok, false)
  assert.strictEqual(M.DEBUG_MAX_CHARS, 1048576)
  assert.strictEqual(M.parseDebug(CAPTURE, "", 0).ok, true)
})

// ------------------------------------------------------------ switch events

const ev = (event, message, data) => JSON.stringify({ event, message, data: data === undefined ? null : data })
const warn = (event, message) => JSON.stringify({ event, level: "warning", message, data: null })
const errLine = (message) => JSON.stringify({ event: "error", level: "error", message })
const SUCCESS_RUN = [
  ev("current_mode", "Current mode: discrete", { mode: "discrete", value: 1 }),
  ev("available_modes", "Available modes", { modes: ["ms-hybrid", "discrete", "integrated"] }),
  ev("selected_mode", "Selected mode: ms-hybrid", { mode: "ms-hybrid", value: 0 }),
  ev("shutdown_required", "A full shutdown is required", { automatic_shutdown: false }),
  ev("confirmation_skipped", "JSON mode", { json_mode: true }),
  warn("bitlocker_reminder", "Suspend BitLocker before switching"),
  ev("preflight", "preflight", { data_byte1: "0x00", apply_ready: false }),
  ev("rollback_record", "rollback", { path: "/root/.local/state/msi-gpu-mux/backups/x.json" }),
  ev("target_staged", "staged", { byte5_before: "0x35", byte5_after: "0x34" }),
  ev("trigger", "trigger", { data_byte1_before: "0x00", address: "0x1", value: "0x1" }),
  ev("apply_ready", "ready", { data_byte1: "0x01", apply_ready: true }),
  ev("acknowledgement", "ack", { address: "0x1", value: "0x1" }),
  ev("success", "Mode 'ms-hybrid' is staged and the firmware apply handshake succeeded.\nSave all work, close applications, then perform a full shutdown manually.",
    { mode: "ms-hybrid", value: 0, manual_shutdown_required: true, verification_command: "msi-mux-switch --debug" })
]
const fold = (lines) => lines.reduce((r, l) => M.applySwitchLine(r, l), M.newSwitchRun())

test("events: one JSON line each; anything else is not an event", () => {
  assert.deepStrictEqual(M.parseEventLine(ev("success", "ok", { mode: "discrete" })), { event: "success", level: "", message: "ok", data: { mode: "discrete" } })
  assert.deepStrictEqual(M.parseEventLine(errLine("boom")), { event: "error", level: "error", message: "boom", data: null })
  for (const bad of ["", "   ", "error: boom", "Selected mode: discrete", "[1]", "{", "{\"message\":\"x\"}", "{\"event\":5}", "null", undefined])
    assert.strictEqual(M.parseEventLine(bad), null, String(bad))
  assert.strictEqual(M.parseEventLine("  " + ev("x", "y") + "\r").event, "x")
})

test("events: a full run ends in success and offers the shutdown", () => {
  const run = fold(SUCCESS_RUN)
  assert.strictEqual(run.success, true)
  assert.deepStrictEqual(run.warnings, [], "the BitLocker reminder is not shown")
  const o = M.switchOutcome(run, 0, "mshybrid", false)
  assert.deepStrictEqual(o, { kind: "success", message: "MSHybrid is staged. It takes effect after a full shutdown.", warning: "", offerShutdown: true })
  // Folding appends to the run it was given (no copy per line).
  const before = M.newSwitchRun()
  assert.strictEqual(M.applySwitchLine(before, ev("success", "x")), before)
  assert.strictEqual(before.success, true)
})

test("events: a run stays bounded (500 events, 20 messages, long lines unparsed)", () => {
  const r = M.newSwitchRun()
  for (let i = 0; i < 2000; i++) M.applySwitchLine(r, ev("tick" + i, "x"))
  assert.strictEqual(r.events.length, 500)
  assert.strictEqual(r.events[499], "tick1999", "the latest events are kept")
  for (let i = 0; i < 100; i++) M.applySwitchLine(r, errLine("e" + i))
  for (let i = 0; i < 100; i++) M.applySwitchLine(r, warn("w", "w" + i))
  assert.strictEqual(r.errors.length, 20)
  assert.strictEqual(r.errors[0], "e0", "the first errors are kept")
  assert.strictEqual(r.warnings.length, 20)
  M.applySwitchLine(r, errLine("x".repeat(100000)))
  assert.strictEqual(r.errors.length, 20)
  const long = M.newSwitchRun()
  M.applySwitchLine(long, errLine("y".repeat(70000)))
  assert.deepStrictEqual([long.errors.length, long.other], [0, 1], "a line over 64 KiB is not parsed")
  assert.ok(long.firstOther.length <= 501)
  const msg = M.newSwitchRun()
  M.applySwitchLine(msg, errLine("z".repeat(2000)))
  assert.ok(msg.errors[0].length <= 501 && msg.errors[0].endsWith("…"))
})

test("events: cancelling a pending switch says so and offers no shutdown", () => {
  const o = M.switchOutcome(fold(SUCCESS_RUN), 0, "discrete", true)
  assert.strictEqual(o.kind, "cancelled")
  assert.ok(o.message.startsWith("Pending switch cancelled"))
  assert.strictEqual(o.offerShutdown, false)
})

test("events: unchanged is a no-op", () => {
  const run = fold([SUCCESS_RUN[0], SUCCESS_RUN[1], ev("unchanged", "The machine is already in discrete mode. No state was changed.", { mode: "discrete", value: 1 })])
  const o = M.switchOutcome(run, 0, "discrete", false)
  assert.strictEqual(o.kind, "unchanged")
  assert.strictEqual(o.offerShutdown, false)
})

test("events: an error event is shown; exit 1", () => {
  const run = fold([SUCCESS_RUN[0], SUCCESS_RUN[1], SUCCESS_RUN[2], SUCCESS_RUN[3], errLine("AC power is required for a GPU mode transition")])
  const o = M.switchOutcome(run, 1, "mshybrid", false)
  assert.deepStrictEqual(o, { kind: "error", message: "AC power is required for a GPU mode transition", warning: "", offerShutdown: false })
})

test("events: cli_error (usage, exit 2) is shown", () => {
  const run = fold([JSON.stringify({ event: "cli_error", level: "error", message: "error: unexpected argument '--x'" })])
  const o = M.switchOutcome(run, 2, "discrete", false)
  assert.strictEqual(o.kind, "error")
  assert.strictEqual(o.message, "error: unexpected argument '--x'")
})

test("events: trigger_sent_before_failure is a prominent warning", () => {
  const run = fold(SUCCESS_RUN.slice(0, 10).concat([
    warn("trigger_sent_before_failure", "the EC apply trigger was sent before failure; save work and perform a manual full shutdown"),
    errLine("acknowledgement timed out")]))
  assert.strictEqual(run.triggerSent, true)
  const o = M.switchOutcome(run, 1, "mshybrid", false)
  assert.strictEqual(o.kind, "error")
  assert.strictEqual(o.message, "acknowledgement timed out")
  assert.strictEqual(o.warning, M.TRIGGER_WARNING)
  assert.ok(/save your work/i.test(o.warning) && /full shutdown/.test(o.warning))
  // Also kept when pkexec reports 126/127 afterwards (it cannot, but the
  // warning must never be dropped).
  assert.strictEqual(M.switchOutcome(run, 126, "mshybrid", false).warning, M.TRIGGER_WARNING)
})

test("events: other warnings are appended; non-JSON lines are ignored", () => {
  const run = fold(["Sourcing something", "", "   "].concat(SUCCESS_RUN.slice(0, 9), [
    warn("target_restored", "the previous target was restored"), errLine("trigger failed")]))
  assert.strictEqual(run.other, 1)
  const o = M.switchOutcome(run, 1, "mshybrid", false)
  assert.strictEqual(o.message, "trigger failed the previous target was restored")
  // Garbage around a full run changes nothing.
  const noisy = fold(["garbage", "{not json"].concat(SUCCESS_RUN, ["trailing text"]))
  assert.strictEqual(M.switchOutcome(noisy, 0, "mshybrid", false).kind, "success")
})

test("events: success needs both the success event and exit 0", () => {
  assert.strictEqual(M.switchOutcome(fold(SUCCESS_RUN), 1, "mshybrid", false).kind, "error")
  const noSuccess = M.switchOutcome(fold(SUCCESS_RUN.slice(0, -1)), 0, "mshybrid", false)
  assert.strictEqual(noSuccess.kind, "error")
  assert.strictEqual(noSuccess.message, "msi-mux-switch did not report success.")
  assert.strictEqual(M.switchOutcome(fold(SUCCESS_RUN.concat([errLine("late")])), 0, "mshybrid", false).kind, "error")
  assert.strictEqual(M.switchOutcome(M.newSwitchRun(), 0, "mshybrid", false).offerShutdown, false)
})

test("events: pkexec 126 is authentication cancelled, 127 not authorized", () => {
  let o = M.switchOutcome(M.newSwitchRun(), 126, "discrete", false)
  assert.strictEqual(o.kind, "auth-cancelled")
  assert.ok(/authentication cancelled/i.test(o.message))
  o = M.switchOutcome(M.newSwitchRun(), 127, "discrete", false)
  assert.strictEqual(o.kind, "not-authorized")
  assert.strictEqual(o.message, "Not authorized to switch the GPU mode. Nothing was changed.")
  // pkexec's own reason (its first non-JSON line) is shown with it.
  const run = fold(["Error executing command as another user: No authentication agent found.", "second line"])
  o = M.switchOutcome(run, 127, "discrete", false)
  assert.strictEqual(o.kind, "not-authorized")
  assert.strictEqual(o.message, "Not authorized to switch the GPU mode. Nothing was changed. pkexec said: Error executing command as another user: No authentication agent found.")
  o = M.switchOutcome(M.newSwitchRun(), -1, "discrete", false)
  assert.strictEqual(o.message, "pkexec could not be started. Nothing was changed.")
})

// ------------------------------------------------------------------- AC

test("AC: the Mains supply's online value", () => {
  assert.deepStrictEqual(M.acArgv(), ["sh", "-c", M.AC_SCRIPT, "msi-mux-ac", "/sys/class/power_supply"])
  assert.ok(!/ADP1/.test(M.AC_SCRIPT), "the supply name is not hard-coded")
  assert.strictEqual(M.parseAc("mains 1\nend\n"), true)
  assert.strictEqual(M.parseAc("mains 0\nend\n"), false)
  assert.strictEqual(M.parseAc("mains 0\nmains 1\nend\n"), true)
  assert.strictEqual(M.parseAc("mains \nend\n"), false)
  assert.strictEqual(M.parseAc("end\n"), null, "no Mains supply")
  assert.strictEqual(M.parseAc("mains 1\n"), null, "no end line")
  assert.strictEqual(M.parseAc(""), null)
  assert.strictEqual(M.acText(false), "On battery. Connect AC power — the switch requires it.")
})

// ------------------------------------------------------------ what to show

const view = (over) => Object.assign({ available: true, unavailableReason: "", busy: false, ac: true,
  debug: M.parseDebug(CAPTURE, "", 0) }, over || {})
const rowOf = (rows, mode) => rows.find(r => r.mode === mode)

test("rows: three modes with descriptions; the current one has no button", () => {
  const rows = M.modeRows(view())
  assert.deepStrictEqual(rows.map(r => r.mode), ["discrete", "mshybrid", "integrated"])
  for (const r of rows) assert.ok(r.description.length > 10 && r.label !== "Unknown")
  assert.strictEqual(rowOf(rows, "discrete").action, "")
  assert.strictEqual(rowOf(rows, "discrete").status, "Current mode.")
  assert.deepStrictEqual([rowOf(rows, "mshybrid").action, rowOf(rows, "mshybrid").enabled], ["switch", true])
  assert.deepStrictEqual([rowOf(rows, "integrated").action, rowOf(rows, "integrated").enabled], ["switch", true])
  assert.strictEqual(M.switchBlocker(view()), "")
})

test("rows: pending offers Cancel pending on the current mode", () => {
  const d = M.parseDebug(withFirmware({ selected_target_mode: "ms-hybrid" }), "", 0)
  const rows = M.modeRows(view({ debug: d }))
  assert.deepStrictEqual([rowOf(rows, "discrete").action, rowOf(rows, "discrete").buttonText, rowOf(rows, "discrete").enabled],
    ["cancel", "Cancel pending", true])
  assert.strictEqual(rowOf(rows, "mshybrid").action, "")
  assert.ok(rowOf(rows, "mshybrid").status.includes("full shutdown"))
  assert.strictEqual(rowOf(rows, "integrated").action, "switch")
})

test("rows: on battery, unknown AC, busy, unavailable or unread: every button disabled, with the reason", () => {
  const cases = [
    [{ ac: false }, "Connect AC power — the switch requires it."],
    [{ ac: null }, M.AC_UNKNOWN_TEXT],
    [{ busy: true }, "A switch is in progress."],
    [{ available: false, unavailableReason: BIN + " is owned by raul, not root." }, BIN + " is owned by raul, not root."],
    [{ debug: M.emptyDebug() }, "Reading the GPU mode…"],
    [{ debug: M.parseDebug("{", "", 0) }, "msi-mux-switch --debug gave no readable answer."]
  ]
  for (const [over, reason] of cases) {
    assert.strictEqual(M.switchBlocker(view(over)), reason)
    for (const r of M.modeRows(view(over))) assert.strictEqual(r.enabled, false, JSON.stringify(over) + " " + r.mode)
  }
})

test("rows: each disabled button carries its own short reason; enabled ones none", () => {
  const cases = [
    [{ ac: false }, "Needs AC power."],
    [{ ac: null }, "Needs AC power (state unknown)."],
    [{ busy: true }, "Wait for the switch in progress."],
    [{ available: false, unavailableReason: BIN + " is owned by raul, not root." }, "Unavailable: see above."],
    [{ debug: M.emptyDebug() }, "Waiting for the GPU mode."]
  ]
  for (const [over, reason] of cases) {
    const rows = M.modeRows(view(over))
    for (const m of ["mshybrid", "integrated"]) assert.strictEqual(rowOf(rows, m).reason, reason, JSON.stringify(over) + " " + m)
    if (over.debug === undefined) assert.strictEqual(rowOf(rows, "discrete").reason, "", "the current mode gives no reason")
  }
  for (const r of M.modeRows(view())) assert.strictEqual(r.reason, "")
  // The staged target says so in its status, not as a reason.
  const d = M.parseDebug(withFirmware({ selected_target_mode: "ms-hybrid" }), "", 0)
  assert.strictEqual(rowOf(M.modeRows(view({ debug: d, ac: false })), "mshybrid").reason, "")
  assert.strictEqual(rowOf(M.modeRows(view({ debug: d, ac: false })), "discrete").reason, "Needs AC power.")
})

test("rows: descriptions are one short line each; the cancel label is short", () => {
  for (const m of M.MODES) assert.ok(M.MODE_DESCRIPTIONS[m].length <= 50, m + ": " + M.MODE_DESCRIPTIONS[m])
  assert.ok(M.MODE_DESCRIPTIONS.discrete.length <= 32 && M.MODE_DESCRIPTIONS.integrated.length <= 32)
})

test("rows: a mode the firmware does not offer has no button", () => {
  const d = M.parseDebug(withFirmware({ integrated_supported: false }), "", 0)
  const r = rowOf(M.modeRows(view({ debug: d })), "integrated")
  assert.deepStrictEqual([r.action, r.enabled, r.status, r.reason], ["", false, "", "Not offered by this firmware."])
})

test("bar: greyed when unavailable or unread; badge only when pending", () => {
  assert.deepStrictEqual(M.barState(view()), { icon: M.ICON.discrete, dimmed: false, badge: false })
  assert.strictEqual(M.barState(view({ available: false })).dimmed, true)
  assert.strictEqual(M.barState(view({ debug: M.emptyDebug() })).dimmed, true)
  assert.strictEqual(M.barState(view({ debug: M.emptyDebug() })).badge, false)
  assert.strictEqual(M.tooltipText(view()), "MSI GPU MUX: Discrete")
  assert.strictEqual(M.tooltipText(view({ unavailableReason: "why" })), "MSI GPU MUX: Discrete\nwhy")
  assert.ok(M.isPending("discrete", "mshybrid") && !M.isPending("discrete", "discrete") && !M.isPending("", "discrete") && !M.isPending("discrete", ""))
})

test("dialogs: the mode and the full shutdown are named; Integrated warns unless turned off", () => {
  for (const m of M.MODES) {
    const msg = M.confirmMessage(m, false, true)
    assert.ok(msg.includes(M.modeLabel(m)) && msg.includes("takes effect after a full shutdown"), msg)
  }
  assert.ok(/external screens/.test(M.confirmMessage("integrated", false, true)))
  assert.ok(/external screens/.test(M.confirmMessage("integrated", false, undefined)))
  assert.ok(!/external screens/.test(M.confirmMessage("integrated", false, false)))
  assert.ok(!/external screens/.test(M.confirmMessage("discrete", false, true)))
  assert.ok(M.confirmMessage("discrete", true, true).startsWith("Cancel the pending switch"))
  // Replacing a staged switch says so; staging the same mode again or
  // nothing staged does not.
  assert.ok(/This replaces the switch to MSHybrid that is already staged\./.test(M.confirmMessage("integrated", false, true, "mshybrid")))
  assert.ok(!/replaces/.test(M.confirmMessage("integrated", false, true, "")))
  assert.ok(!/replaces/.test(M.confirmMessage("integrated", false, true, "integrated")))
  assert.ok(!/replaces/.test(M.confirmMessage("discrete", true, true, "mshybrid")))
  assert.strictEqual(M.warnSetting(undefined), true)
  assert.strictEqual(M.warnSetting(false), false)
  assert.ok(/Shut down now/.test(M.SHUTDOWN_MESSAGE) && /full shutdown/.test(M.SHUTDOWN_MESSAGE))
})

test("wording: shut down, never an instruction to reboot", () => {
  const strings = [...source.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1])
  for (const s of strings) {
    assert.ok(!/\b(reboot now|please reboot|reboot to|restart to|restart now)\b/i.test(s), s)
    // Every mention of reboot is a warning that it is not enough.
    if (/reboot/i.test(s)) assert.ok(/reboot is not enough|reboot does not apply|not a reboot/i.test(s), s)
  }
  assert.ok(!/reboot/i.test(read("BarWidget.qml").replace(/\/\/.*$/gm, "")))
})

// ---------------------------------------------------------------- cursor

test("cursor: stops in screen order, disabled buttons skipped", () => {
  const rows = M.modeRows(view())
  assert.deepStrictEqual(M.cursorStops(rows, {}), ["mode|mshybrid", "mode|integrated"])
  assert.deepStrictEqual(M.cursorStops(rows, { canSetUp: true, showEnv: true }), ["setup", "mode|mshybrid", "mode|integrated", "env"])
  assert.deepStrictEqual(M.cursorStops(M.modeRows(view({ ac: false })), { canSetUp: true }), ["setup"])
  const pending = M.modeRows(view({ debug: M.parseDebug(withFirmware({ selected_target_mode: "ms-hybrid" }), "", 0) }))
  assert.deepStrictEqual(M.cursorStops(pending, { showEnv: true }), ["mode|discrete", "mode|integrated", "env"], "Cancel pending is a stop")
  assert.deepStrictEqual(M.cursorStops(null, null), [])
})

test("cursor: stepping, falling back, and the action under it", () => {
  const stops = ["setup", "mode|mshybrid", "env"]
  assert.strictEqual(M.stepCursor(stops, "setup", 0, 1), "mode|mshybrid")
  assert.strictEqual(M.stepCursor(stops, "mode|mshybrid", 0, 1), "env")
  assert.strictEqual(M.stepCursor(stops, "env", 0, 1), "env", "stops at the end")
  assert.strictEqual(M.stepCursor(stops, "setup", 0, -1), "setup")
  assert.strictEqual(M.stepCursor(stops, "setup", 1, 0), "mode|mshybrid", "Left/Right step too")
  assert.strictEqual(M.stepCursor(stops, "gone", 0, 1), "setup")
  assert.strictEqual(M.stepCursor([], "setup", 0, 1), "")
  assert.strictEqual(M.cursorKeyIn(stops, "env"), "env")
  assert.strictEqual(M.cursorKeyIn(stops, "mode|discrete"), "setup", "a stop that went away falls back to the first")
  assert.strictEqual(M.cursorKeyIn([], "env"), "")
  assert.deepStrictEqual(M.cursorAction("mode|integrated"), { kind: "mode", arg: "integrated" })
  assert.deepStrictEqual(M.cursorAction("setup"), { kind: "setup", arg: "" })
  assert.deepStrictEqual(M.cursorAction("env"), { kind: "env", arg: "" })
  for (const bad of ["mode|bogus", "", null, "switch|x"]) assert.deepStrictEqual(M.cursorAction(bad), { kind: "", arg: "" })
})

// ------------------------------------------------------------- the env file

test("env file: the one path, under ~/.config/uwsm/env.d", () => {
  assert.strictEqual(M.envFilePath("/home/u"), "/home/u/.config/uwsm/env.d/90-msi-mux-gpu")
  assert.deepStrictEqual(M.envReadArgv("/home/u"), ["sh", "-c", M.ENV_READ_SCRIPT, "msi-mux-env-read", "/home/u/.config/uwsm/env.d/90-msi-mux-gpu"])
  assert.deepStrictEqual(M.envWriteArgv("/home/u", "rtx"), ["sh", "-c", M.ENV_WRITE_SCRIPT, "msi-mux-env-write",
    "/home/u/.config/uwsm/env.d", "/home/u/.config/uwsm/env.d/90-msi-mux-gpu", M.envFileText("rtx")])
  assert.deepStrictEqual(M.envWriteArgv("/home/u", "auto"), [])
  assert.ok(/head -c 65537 -- "\$1"/.test(M.ENV_READ_SCRIPT), "the read is bounded")
  assert.deepStrictEqual(M.envRemoveArgv("/home/u"), ["rm", "-f", "--", "/home/u/.config/uwsm/env.d/90-msi-mux-gpu",
    "/home/u/.config/uwsm/env.d/.90-msi-mux-gpu.tmp", "/home/u/.config/uwsm/env.d/90-msi-mux-gpu.new"])
  assert.ok(M.ENV_WRITE_SCRIPT.includes('t="$1/.90-msi-mux-gpu.tmp"'), "the temporary file is dot-prefixed, in env.d")
  assert.ok(M.ENV_WRITE_SCRIPT.includes('mv -fT -- "$t" "$2" || { rm -f -- "$t"; exit 1; }'), "never moved into a directory; cleaned up on failure")
  assert.ok(!/\.new/.test(M.ENV_WRITE_SCRIPT))
  for (const bad of ["", "relative", "/home/../x", "/home/u\n", null]) {
    assert.strictEqual(M.envFilePath(bad), "")
    assert.deepStrictEqual(M.envRemoveArgv(bad), [])
    assert.deepStrictEqual(M.envReadArgv(bad), [])
    assert.deepStrictEqual(M.envWriteArgv(bad, "intel"), [])
  }
})

test("env file: the README's RTX block is envFileText(\"rtx\") byte for byte", () => {
  const readme = read("README.md")
  const section = readme.indexOf("## What this does to your Hyprland config")
  assert.ok(section > 0, "README section missing")
  const rest = readme.slice(section)
  const m = /For the \*\*RTX \(experimental\)\*\* choice the file is exactly:\n\n```sh\n([\s\S]*?)\n```\n/.exec(rest)
  assert.ok(m, "fenced sh block missing")
  assert.strictEqual(m[1] + "\n", M.envFileText("rtx"))
  assert.ok(rest.includes("~/.config/uwsm/env.d/90-msi-mux-gpu"))
  assert.ok(rest.includes("rm ~/.config/uwsm/env.d/90-msi-mux-gpu"))
})

test("env file: the generator's rules", () => {
  for (const base of ["intel", "rtx"]) {
    const t = M.envFileText(base)
    assert.ok(t.startsWith("# Written by the MSI GPU MUX Omarchy plugin (io.github.rsd.msi-mux).\n# msi-mux-base: " + base + "\n"))
    assert.ok(/pick Auto in the plugin, or delete this file/.test(t))
    assert.ok(t.endsWith("\n") && !t.endsWith("\n\n"))
    assert.ok(!/(^|\W)(exit|return)(\W|$)/m.test(t.replace(/^#.*$/gm, "")))
    assert.ok(!/set -e|^\s*(echo|printf)/m.test(t))
    assert.ok(t.includes("/sys/class/drm/card*") && t.includes("*-*) continue"))
    assert.ok(t.includes("0x8086") && t.includes("0x10de") && t.includes("/dev/dri/"))
    assert.ok(t.includes("2>/dev/null"))
    // Every variable it sets is prefixed and unset at the end.
    const vars = [...new Set([...t.matchAll(/\b(msi_mux_\w+)=|\bfor (msi_mux_\w+) in\b/g)].map(x => x[1] || x[2]))].sort()
    const unset = /^unset (.*)$/m.exec(t)[1].split(" ").sort()
    assert.deepStrictEqual(vars, unset)
    assert.deepStrictEqual([...t.matchAll(/^\s*([A-Za-z_]\w*)=/gm)].map(x => x[1]).filter(v => !v.startsWith("msi_mux_")), [])
    assert.ok(/^unset /m.test(t.trim().split("\n").pop()), "unset is the last command")
  }
  assert.ok(M.envFileText("intel").includes("export AQ_DRM_DEVICES=\"$msi_mux_intel:$msi_mux_nvidia\""))
  assert.ok(M.envFileText("rtx").includes("export AQ_DRM_DEVICES=\"$msi_mux_nvidia:$msi_mux_intel\""))
  for (const bad of ["auto", "", "nvidia", "RTX", null]) assert.strictEqual(M.envFileText(bad), "")
})

test("env file: the dropdown's value comes from the file", () => {
  assert.strictEqual(M.parseEnvRead("absent\n"), "auto")
  assert.strictEqual(M.parseEnvRead("file\n" + M.envFileText("intel")), "intel")
  assert.strictEqual(M.parseEnvRead("file\n" + M.envFileText("rtx")), "rtx")
  assert.strictEqual(M.parseEnvRead("other\n"), "modified")
  assert.strictEqual(M.parseEnvRead(""), "modified")
  assert.strictEqual(M.parseEnvRead("file\n" + "x".repeat(65537)), "modified")
  assert.strictEqual(M.envChoiceFromFile(null), "auto")
  assert.strictEqual(M.envChoiceFromFile(undefined), "auto")
  assert.strictEqual(M.envChoiceFromFile(M.envFileText("intel")), "intel")
  assert.strictEqual(M.envChoiceFromFile(M.envFileText("rtx")), "rtx")
  assert.strictEqual(M.envChoiceFromFile(""), "modified")
  assert.strictEqual(M.envChoiceFromFile(M.envFileText("rtx") + "export X=1\n"), "modified")
  assert.strictEqual(M.envChoiceFromFile(M.envFileText("rtx").replace("base: rtx", "base: intel")), "modified")
  assert.strictEqual(M.envChoiceFromFile("export AQ_DRM_DEVICES=/dev/dri/card1\n"), "modified")
  assert.deepStrictEqual(M.ENV_OPTIONS.map(o => o.value), M.ENV_CHOICES)
  assert.deepStrictEqual(M.ENV_OPTIONS.map(o => o.label), ["Auto", "Intel", "RTX (experimental)"])
  assert.ok(M.showEnvChoice("mshybrid", "auto"))
  assert.ok(!M.showEnvChoice("discrete", "auto"))
  assert.ok(!M.showEnvChoice("", "auto"))
  assert.ok(M.showEnvChoice("discrete", "rtx"), "an existing file can always be removed")
  assert.ok(M.showEnvChoice("integrated", "modified"))
  assert.strictEqual(M.LOGOUT_TEXT, "Log out to apply.")
})

// ------------------------------------------------------------- the QML

const qmlFiles = fs.readdirSync(pluginDir).filter(f => f.endsWith(".qml"))
const qmlCode = file => read(file).replace(/\/\/.*$/gm, "")

test("every Model.<name> the QML uses exists in Model.js", () => {
  for (const file of qmlFiles) {
    const qml = qmlCode(file).replace(/^import\s+.*$/gm, "")
    for (const m of qml.matchAll(/\bModel\.([A-Za-z_]\w*)/g))
      assert.ok(NAMES.includes(m[1]), file + " uses Model." + m[1] + ", not in Model.js")
  }
})

test("every MuxState.<name> the widget uses exists; MuxState is a declared singleton", () => {
  const state = qmlCode("MuxState.qml")
  const defined = new Set([...state.matchAll(/^\s*(?:readonly\s+)?property\s+\w+\s+(\w+)|^\s*function\s+(\w+)\s*\(|^\s*signal\s+(\w+)/gm)]
    .map(m => m[1] || m[2] || m[3]))
  for (const m of qmlCode("BarWidget.qml").matchAll(/\bMuxState\.([A-Za-z_]\w*)/g)) assert.ok(defined.has(m[1]), "MuxState." + m[1])
  assert.ok(/^singleton MuxState 1\.0 MuxState\.qml$/m.test(read("qmldir")))
  assert.ok(/^pragma Singleton$/m.test(read("MuxState.qml")))
})

// The body of the QML block whose "{" is at `open`, with nested blocks and
// string literals blanked out.
const ownBody = (qml, open) => {
  let depth = 0, out = ""
  for (let i = open; i < qml.length; i++) {
    const c = qml[i]
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < qml.length && qml[j] !== c) j += qml[j] === "\\" ? 2 : 1
      if (depth === 1) out += c + c
      i = j
      continue
    }
    if (c === "{") { depth++; if (depth === 1) continue }
    if (c === "}") { depth--; if (depth === 0) return out; continue }
    if (depth === 1) out += c
  }
  throw new Error("unbalanced block at " + open)
}
const textBlocks = (qml) => [...qml.matchAll(/(^|[\s:])Text\s*\{/gm)].map(m => {
  const open = m.index + m[0].length - 1
  return [qml.slice(0, open).split("\n").length, ownBody(qml, open)]
})

test("every Text declares textFormat: Text.PlainText, each in its own block", () => {
  let total = 0
  for (const file of qmlFiles) {
    for (const [line, body] of textBlocks(qmlCode(file))) {
      total++
      const own = (body.match(/(^|[\s;])textFormat:\s*Text\.PlainText\b/g) || []).length
      assert.strictEqual(own, 1, file + ":" + line + ": a Text with " + own + " own textFormat: Text.PlainText")
    }
  }
  assert.ok(total >= 15, "Text blocks found: " + total)
})

test("processes: every command and execDetached argv comes from the model; no shell around pkexec", () => {
  for (const file of qmlFiles) {
    const qml = qmlCode(file)
    for (const m of qml.matchAll(/\.command\s*=\s*([^\n]+)/g))
      assert.ok(/^Model\.\w+\(/.test(m[1].trim()) || m[1].trim() === "argv", file + ": command = " + m[1])
    for (const m of qml.matchAll(/execDetached\(([^)\n]*)/g))
      assert.ok(/^(Model\.\w+|argv)$/.test(m[1].trim()), file + ": execDetached(" + m[1])
    assert.ok(!/\bcommand:\s*\[/.test(qml), file + " has an inline command array")
    assert.ok(!/"pkexec"|"sudo"|"sh"|"bash"|"-c"/.test(qml), file + " builds a command itself")
  }
  const state = qmlCode("MuxState.qml")
  assert.ok(/var argv = Model\.switchArgv\(root\.binaryPath, root\.switchMode, root\.hardware\.flags\)/.test(state))
  assert.ok(/switchProc\.command = argv/.test(state))
  assert.strictEqual((state.match(/switchProc\.running = true/g) || []).length, 1, "the switch starts in one place")
  // That place is after the fresh ownership and AC verdicts.
  const start = state.slice(state.indexOf("function startSwitch()"))
  const body = start.slice(0, start.indexOf("\n  }\n"))
  assert.ok(body.indexOf("Model.ownershipVerdict") < body.indexOf("switchProc.running = true"))
  assert.ok(body.indexOf("checkAc.result !== true") < body.indexOf("switchProc.running = true"))
  assert.ok(/stdout: SplitParser/.test(state) && /stderr: SplitParser/.test(state))
  assert.ok(/if \(root\.busy \|\| !Model\.isMode\(mode\)\) return false/.test(state), "one switch at a time")
  const bar = qmlCode("BarWidget.qml")
  assert.ok(/Quickshell\.execDetached\(Model\.SHUTDOWN_ARGV\)/.test(bar))
  assert.ok(/onConfirmed: root\.confirmSwitch\(\)/.test(bar), "the switch is asked for only from the confirmation")
  assert.strictEqual((bar.match(/MuxState\.requestSwitch\(/g) || []).length, 1)
})

test("polling: AC every AC_POLL_MS only while a panel is open; no mode polling", () => {
  const state = qmlCode("MuxState.qml")
  assert.ok(/interval: Model\.AC_POLL_MS\s*\n\s*running: root\.openPanels\.length > 0/.test(state))
  assert.strictEqual(M.AC_POLL_MS, 2000)
  const timers = state.match(/\bTimer \{/g) || []
  assert.strictEqual(timers.length, 2, "the start delay and the AC poll only")
  assert.ok(!/repeat: true[\s\S]{0,80}readDebug/.test(state))
})

test("files: only the env file is written, through the model's argv; read bounded, never a FileView", () => {
  const state = qmlCode("MuxState.qml")
  assert.ok(/readonly property string envFilePath: Model\.envFilePath\(root\.home\)/.test(state))
  assert.ok(!/FileView|setText\(/.test(state), "no unbounded FileView read")
  assert.ok(/Model\.envRemoveArgv\(root\.home\) : Model\.envWriteArgv\(root\.home, value\)/.test(state))
  assert.ok(/var argv = Model\.envReadArgv\(root\.home\)/.test(state))
  assert.ok(/Model\.parseEnvRead\(text\)/.test(state))
  assert.ok(!/hypr/.test(state.replace(/Hyprland/g, "")), "nothing under ~/.config/hypr")
})

test("env choice: one change at a time; a choice made meanwhile is applied after it", () => {
  const state = qmlCode("MuxState.qml")
  const set = state.slice(state.indexOf("function setEnvChoice("))
  const body = set.slice(0, set.indexOf("\n  }\n"))
  // The queue is checked before the "same as now" shortcut, so RTX then Auto
  // while RTX is written is not dropped.
  assert.ok(body.indexOf("root.envQueued = value") !== -1)
  assert.ok(body.indexOf("if (root.envBusy)") < body.indexOf("value === root.envChoice"))
  const done = state.slice(state.indexOf("function envDone()"))
  assert.ok(/var next = root\.envQueued[\s\S]*root\.startEnv\(next, true\)/.test(done.slice(0, done.indexOf("\n  }\n"))))
  assert.strictEqual((state.match(/envProc\.running = true/g) || []).length, 1, "every env change starts in one place")
  // After every read back, the dropdown follows the file on disk, even when
  // envChoice did not change (a failed pick does not stay shown).
  assert.ok(/root\.envChoice = Model\.parseEnvRead\(text\)\s*root\.envRead\(\)/.test(state))
  assert.ok(/function onEnvRead\(\) \{ root\.syncEnvDropdown\(\) \}/.test(qmlCode("BarWidget.qml")))
})

test("switch: pgrep runs before pkexec, after this plugin's own debug read", () => {
  const state = qmlCode("MuxState.qml")
  assert.ok(/checkRunning\.command = Model\.pgrepArgv\(\)/.test(state))
  const start = state.slice(state.indexOf("function startSwitch()"))
  const body = start.slice(0, start.indexOf("\n  }\n"))
  assert.ok(body.indexOf("checkRunning.result === undefined") !== -1)
  assert.ok(body.indexOf("Model.runningProblem(checkRunning.result)") < body.indexOf("switchProc.running = true"))
  assert.ok(/if \(debugProc\.running\) root\.pgrepWaiting = true\s*else checkRunning\.running = true/.test(state))
  assert.ok(/debugProc\.running \|\| root\.phase === "checking"/.test(state), "no debug read starts while a switch is checked")
})

test("panel: keyboard cursor, Keep pending, per-row reasons, stale results cleared", () => {
  const bar = qmlCode("BarWidget.qml")
  assert.ok(/PanelKeyCatcher \{\s*id: keyCatcher/.test(bar))
  assert.ok(/focusTarget: keyCatcher/.test(bar))
  assert.ok(/Model\.cursorStops\(root\.rows, \{ canSetUp: MuxState\.canSetUp, showEnv: root\.showEnv \}\)/.test(bar))
  for (const k of ['"setup"', '"env"', "modeButton.key"])
    assert.ok(new RegExp("hasCursor: root\\.cursorActive && root\\.cursorAt === " + k.replace(/\./g, "\\.")).test(bar), k)
  assert.ok(/cancelText: root\.confirmCancel \? "Keep pending" : "Cancel"/.test(bar))
  assert.ok(/text: modeRow\.row \? modeRow\.row\.reason : ""/.test(bar))
  assert.ok(!/root\.blocker/.test(bar), "no separate blocker line repeating AC or busy")
  assert.ok(/if \(root\.reopenForOutcome\) root\.reopenForOutcome = false\s*else if \(!MuxState\.busy\) MuxState\.clearOutcome\(\)/.test(bar))
  assert.ok(/root\.reopenForOutcome = true\s*root\.open\(\)/.test(bar))
  assert.ok(!/value: "auto"/.test(bar), "the dropdown's value comes from syncEnvDropdown only")
  // The unavailable reason is information, not an error colour.
  const i = bar.indexOf("text: MuxState.unavailableReason")
  assert.ok(/color: root\.foreground/.test(bar.slice(i, i + 200)))
})

// ---------------------------------------------------- manifest and layout

test("manifest: identity, version and the settings schema", () => {
  const m = JSON.parse(read("manifest.json"))
  assert.strictEqual(m.schemaVersion, 1)
  assert.strictEqual(m.id, "io.github.rsd.msi-mux")
  assert.strictEqual(m.id, M.PLUGIN_ID)
  assert.strictEqual(m.name, "MSI GPU MUX")
  assert.strictEqual(m.version, "0.1.0")
  assert.strictEqual(m.license, "MIT")
  assert.deepStrictEqual(m.kinds, ["bar-widget"])
  assert.deepStrictEqual(m.entryPoints, { barWidget: "BarWidget.qml" })
  assert.deepStrictEqual(m.barWidget.defaults, { binaryPath: M.DEFAULT_BINARY, warnBeforeIntegrated: true })
  const schema = Object.fromEntries(m.barWidget.schema.map(s => [s.key, s]))
  assert.deepStrictEqual(Object.keys(schema), ["binaryPath", "warnBeforeIntegrated"])
  assert.strictEqual(schema.binaryPath.type, "path")
  assert.strictEqual(schema.binaryPath.defaultValue, M.DEFAULT_BINARY)
  assert.strictEqual(schema.warnBeforeIntegrated.type, "boolean")
  assert.strictEqual(schema.warnBeforeIntegrated.defaultValue, true)
  const bar = qmlCode("BarWidget.qml")
  assert.ok(/moduleName: "io\.github\.rsd\.msi-mux"/.test(bar))
  assert.ok(/root\.setting\("binaryPath", ""\)/.test(bar) && /root\.setting\("warnBeforeIntegrated", true\)/.test(bar))
})

// The files the plugin ships, listed one by one (tests/ included).
const SHIPPED = ["BarWidget.qml", "LICENSE", "Model.js", "MuxState.qml", "README.md", "manifest.json", "preview.png",
  "qmldir", "setup.sh", "tests/env-file-test.sh", "tests/env-file-text.js", "tests/fixtures/debug-discrete.json",
  "tests/fixtures/fake-msi-mux-switch", "tests/model-test.js", "tests/qmllint-check.js", "tests/run.sh", "tests/setup-test.sh"]

test("layout: every shipped file is there, none a symlink; tests/ holds only them", () => {
  for (const f of SHIPPED) {
    const p = path.join(pluginDir, f)
    assert.ok(fs.existsSync(p), "missing " + f)
    assert.ok(!fs.lstatSync(p).isSymbolicLink() && fs.lstatSync(p).isFile(), "not a plain file: " + f)
  }
  const walk = (dir) => fs.readdirSync(path.join(pluginDir, dir), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(dir + "/" + e.name) : [dir + "/" + e.name])
  for (const f of walk("tests")) assert.ok(SHIPPED.includes(f), "unexpected file " + f)
  assert.ok(/Copyright \(c\) 2026 Raul Dias/.test(read("LICENSE")))
})

test("layout: no shipped text file names private notes or assistant tooling", () => {
  // Built from parts so this file does not match itself.
  const words = [["\\.pri", "vate\\b"], ["CLAU", "DE\\.md"], ["AGE", "NTS\\.md"], ["\\bCla", "ude\\b"], ["\\bChat", "GPT\\b"],
    ["\\bCo", "pilot\\b"], ["\\bLL", "Ms?\\b"], ["\\bA", "I[- ](assist|generat|tool|agent)"]]
    .map(([a, b]) => new RegExp(a + b, "i"))
  for (const f of SHIPPED.filter(f => !f.endsWith(".png"))) {
    const text = read(f)
    for (const w of words) assert.ok(!w.test(text), f + " matches " + w)
  }
})

let failed = 0
for (const [name, fn] of tests) {
  try {
    fn()
    console.log("ok   " + name)
  } catch (e) {
    failed++
    console.log("FAIL " + name + "\n     " + String(e && e.message || e).split("\n").join("\n     "))
  }
}
console.log((tests.length - failed) + "/" + tests.length + " passed")
process.exit(failed ? 1 : 0)
