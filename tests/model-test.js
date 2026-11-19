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
const SUPPORTED_DMI = { vendor: "Micro-Star International Co., Ltd.", model: "Vector 16 HX AI A2XWIG", board: "MS-15M3", bios: "E15M3IMS.10E" }
const CAPTURE = read("tests/fixtures/debug-discrete.json")
const withFirmware = (over) => {
  const doc = JSON.parse(CAPTURE)
  Object.assign(doc.firmware.value, over)
  return JSON.stringify(doc, null, 2)
}

// ------------------------------------------------------------------ hardware

test("hardware: the allowlisted machine is available, with both override flags", () => {
  const d = M.hardwareDecision(SUPPORTED_DMI)
  assert.deepStrictEqual(d, { state: "available", source: "allowlist", flags: FLAGS, reason: "" })
  // A copy: changing it does not change the constant.
  d.flags.push("--x")
  assert.deepStrictEqual(M.OVERRIDE_FLAGS, FLAGS)
  assert.deepStrictEqual(M.hardwareDecision(SUPPORTED_DMI).flags, FLAGS)
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
    Object.assign({}, SUPPORTED_DMI, { bios: "E15M3IMS.10" }),
    Object.assign({}, SUPPORTED_DMI, { bios: "E15M3IMS.10F" }),
    Object.assign({}, SUPPORTED_DMI, { board: "MS-15M2" }),
    Object.assign({}, SUPPORTED_DMI, { model: "Vector 16 HX AI A2XWIH" }),
    { vendor: "MSI", model: "Raider", board: "MS-1", bios: "X" },
    Object.assign({}, SUPPORTED_DMI, { bios: "e15m3ims.10e" })
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
    const d = M.hardwareDecision(Object.assign({}, SUPPORTED_DMI, { vendor }))
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
  assert.deepStrictEqual(M.parseDmi(text), SUPPORTED_DMI)
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
  assert.deepStrictEqual(M.debugReadArgv(BIN, M.parseStat(replaceLine(ROOT_OK, BIN, st(0, "a1ff", "root", BIN))), FLAGS), [])
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
  assert.deepStrictEqual(M.debugReadArgv(BIN, M.parseStat(today), FLAGS), [], "not even the read-only debug read runs it")
})

test("ownership: missing binary, not a file, and a bad setting", () => {
  const missing = ROOT_OK.split("\n").filter(l => !l.endsWith("\t" + BIN)).join("\n")
  assert.deepStrictEqual(verdict(missing), { ok: false, kind: "missing", reason: "msi-mux-switch was not found at " + BIN + "." })
  assert.ok(M.setupHelps(verdict(missing)))
  assert.deepStrictEqual(M.debugReadArgv(BIN, M.parseStat(missing), FLAGS), [])
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

test("argv: the debug read, as the user, with the hardware's flags, under a timeout and the byte cap", () => {
  const command = ["timeout", "-k", "2", "10", BIN, "--debug", "--json"]
  assert.deepStrictEqual(M.debugCommand(BIN, FLAGS), command.concat(FLAGS))
  assert.deepStrictEqual(M.debugCommand(BIN, []), command)
  assert.deepStrictEqual(M.debugArgv(BIN, FLAGS), ["bash", "-c", M.DEBUG_SCRIPT, "msi-mux-debug"].concat(command, FLAGS))
  assert.deepStrictEqual(M.debugArgv(BIN, []), ["bash", "-c", M.DEBUG_SCRIPT, "msi-mux-debug"].concat(command))
  assert.deepStrictEqual(M.debugArgv("relative/msi-mux-switch", FLAGS), [])
  assert.strictEqual(typeof M.binaryPresent, "undefined", "no ungated presence check is left to run the binary on")
  // The script's only spliced text is the cap; the command is "$@".
  assert.strictEqual(M.DEBUG_MAX_BYTES, 1048576)
  const spliced = M.DEBUG_SCRIPT.replace(/head -c 1048577/g, "").replace(/-gt 1048576/g, "")
  assert.ok(!/\d{4,}/.test(spliced), "no other number in the script")
  assert.strictEqual((M.DEBUG_SCRIPT.match(/head -c 1048577 \| tr '\\000' '\\032'/g) || []).length, 2, "both streams capped while read")
  assert.ok(/out=\$\("\$@" 3>&- \| head -c/.test(M.DEBUG_SCRIPT), "the command is \"$@\", read through head")
  assert.ok(!/\beval\b|\$\*/.test(M.DEBUG_SCRIPT))
})

test("argv: the debug read runs the binary only when it passes the switch's ownership gate", () => {
  const ok = M.parseStat(ROOT_OK)
  assert.deepStrictEqual(M.debugReadArgv(BIN, ok, FLAGS), M.debugArgv(BIN, FLAGS), "root-owned: the usual argv")
  assert.deepStrictEqual(M.debugReadArgv(BIN, ok, []), M.debugArgv(BIN, []))
  const refused = {
    "owned by uid 1000": replaceLine(ROOT_OK, BIN, st(1000, "81ed", "raul", BIN)),
    "group-writable binary": replaceLine(ROOT_OK, BIN, st(0, "81fd", "root", BIN)),
    "group-writable ancestor": replaceLine(ROOT_OK, "/opt", st(0, "41fd", "root", "/opt")),
    "user-owned ancestor": replaceLine(ROOT_OK, "/opt/msi-mux-switch", st(1000, "41ed", "raul", "/opt/msi-mux-switch")),
    "symlinked binary": replaceLine(ROOT_OK, BIN, st(0, "a1ff", "root", BIN)),
    "symlinked ancestor": replaceLine(ROOT_OK, "/opt", st(0, "a1ff", "root", "/opt")),
    "ancestor not stat'ed": ROOT_OK.split("\n").filter(l => !l.endsWith("\t/opt")).join("\n"),
    "missing binary": ROOT_OK.split("\n").filter(l => !l.endsWith("\t" + BIN)).join("\n")
  }
  for (const [why, text] of Object.entries(refused)) {
    assert.strictEqual(M.ownershipVerdict(BIN, M.parseStat(text)).ok, false, why)
    assert.deepStrictEqual(M.debugReadArgv(BIN, M.parseStat(text), FLAGS), [], why)
  }
  for (const m of M.USER_MOUNTS) {
    const p = m + "/x/msi-mux-switch"
    const all = M.parseStat([st(0, "81ed", "root", p)].concat(M.ancestorDirs(p).map(d => st(0, "41ed", "root", d))).join("\n"))
    assert.deepStrictEqual(M.debugReadArgv(p, all, FLAGS), [], p + ": a user mount, whatever stat says")
  }
  assert.deepStrictEqual(M.debugReadArgv(BIN, {}, FLAGS), [], "no stat, no read")
  assert.deepStrictEqual(M.debugReadArgv(BIN, undefined, FLAGS), [])
  assert.deepStrictEqual(M.debugReadArgv("relative/msi-mux-switch", ok, FLAGS), [])
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
  // No read runs while the backend is refused: the mode is unknown, not being read.
  assert.strictEqual(M.summary(M.emptyDebug(), true), "GPU mode unknown")
  assert.strictEqual(M.summary(M.emptyDebug(), false), "Reading the GPU mode…")
  // A refused backend outweighs an earlier good read: its mode is no longer trusted.
  const okRead = { ok: true, error: "", current: "mshybrid", target: "mshybrid", pending: false, modes: M.MODES }
  assert.strictEqual(M.summary(okRead, false), "Current: MSHybrid")
  assert.strictEqual(M.summary(okRead, true), "GPU mode unknown")
  assert.strictEqual(M.summary(Object.assign({}, okRead, { pending: true, target: "integrated" }), true), "GPU mode unknown")
})

// What DEBUG_SCRIPT prints for a command's stdout, stderr and status.
const framed = (out, err, status) => [out + "\nstatus " + status + "\n", err + "\nend\n"]

test("debug read: the script's framing is unwrapped, then parseDebug", () => {
  const [out, err] = framed(CAPTURE, "", 0)
  assert.deepStrictEqual(M.parseDebugRead(out, err, 0), M.parseDebug(CAPTURE, "", 0))
  assert.strictEqual(M.parseDebugRead(out, err, 0).ok, true)
  // The tool's own status and error line come through.
  const e = "{\"event\":\"error\",\"level\":\"error\",\"message\":\"boom\"}\n"
  assert.strictEqual(M.parseDebugRead(...framed("", e, 1), 0).error, "boom")
  assert.strictEqual(M.parseDebugRead(...framed(CAPTURE, "", 3), 0).error, "msi-mux-switch --debug failed (exit status 3).")
  // A body that holds a line like the script's: only the last line counts.
  assert.strictEqual(M.parseDebugRead(...framed("status 0", "", 0), 0).error, "msi-mux-switch --debug gave no readable answer.")
})

test("debug read: over the cap on either stream is refused unread, whatever else is there", () => {
  for (const [out, err] of [["\nover\n", "\nend\n"], [framed(CAPTURE, "", 0)[0], "\nover\n"], ["\nover\n", "\nover\n"],
      ["\nover\n", ""]]) {
    const d = M.parseDebugRead(out, err, 0)
    assert.strictEqual(d.ok, false)
    assert.strictEqual(d.error, "msi-mux-switch --debug printed more than 1 MiB; not read.")
  }
})

test("debug read: the timeout's statuses read as no answer in time", () => {
  for (const code of [124, 137]) {
    const d = M.parseDebugRead(...framed("", "", code), 0)
    assert.deepStrictEqual(d, Object.assign(M.emptyDebug(), { error: "msi-mux-switch --debug did not answer within 10 s." }))
  }
})

test("debug read: an unfinished read (no trailer, a cut trailer, the script failing) is an error", () => {
  const [out, err] = framed(CAPTURE, "", 0)
  for (const [o, e, code] of [[CAPTURE, "", 0], [out, "", 0], ["", err, 0], [out.slice(0, -1), err, 0], [out, err.slice(0, -1), 0],
      [out, err, -1], [out, err, 1], [CAPTURE + "\nstatus x\n", err, 0], [CAPTURE + "\nstatus 1234\n", err, 0], [undefined, null, 0]]) {
    const d = M.parseDebugRead(o, e, code)
    assert.strictEqual(d.ok, false, JSON.stringify([String(o).slice(-12), e, code]))
    assert.ok(/did not finish \(exit status/.test(d.error), d.error)
  }
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
  const o = M.switchOutcome(run, 0, "mshybrid")
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

// Cuts a text into chunks of n characters, as the raw SplitParser does.
const chunks = (text, n) => {
  const out = []
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n))
  return out
}
// Every line a stream's chunks produce, the tail included.
const splitAll = (parts) => {
  const buf = M.newLineBuffer()
  const lines = []
  for (const p of parts) lines.push(...M.splitChunk(buf, p))
  const tail = M.flushLine(buf)
  if (tail !== null) lines.push(tail)
  return lines
}

test("lines: a line split over several chunks comes out whole", () => {
  const buf = M.newLineBuffer()
  assert.deepStrictEqual(buf, { text: "", over: false })
  const line = ev("success", "ok")
  assert.deepStrictEqual(M.splitChunk(buf, line.slice(0, 5)), [])
  assert.deepStrictEqual(M.splitChunk(buf, line.slice(5, 12)), [])
  assert.deepStrictEqual(M.splitChunk(buf, line.slice(12) + "\n" + "next"), [line])
  assert.deepStrictEqual(M.splitChunk(buf, "\n"), ["next"])
  assert.strictEqual(M.flushLine(buf), null, "the output ended with \\n")
  for (const n of [1, 7, 100, 65536])
    assert.deepStrictEqual(splitAll(chunks(SUCCESS_RUN.join("\n") + "\n", n)), SUCCESS_RUN, "chunks of " + n)
})

test("lines: empty lines are kept; only \\n separates", () => {
  const buf = M.newLineBuffer()
  assert.deepStrictEqual(M.splitChunk(buf, "a\n\n\nb\r\nc\rd\n"), ["a", "", "", "b\r", "c\rd"])
  assert.deepStrictEqual(M.splitChunk(buf, "\n"), [""])
  assert.deepStrictEqual(M.splitChunk(buf, ""), [])
  assert.strictEqual(M.flushLine(buf), null)
})

test("lines: the unterminated tail is flushed; a trailing \\n leaves nothing", () => {
  const buf = M.newLineBuffer()
  assert.strictEqual(M.flushLine(buf), null, "nothing came")
  assert.deepStrictEqual(M.splitChunk(buf, "one\ntwo"), ["one"])
  assert.strictEqual(M.flushLine(buf), "two")
  assert.deepStrictEqual(buf, { text: "", over: false }, "the flush resets the buffer")
  assert.strictEqual(M.flushLine(buf), null)
  M.splitChunk(buf, "three\n")
  assert.strictEqual(M.flushLine(buf), null)
})

test("lines: an overlong line is capped at MAX_LINE_CHARS + 1 and rejected; the next line is intact", () => {
  const CAP = M.MAX_LINE_CHARS + 1
  assert.strictEqual(M.MAX_LINE_CHARS, 65536)
  const huge = "{" + "x".repeat(5 * 65536)
  // The next event in the same chunk as the end of the huge line.
  const parts = chunks(huge, 65536)
  parts[parts.length - 1] += "\n" + ev("success", "ok") + "\n"
  const buf = M.newLineBuffer()
  const lines = []
  for (const p of parts) {
    lines.push(...M.splitChunk(buf, p))
    assert.ok(buf.text.length <= CAP, "the buffer stays bounded: " + buf.text.length)
  }
  assert.strictEqual(M.flushLine(buf), null)
  assert.strictEqual(lines.length, 2)
  assert.strictEqual(lines[0], huge.slice(0, CAP))
  assert.strictEqual(lines[0].length, CAP)
  const run = fold(lines)
  assert.deepStrictEqual([run.other, run.events], [1, ["success"]], "the capped line is not an event")
  // The next event in the following chunk; the huge line is a JSON event
  // that would parse if it were not too long.
  const event = ev("error", "y".repeat(3 * 65536))
  assert.ok(M.parseEventLine(event))
  const lines2 = splitAll(chunks(event, 65536).concat(["\n" + ev("unchanged", "same")]))
  assert.deepStrictEqual(lines2.map(l => l.length), [CAP, ev("unchanged", "same").length])
  const run2 = fold(lines2)
  assert.deepStrictEqual([run2.other, run2.errors, run2.events], [1, [], ["unchanged"]])
  // A line of exactly MAX_LINE_CHARS stays whole and is parsed.
  const exact = ev("success", "z".repeat(M.MAX_LINE_CHARS - ev("success", "").length))
  assert.strictEqual(exact.length, M.MAX_LINE_CHARS)
  assert.deepStrictEqual(splitAll(chunks(exact + "\n", 4096)), [exact])
  assert.strictEqual(fold([exact]).success, true)
})

test("lines: an overlong unterminated tail is flushed capped; many chunks stay bounded", () => {
  const CAP = M.MAX_LINE_CHARS + 1
  const buf = M.newLineBuffer()
  const piece = "a".repeat(65536)
  for (let i = 0; i < 200; i++) {
    assert.deepStrictEqual(M.splitChunk(buf, piece), [])
    assert.strictEqual(buf.text.length, Math.min(CAP, 65536 * (i + 1)))
  }
  assert.strictEqual(buf.over, true)
  assert.strictEqual(M.flushLine(buf), piece + "a")
  assert.deepStrictEqual(buf, { text: "", over: false })
  // A "\n" ends the dropped part; what follows starts fresh.
  M.splitChunk(buf, piece + piece)
  assert.deepStrictEqual(M.splitChunk(buf, piece + "\nok"), [piece + "a"])
  assert.strictEqual(M.flushLine(buf), "ok")
})

test("lines: chunked output gives the same outcome as whole lines", () => {
  const runs = [
    [SUCCESS_RUN, 0, "mshybrid"],
    [["No authentication agent found."], 127, "discrete"],
    [[], 126, "discrete"],
    [[], -1, "discrete"],
    [SUCCESS_RUN.slice(0, 4), 9, "mshybrid"],
    [SUCCESS_RUN.slice(0, 4).concat([errLine("apply-ready is already set before any write; refusing")]), 1, "integrated"],
    [["noise", "", ev("unchanged", "same")], 0, "discrete"]
  ]
  for (const [lines, code, mode] of runs) {
    const whole = M.switchOutcome(fold(lines), code, mode, true)
    for (const n of [1, 3, 64, 65536]) {
      for (const end of ["\n", ""]) {
        const out = splitAll(chunks(lines.join("\n") + (lines.length ? end : ""), n))
        assert.deepStrictEqual(M.switchOutcome(fold(out), code, mode, true), whole, code + " in chunks of " + n + " end " + JSON.stringify(end))
      }
    }
  }
})

test("events: the refusal while a switch is staged is the plain sentence; other errors stay raw", () => {
  assert.strictEqual(M.STAGED_LOCK_TEXT, "A switch is staged. It can't be changed or cancelled until after a full shutdown.")
  // The real tool's refusal, after the events it prints before Get_AP.
  const refusal = SUCCESS_RUN.slice(0, 6).concat([errLine("apply-ready is already set before any write; refusing an ambiguous transition")])
  const o = M.switchOutcome(fold(refusal), 1, "integrated", true)
  assert.deepStrictEqual(o, { kind: "error", message: M.STAGED_LOCK_TEXT, warning: "", offerShutdown: false, lock: true })
  // The same refusal with nothing staged: a leftover firmware flag.
  assert.strictEqual(M.FIRMWARE_FLAG_TEXT, "The firmware still has a switch in progress. A full shutdown clears it.")
  for (const staged of [false, undefined, "yes"])
    assert.deepStrictEqual(M.switchOutcome(fold(refusal), 1, "integrated", staged),
      { kind: "error", message: M.FIRMWARE_FLAG_TEXT, warning: "", offerShutdown: false, lock: true }, String(staged))
  // Only that error: a neighbour stays raw.
  const other = M.switchOutcome(fold([errLine("apply-ready never asserted after the trigger")]), 1, "integrated")
  assert.strictEqual(other.message, "apply-ready never asserted after the trigger")
  assert.strictEqual(other.lock, undefined, "only the apply-ready refusal is a lock")
  // No "cancelled" kind is left.
  assert.ok(!/"cancelled"/.test(source))
  assert.strictEqual(M.switchOutcome.length, 4, "run, exit status, mode, staged; no isCancel parameter")
})

test("events: unchanged is a no-op", () => {
  const run = fold([SUCCESS_RUN[0], SUCCESS_RUN[1], ev("unchanged", "The machine is already in discrete mode. No state was changed.", { mode: "discrete", value: 1 })])
  const o = M.switchOutcome(run, 0, "discrete")
  assert.strictEqual(o.kind, "unchanged")
  assert.strictEqual(o.offerShutdown, false)
})

test("events: an error event is shown; exit 1", () => {
  const run = fold([SUCCESS_RUN[0], SUCCESS_RUN[1], SUCCESS_RUN[2], SUCCESS_RUN[3], errLine("AC power is required for a GPU mode transition")])
  const o = M.switchOutcome(run, 1, "mshybrid")
  assert.deepStrictEqual(o, { kind: "error", message: "AC power is required for a GPU mode transition", warning: "", offerShutdown: false })
})

test("events: cli_error (usage, exit 2) is shown", () => {
  const run = fold([JSON.stringify({ event: "cli_error", level: "error", message: "error: unexpected argument '--x'" })])
  const o = M.switchOutcome(run, 2, "discrete")
  assert.strictEqual(o.kind, "error")
  assert.strictEqual(o.message, "error: unexpected argument '--x'")
})

test("events: trigger_sent_before_failure is a prominent warning", () => {
  const run = fold(SUCCESS_RUN.slice(0, 10).concat([
    warn("trigger_sent_before_failure", "the EC apply trigger was sent before failure; save work and perform a manual full shutdown"),
    errLine("acknowledgement timed out")]))
  assert.strictEqual(run.triggerSent, true)
  const o = M.switchOutcome(run, 1, "mshybrid")
  assert.strictEqual(o.kind, "error")
  assert.strictEqual(o.message, "acknowledgement timed out")
  assert.strictEqual(o.warning, M.TRIGGER_WARNING)
  assert.ok(/save your work/i.test(o.warning) && /full shutdown/.test(o.warning))
  // Also kept when pkexec reports 126/127 afterwards (it cannot, but the
  // warning must never be dropped).
  assert.strictEqual(M.switchOutcome(run, 126, "mshybrid").warning, M.TRIGGER_WARNING)
})

test("events: other warnings are appended; non-JSON lines are ignored", () => {
  const run = fold(["Sourcing something", "", "   "].concat(SUCCESS_RUN.slice(0, 9), [
    warn("target_restored", "the previous target was restored"), errLine("trigger failed")]))
  assert.strictEqual(run.other, 1)
  const o = M.switchOutcome(run, 1, "mshybrid")
  assert.strictEqual(o.message, "trigger failed the previous target was restored")
  // Garbage around a full run changes nothing.
  const noisy = fold(["garbage", "{not json"].concat(SUCCESS_RUN, ["trailing text"]))
  assert.strictEqual(M.switchOutcome(noisy, 0, "mshybrid").kind, "success")
})

test("events: success needs both the success event and exit 0", () => {
  assert.strictEqual(M.switchOutcome(fold(SUCCESS_RUN), 1, "mshybrid").kind, "error")
  const noSuccess = M.switchOutcome(fold(SUCCESS_RUN.slice(0, -1)), 0, "mshybrid")
  assert.strictEqual(noSuccess.kind, "error")
  assert.strictEqual(noSuccess.message, "msi-mux-switch did not report success.")
  assert.strictEqual(M.switchOutcome(fold(SUCCESS_RUN.concat([errLine("late")])), 0, "mshybrid").kind, "error")
  assert.strictEqual(M.switchOutcome(M.newSwitchRun(), 0, "mshybrid").offerShutdown, false)
})

test("events: pkexec 126 is authentication cancelled, 127 not authorized", () => {
  let o = M.switchOutcome(M.newSwitchRun(), 126, "discrete")
  assert.strictEqual(o.kind, "auth-cancelled")
  assert.ok(/authentication cancelled/i.test(o.message))
  o = M.switchOutcome(M.newSwitchRun(), 127, "discrete")
  assert.strictEqual(o.kind, "not-authorized")
  assert.strictEqual(o.message, "Not authorized to switch the GPU mode. Nothing was changed.")
  // pkexec's own reason (its first non-JSON line) is shown with it.
  const run = fold(["Error executing command as another user: No authentication agent found.", "second line"])
  o = M.switchOutcome(run, 127, "discrete")
  assert.strictEqual(o.kind, "not-authorized")
  assert.strictEqual(o.message, "Not authorized to switch the GPU mode. Nothing was changed. pkexec said: Error executing command as another user: No authentication agent found.")
  o = M.switchOutcome(M.newSwitchRun(), -1, "discrete")
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

test("rows: while a switch is staged no row has a button, and none gives a reason", () => {
  for (const target of ["ms-hybrid", "integrated"]) {
    const d = M.parseDebug(withFirmware({ selected_target_mode: target }), "", 0)
    assert.strictEqual(d.pending, true)
    for (const over of [{}, { ac: false }, { ac: null }]) {
      const rows = M.modeRows(view(Object.assign({ debug: d }, over)))
      for (const r of rows) {
        assert.deepStrictEqual([r.action, r.enabled, r.reason], ["", false, ""], target + " " + JSON.stringify(over) + " " + r.mode)
      }
      assert.strictEqual(rowOf(rows, "discrete").status, "Current mode.")
      assert.strictEqual(rowOf(rows, M.modeFromJson(target)).status, "Staged: takes effect after a full shutdown.")
      const third = rows.find(r => r.mode !== "discrete" && r.mode !== M.modeFromJson(target))
      assert.strictEqual(third.status, "")
    }
  }
  assert.ok(!/"cancel"|Cancel pending/.test(source), "no cancel action kind left")
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
  // The staged target says so in its status, not as a reason; while staged,
  // AC is no reason either (nothing can run until a full shutdown).
  const d = M.parseDebug(withFirmware({ selected_target_mode: "ms-hybrid" }), "", 0)
  for (const r of M.modeRows(view({ debug: d, ac: false }))) assert.strictEqual(r.reason, "", r.mode)
})

test("rows: descriptions are one short line each", () => {
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
    const msg = M.confirmMessage(m, true)
    assert.ok(msg.startsWith("Switch to " + M.modeLabel(m) + "?") && msg.includes("takes effect after a full shutdown"), msg)
  }
  assert.ok(/external screens/.test(M.confirmMessage("integrated", true)))
  assert.ok(/external screens/.test(M.confirmMessage("integrated", undefined)))
  assert.ok(!/external screens/.test(M.confirmMessage("integrated", false)))
  assert.ok(!/external screens/.test(M.confirmMessage("discrete", true)))
  // No cancel and no replace wording: a staged switch can be neither.
  assert.strictEqual(M.confirmMessage.length, 2, "no isCancel or staged-target parameter")
  for (const m of M.MODES) assert.ok(!/cancel|replaces/i.test(M.confirmMessage(m, true)), m)
  // The backend's own reminder (recovery_key_warning): the recovery key, off this laptop.
  for (const m of M.MODES) for (const w of [true, false]) {
    const msg = M.confirmMessage(m, w)
    assert.ok(msg.includes("\n\n" + M.RECOVERY_KEY_TEXT), m + " " + w)
    assert.ok(/recovery key/.test(M.RECOVERY_KEY_TEXT) && /off this laptop/.test(M.RECOVERY_KEY_TEXT))
  }
  assert.strictEqual(M.warnSetting(undefined), true)
  assert.strictEqual(M.warnSetting(false), false)
  assert.ok(/Shut down now/.test(M.SHUTDOWN_MESSAGE) && /full shutdown/.test(M.SHUTDOWN_MESSAGE))
  // One dialog, two texts: a staged switch, or a leftover firmware flag.
  assert.strictEqual(M.shutdownMessage("staged"), M.SHUTDOWN_MESSAGE)
  assert.strictEqual(M.shutdownMessage(""), M.SHUTDOWN_MESSAGE)
  assert.strictEqual(M.shutdownMessage(undefined), M.SHUTDOWN_MESSAGE)
  const flag = M.shutdownMessage("flag")
  assert.strictEqual(flag, M.SHUTDOWN_FLAG_MESSAGE)
  for (const msg of [M.SHUTDOWN_MESSAGE, flag]) {
    assert.ok(/Shut down now/.test(msg) && /full shutdown/.test(msg) && /Save your work/.test(msg), msg)
    assert.ok(/A reboot (does not apply it|is not enough)/.test(msg), msg)
    assert.ok(msg.includes("The laptop may power itself back on afterwards; that's normal."), msg)
  }
  assert.ok(/firmware still has a switch in progress/.test(flag) && !/staged/.test(flag))
})

test("lock line: staged, leftover firmware flag, or nothing", () => {
  const staged = M.parseDebug(withFirmware({ selected_target_mode: "ms-hybrid" }), "", 0)
  const clean = M.parseDebug(CAPTURE, "", 0)
  assert.strictEqual(staged.pending, true)
  assert.strictEqual(clean.pending, false)
  const lockOut = { kind: "error", message: M.FIRMWARE_FLAG_TEXT, warning: "", offerShutdown: false, lock: true }
  const otherOut = { kind: "error", message: "x", warning: "", offerShutdown: false }
  const none = { kind: "", text: "", urgent: false }
  assert.deepStrictEqual(M.lockNotice({ debug: staged, outcome: null, busy: false }), { kind: "staged", text: M.STAGED_LOCK_TEXT, urgent: false })
  assert.deepStrictEqual(M.lockNotice({ debug: staged, outcome: lockOut, busy: false }), { kind: "staged", text: M.STAGED_LOCK_TEXT, urgent: true },
    "a refusal while staged: the line says it, once, in the error colour")
  assert.deepStrictEqual(M.lockNotice({ debug: staged, outcome: lockOut, busy: true }), { kind: "staged", text: M.STAGED_LOCK_TEXT, urgent: false })
  assert.deepStrictEqual(M.lockNotice({ debug: clean, outcome: lockOut, busy: false }), { kind: "flag", text: M.FIRMWARE_FLAG_TEXT, urgent: true },
    "nothing staged but the firmware refused: the leftover flag")
  assert.deepStrictEqual(M.lockNotice({ debug: clean, outcome: lockOut, busy: true }), none, "a new run hides the old refusal")
  assert.deepStrictEqual(M.lockNotice({ debug: clean, outcome: otherOut, busy: false }), none)
  assert.deepStrictEqual(M.lockNotice({ debug: clean, outcome: null, busy: false }), none)
  assert.deepStrictEqual(M.lockNotice(null), none)
  assert.deepStrictEqual(M.lockNotice({ debug: Object.assign({}, staged, { ok: false }), outcome: null }), none, "an unread state shows no line")
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
  assert.deepStrictEqual(M.cursorStops(rows, {}), ["mode|mshybrid", "mode|integrated", "env"])
  assert.deepStrictEqual(M.cursorStops(rows, { canSetUp: true }), ["setup", "mode|mshybrid", "mode|integrated", "env"])
  assert.deepStrictEqual(M.cursorStops(M.modeRows(view({ ac: false })), { canSetUp: true }), ["setup", "env"], "the env dropdown needs no AC")
  const pending = M.modeRows(view({ debug: M.parseDebug(withFirmware({ selected_target_mode: "ms-hybrid" }), "", 0) }))
  assert.deepStrictEqual(M.cursorStops(pending, {}), ["env"], "no mode stop while a switch is staged")
  assert.deepStrictEqual(M.cursorStops(pending, { canSetUp: true }), ["setup", "env"], "setup and env stay")
  assert.deepStrictEqual(M.cursorStops(null, null), ["env"], "the env dropdown is a stop in every mode")
  // Shut down now on the lock line sits between the modes and the dropdown.
  assert.deepStrictEqual(M.cursorStops(pending, { canSetUp: true, canShutDown: true }), ["setup", "shutdown", "env"])
  assert.deepStrictEqual(M.cursorStops(rows, { canShutDown: true }), ["mode|mshybrid", "mode|integrated", "shutdown", "env"],
    "a leftover firmware flag: Switch buttons and Shut down now")
  assert.deepStrictEqual(M.cursorStops(pending, { canShutDown: "yes" }), ["env"])
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
  assert.deepStrictEqual(M.cursorAction("shutdown"), { kind: "shutdown", arg: "" })
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
  // The previous build's temporary name is removed by a write too: rm -f,
  // never recursive, and its failure (a directory there) does not stop it.
  assert.ok(M.ENV_WRITE_SCRIPT.includes('rm -f -- "$1/90-msi-mux-gpu.new" 2>/dev/null\n'))
  assert.ok(!/rm -[a-z]*r|-r\b|-R\b/.test(M.ENV_WRITE_SCRIPT), "nothing recursive")
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
  const m = /For the \*\*RTX\*\* choice the file is exactly:\n\n```sh\n([\s\S]*?)\n```\n/.exec(rest)
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
  assert.deepStrictEqual(M.ENV_OPTIONS.map(o => o.label), ["Auto", "Intel", "RTX"])
  assert.strictEqual(M.showEnvChoice, undefined, "the dropdown is not gated on the mode")
  assert.strictEqual(M.LOGOUT_TEXT, "Log out to apply.")
})

test("env file: the status after a pick follows the MUX state", () => {
  assert.strictEqual(M.envStatusText({ current: "mshybrid", pending: false, target: "" }), "Log out to apply.")
  assert.strictEqual(M.envStatusText({ current: "mshybrid", pending: true, target: "discrete" }), "Log out to apply.")
  assert.strictEqual(M.envStatusText({ current: "discrete", pending: true, target: "mshybrid" }), "Applies after the shutdown into MSHybrid.")
  assert.strictEqual(M.envStatusText({ current: "integrated", pending: true, target: "mshybrid" }), "Applies after the shutdown into MSHybrid.")
  for (const d of [{ current: "discrete", pending: false, target: "" }, { current: "discrete", pending: true, target: "integrated" },
    { current: "integrated", pending: false, target: "" }, {}, null, undefined])
    assert.strictEqual(M.envStatusText(d), "Saved. Takes effect only in MSHybrid.", JSON.stringify(d))
  assert.ok(/text: MuxState\.envError !== "" \? MuxState\.envError : Model\.envStatusText\(MuxState\.debug\)/.test(read("BarWidget.qml")))
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
  // Raw chunks, cut into lines by the model; the tails flushed before the outcome.
  const proc = state.slice(state.indexOf("id: switchProc"))
  for (const [stream, buf] of [["stdout", "stdoutBuf"], ["stderr", "stderrBuf"]]) {
    const parser = proc.slice(proc.indexOf(stream + ": SplitParser {"))
    const block = parser.slice(0, parser.indexOf("\n    }\n"))
    assert.ok(/splitMarker: ""/.test(block), stream + " is read in raw chunks")
    assert.ok(block.indexOf("Model.splitChunk(switchProc." + buf + ", data)") !== -1, stream + " goes through Model.splitChunk")
    assert.ok(body.indexOf("switchProc." + buf + " = Model.newLineBuffer()") < body.indexOf("switchProc.running = true")
      && body.indexOf("switchProc." + buf + " = Model.newLineBuffer()") !== -1, stream + " buffer reset at start")
  }
  const exited = state.slice(state.indexOf("function switchExited()"))
  const exitBody = exited.slice(0, exited.indexOf("\n  }\n"))
  const flushOut = exitBody.indexOf("Model.flushLine(switchProc.stdoutBuf)")
  const flushErr = exitBody.indexOf("Model.flushLine(switchProc.stderrBuf)")
  assert.ok(exitBody.indexOf('root.phase !== "running"') < flushOut && flushOut < flushErr
    && flushErr < exitBody.indexOf("Model.switchOutcome"), "switchExited flushes stdout, then stderr, before the outcome")
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
  assert.strictEqual(timers.length, 3, "the start delay, the AC poll and the check watchdog only")
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
  assert.ok(/var next = root\.envQueued[\s\S]*root\.startEnv\(next\)/.test(done.slice(0, done.indexOf("\n  }\n"))))
  assert.strictEqual((state.match(/envProc\.running = true/g) || []).length, 1, "every env change starts in one place")
  // envError is cleared only by a choice that starts at once (after the
  // queue and "same as now" checks), never by a queued one started from
  // envDone; the live flow in tests/run.sh checks the behaviour.
  assert.ok(body.indexOf("value === root.envChoice") < body.indexOf('root.envError = ""'))
  assert.ok(body.indexOf('root.envError = ""') < body.indexOf("root.startEnv(value)"))
  const start = state.slice(state.indexOf("function startEnv("))
  assert.ok(!/envError/.test(start.slice(0, start.indexOf("\n  }\n"))), "startEnv leaves envError alone")
  assert.strictEqual((state.match(/root\.envError = ""/g) || []).length, 1, "cleared in setEnvChoice only")
  // After every read back, the dropdown follows the file on disk, even when
  // envChoice did not change (a failed pick does not stay shown).
  assert.ok(/root\.envChoice = Model\.parseEnvRead\(text\)\s*root\.envRead\(\)/.test(state))
  assert.ok(/function onEnvRead\(\) \{ root\.syncEnvDropdown\(\) \}/.test(qmlCode("BarWidget.qml")))
})

test("env choice: the dropdown is shown in every mode; staging a mode never touches the file", () => {
  const bar = qmlCode("BarWidget.qml")
  const at = bar.indexOf("id: envDropdown")
  const col = bar.lastIndexOf("Column {", at)
  assert.ok(col !== -1 && !/\bvisible:/.test(ownBody(bar, col + "Column ".length)), "the dropdown's Column has no visible: gate")
  assert.ok(!/showEnv/.test(bar))
  assert.ok(/takes effect only in MSHybrid, after you log out and back in; in Discrete or Integrated the file is inert/.test(read("BarWidget.qml")))
  const state = qmlCode("MuxState.qml")
  const exited = state.slice(state.indexOf("function switchExited()"))
  assert.ok(!/Env|env/.test(exited.slice(0, exited.indexOf("\n  }\n"))), "the switch's end leaves the env file alone")
  assert.ok(!/removeEnvFile/.test(state))
  // The file is removed only for Auto, through the one start.
  assert.strictEqual((state.match(/Model\.envRemoveArgv\(/g) || []).length, 1)
  assert.ok(/value === "auto" \? Model\.envRemoveArgv\(root\.home\)/.test(state))
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

test("panel: keyboard cursor, the staged lock line, per-row reasons, stale results cleared", () => {
  const bar = qmlCode("BarWidget.qml")
  assert.ok(/PanelKeyCatcher \{\s*id: keyCatcher/.test(bar))
  assert.ok(/focusTarget: root\.keyTarget === "inert" \? inertKeys : \(root\.keyTarget === "dialog" \? dialogKeys : keyCatcher\)/.test(bar))
  assert.ok(/Model\.cursorStops\(root\.rows, \{ canSetUp: MuxState\.canSetUp, canShutDown: root\.lockNotice\.kind !== "" \}\)/.test(bar))
  for (const k of ['"setup"', '"env"', '"shutdown"', "modeButton.key"])
    assert.ok(new RegExp("hasCursor: root\\.cursorActive && root\\.cursorAt === " + k.replace(/\./g, "\\.")).test(bar), k)
  // No cancel path: the confirmation is a plain Switch, and the staged lock
  // is one line under the modes, shown only while a switch is staged.
  assert.ok(!/confirmCancel|isCancel|switchCancel|Keep pending|Cancel switch/.test(bar + qmlCode("MuxState.qml")))
  assert.ok(/message: Model\.confirmMessage\(root\.confirmMode, root\.warnIntegrated\)/.test(bar))
  assert.ok(/MuxState\.requestSwitch\(root, mode\)/.test(bar))
  // Confirming re-checks the row: a mode no longer offered does not run.
  const confirm = bar.slice(bar.indexOf("function confirmSwitch()"))
  const confirmBody = confirm.slice(0, confirm.indexOf("\n  }\n"))
  assert.ok(/if \(!row \|\| row\.action !== "switch" \|\| !row\.enabled\) return/.test(confirmBody))
  assert.ok(confirmBody.indexOf("root.rows.find(") < confirmBody.indexOf("MuxState.requestSwitch("))
  assert.ok(/readonly property var lockNotice: Model\.lockNotice\(\{ debug: MuxState\.debug, outcome: MuxState\.outcome, busy: MuxState\.busy \}\)/.test(bar))
  const lock = bar.indexOf("text: root.lockNotice.text")
  assert.ok(lock > bar.indexOf("model: root.rows"), "the lock line follows the mode rows")
  const lockRow = bar.slice(bar.lastIndexOf("RowLayout {", lock), bar.indexOf("onClicked:", lock) + 80)
  assert.ok(/visible: root\.lockNotice\.kind !== ""/.test(lockRow))
  assert.ok(/color: root\.lockNotice\.urgent \? root\.urgent : root\.dim/.test(lockRow))
  // Shut down now on it: the one shutdown dialog, never the command itself.
  assert.ok(/text: "Shut down now"/.test(lockRow) && /onClicked: root\.offerShutdown\(root\.lockNotice\.kind\)/.test(lockRow))
  assert.ok(!/execDetached/.test(lockRow))
  assert.ok(/else if \(a\.kind === "shutdown"\) root\.offerShutdown\(root\.lockNotice\.kind\)/.test(bar), "the cursor opens the same dialog")
  assert.ok(/message: Model\.shutdownMessage\(root\.shutdownKind\)/.test(bar))
  assert.ok(/if \(Model\.offerShutdownAfterSwitch\(outcome, reopened\)\) root\.offerShutdown\("staged"\)/.test(bar))
  assert.strictEqual((bar.match(/ConfirmDialog \{/g) || []).length, 2, "the switch and the shutdown dialogs only")
  assert.strictEqual((bar.match(/Quickshell\.execDetached\(Model\.SHUTDOWN_ARGV\)/g) || []).length, 1, "one shutdown path")
  // The refusal is said once: on the lock line, not repeated as the result.
  assert.ok(/visible: MuxState\.busy \|\| !\(MuxState\.outcome && MuxState\.outcome\.lock === true\)/.test(bar))
  assert.ok(/text: modeRow\.row \? modeRow\.row\.reason : ""/.test(bar))
  assert.ok(!/root\.blocker/.test(bar), "no separate blocker line repeating AC or busy")
  assert.ok(/if \(root\.reopenForOutcome\) root\.reopenForOutcome = false\s*else if \(!MuxState\.busy\) MuxState\.clearOutcome\(\)/.test(bar))
  assert.ok(/root\.reopenForOutcome = true\s*root\.open\(\)/.test(bar))
  assert.ok(!/value: "auto"/.test(bar), "the dropdown's value comes from syncEnvDropdown only")
  // The unavailable reason is information, not an error colour.
  const i = bar.indexOf("text: MuxState.unavailableReason")
  assert.ok(/color: root\.foreground/.test(bar.slice(i, i + 200)))
})

// Qt::Key values (qnamespace.h); the live flow in tests/run.sh checks
// Model.KEY against the engine's own Qt.Key_* too.
const QT_KEY = { Escape: 0x01000000, Tab: 0x01000001, Backtab: 0x01000002, Return: 0x01000004, Enter: 0x01000005,
  Left: 0x01000012, Right: 0x01000014, Up: 0x01000013, Down: 0x01000015, Space: 0x20, Delete: 0x01000007, Backspace: 0x01000003 }

test("dialog keys: only ConfirmDialog's set acts; letters, h/l/j/k and Space do nothing", () => {
  assert.deepStrictEqual(M.KEY, { Escape: QT_KEY.Escape, Tab: QT_KEY.Tab, Backtab: QT_KEY.Backtab, Return: QT_KEY.Return,
    Enter: QT_KEY.Enter, Left: QT_KEY.Left, Right: QT_KEY.Right })
  assert.strictEqual(M.dialogKeyAction(QT_KEY.Escape), "close")
  for (const k of ["Left", "Right", "Tab", "Backtab"]) assert.strictEqual(M.dialogKeyAction(QT_KEY[k]), "toggle", k)
  for (const k of ["Return", "Enter"]) assert.strictEqual(M.dialogKeyAction(QT_KEY[k]), "activate", k)
  // Text keys: Qt::Key for a letter is its upper-case code point.
  const text = "hello world, the quick brown fox jumps over the lazy dog 0123456789 ;'[]-=/"
  for (const ch of text) assert.strictEqual(M.dialogKeyAction(ch.toUpperCase().codePointAt(0)), "", JSON.stringify(ch))
  for (const k of ["Space", "Up", "Down", "Delete", "Backspace"]) assert.strictEqual(M.dialogKeyAction(QT_KEY[k]), "", k)
  for (const v of [undefined, null, "", "h", "l", " ", "Return", 0, NaN]) assert.strictEqual(M.dialogKeyAction(v), "", String(v))
})

test("dialog keys: the widget routes every key of an open dialog through dialogKeyAction, by key code only", () => {
  const bar = qmlCode("BarWidget.qml")
  const fn = bar.slice(bar.indexOf("function dialogKeyPressed(event)"))
  const body = fn.slice(0, fn.indexOf("\n  }\n"))
  assert.ok(/event\.accepted = true/.test(body), "every key is swallowed")
  assert.ok(/root\.dialogKey\(d, Model\.dialogKeyAction\(event\.key\)\)/.test(body))
  assert.ok(!/event\.text/.test(body), "the key's text is never read")
  // dialogKey is reached from there and nowhere else.
  assert.strictEqual((bar.match(/root\.dialogKey\(/g) || []).length, 1)
  // The catcher is blocked while a dialog is open and has no dialog branch.
  const at = bar.indexOf("PanelKeyCatcher {")
  const catcher = ownBody(bar, at + "PanelKeyCatcher ".length)
  assert.ok(/blocked: envDropdown\.popupOpen \|\| root\.dialogOpen \|\| root\.keysInert/.test(catcher))
  assert.ok(!/openDialog|dialogKey|selectedIndex|confirmed|canceled/.test(catcher), "no dialog key in the catcher")
  // dialogKeys takes the keys, and the focus follows the dialogs.
  assert.ok(/id: dialogKeys\s*Keys\.priority: Keys\.BeforeItem\s*Keys\.onPressed: function\(event\) \{ root\.dialogKeyPressed\(event\) \}/.test(bar))
  assert.ok(/onKeyTargetChanged: if \(root\.opened\) root\.keyTargetItem\(\)\.forceActiveFocus\(\)/.test(bar))
  assert.ok(/return root\.keyTarget === "inert" \? inertKeys : \(root\.keyTarget === "dialog" \? dialogKeys : keyCatcher\)/.test(bar))
  assert.ok(/focusTarget: root\.keyTarget === "inert" \? inertKeys : \(root\.keyTarget === "dialog" \? dialogKeys : keyCatcher\)/.test(bar))
  assert.ok(/readonly property bool dialogOpen: confirmDialog\.opened \|\| shutdownDialog\.opened/.test(bar))
  // A dialog opening closes the dropdown's list, which would block the
  // catcher after the dialog.
  assert.ok(/onDialogOpenChanged: if \(root\.dialogOpen\) envDropdown\.close\(\)/.test(bar))
  assert.strictEqual((bar.match(/forceActiveFocus\(\)/g) || []).length, 2, "the focus is only ever moved to keyTargetItem()")
  // ConfirmDialog's own handleKey is not used (it is the same set, but the
  // widget's filter is the tested one).
  assert.ok(!/handleKey/.test(bar))
})

test("reopened panel: key-inert after reopening itself, until the pointer, a user opening or closing", () => {
  assert.strictEqual(M.keysInert(false, "selfOpen"), true)
  assert.strictEqual(M.keysInert(true, "selfOpen"), true)
  for (const what of ["userOpen", "pointer", "close"])
    for (const before of [true, false]) assert.strictEqual(M.keysInert(before, what), false, what)
  for (const what of [undefined, null, "", "key", "Space", "Return", "tab", "hover", "SelfOpen"]) {
    assert.strictEqual(M.keysInert(true, what), true, String(what))
    assert.strictEqual(M.keysInert(false, what), false, String(what))
  }
  for (const before of [undefined, null, 1, "true"]) assert.strictEqual(M.keysInert(before, "key"), false, String(before))
  // Only Esc does anything, and it closes.
  assert.strictEqual(M.inertKeyAction(QT_KEY.Escape), "close")
  for (const k of ["Space", "Return", "Enter", "Tab", "Backtab", "Left", "Right", "Up", "Down", "Delete", "Backspace"])
    assert.strictEqual(M.inertKeyAction(QT_KEY[k]), "", k)
  for (const ch of "git status git log hjkl x") assert.strictEqual(M.inertKeyAction(ch.toUpperCase().codePointAt(0)), "", JSON.stringify(ch))
  for (const v of [undefined, null, "", "Escape", 0, NaN]) assert.strictEqual(M.inertKeyAction(v), "", String(v))
  // The focus: inertKeys while inert (even with a dialog open), then the
  // dialog's, then the catcher.
  assert.strictEqual(M.keyTarget({ inert: true, dialogOpen: false }), "inert")
  assert.strictEqual(M.keyTarget({ inert: true, dialogOpen: true }), "inert")
  assert.strictEqual(M.keyTarget({ inert: false, dialogOpen: true }), "dialog")
  assert.strictEqual(M.keyTarget({ inert: false, dialogOpen: false }), "panel")
  for (const s of [undefined, null, {}, { inert: 1 }, { inert: "true" }]) assert.strictEqual(M.keyTarget(s), "panel", JSON.stringify(s))
})

test("reopened panel: only a real pointer move wakes it, never the first sample or jitter", () => {
  assert.strictEqual(M.POINTER_MOVE_PX, 2)
  let r = M.pointerMove(null, 100, 50)
  assert.deepStrictEqual(r, { sample: { x: 100, y: 50 }, moved: false }, "the first position is a sample")
  // Repeats and jitter within the threshold, against the first sample.
  for (const [x, y] of [[100, 50], [101, 50], [102, 52], [98, 48], [100.5, 49.5]]) {
    r = M.pointerMove({ x: 100, y: 50 }, x, y)
    assert.deepStrictEqual(r, { sample: { x: 100, y: 50 }, moved: false }, JSON.stringify([x, y]))
  }
  for (const [x, y] of [[103, 50], [97, 50], [100, 53], [100, 47], [140, 90]])
    assert.strictEqual(M.pointerMove({ x: 100, y: 50 }, x, y).moved, true, JSON.stringify([x, y]))
  // Slow jitter accumulates against the first sample: it is kept, not moved.
  let s = M.pointerMove(null, 0, 0).sample
  let woke = false
  for (let x = 0.5; x <= 4 && !woke; x += 0.5) { r = M.pointerMove(s, x, 0); s = r.sample; woke = r.moved }
  assert.ok(woke, "small steps add up to a move")
  for (const [x, y] of [[NaN, 1], [1, undefined], ["a", 1], [Infinity, 0]]) {
    assert.deepStrictEqual(M.pointerMove(null, x, y), { sample: null, moved: false }, String([x, y]))
    assert.deepStrictEqual(M.pointerMove({ x: 0, y: 0 }, x, y), { sample: { x: 0, y: 0 }, moved: false }, String([x, y]))
  }
})

test("reopened panel: the widget wires the gate thinly, from opening to keys, cursor and pointer", () => {
  const bar = qmlCode("BarWidget.qml")
  const opened = bar.slice(bar.indexOf("onOpenedChanged: {"))
  const openedBody = opened.slice(0, opened.indexOf("\n  }\n"))
  // The state is decided before reopenForOutcome is reset.
  assert.ok(/if \(root\.opened\) \{\s*root\.wakeKeys\(root\.reopenForOutcome \? "selfOpen" : "userOpen"\)\s*root\.pointerSample = null\s*root\.cursorActive = false/.test(openedBody))
  assert.ok(openedBody.indexOf("root.wakeKeys(root.reopenForOutcome") < openedBody.indexOf("root.reopenForOutcome = false"))
  assert.ok(/return\s*\}\s*root\.wakeKeys\("close"\)/.test(openedBody), "closing ends it")
  assert.ok(/root\.keysInert = Model\.keysInert\(root\.keysInert, what\)/.test(bar))
  assert.strictEqual((bar.match(/root\.keysInert = /g) || []).length, 1, "keysInert is set in wakeKeys only")
  assert.ok(/readonly property string keyTarget: Model\.keyTarget\(\{ inert: root\.keysInert, dialogOpen: root\.dialogOpen \}\)/.test(bar))
  // inertKeys swallows every key; only Esc, through the model, closes.
  const fn = bar.slice(bar.indexOf("function inertKeyPressed(event)"))
  const body = fn.slice(0, fn.indexOf("\n  }\n"))
  assert.ok(/event\.accepted = true\s*if \(Model\.inertKeyAction\(event\.key\) === "close"\) root\.close\(\)/.test(body))
  assert.ok(!/event\.text/.test(body))
  assert.ok(/id: inertKeys\s*Keys\.priority: Keys\.BeforeItem\s*Keys\.onPressed: function\(event\) \{ root\.inertKeyPressed\(event\) \}/.test(bar))
  // The catcher's own handlers check it too, and so does the cursor.
  const at = bar.indexOf("PanelKeyCatcher {")
  const catcher = bar.slice(at, bar.indexOf("id: dialogKeys", at))
  assert.ok(/onMoveRequested: function\(dx, dy\) \{\s*if \(root\.keysInert\) return/.test(catcher))
  assert.ok(/onActivateRequested: \{\s*if \(root\.keysInert\) return/.test(catcher))
  assert.ok(/onTabRequested: function\(direction\) \{ if \(!root\.keysInert\) root\.switchPanel\(direction\) \}/.test(catcher))
  assert.ok(/function pointAt\(key\) \{\s*if \(root\.keysInert\) return/.test(bar))
  // The pointer: moves in window coordinates through inertPointer, gated on
  // the panel's focus prime, and a press through inertPress.
  assert.ok(/onPointChanged: if \(panelHover\.hovered\) root\.pointerAt\(panelHover\.point\.scenePosition\.x, panelHover\.point\.scenePosition\.y\)/.test(bar),
    "a point while the pointer is not over the panel is no sample")
  const ptr = bar.slice(bar.indexOf("function pointerAt(x, y)"))
  assert.ok(/if \(!root\.keysInert\) return\s*var m = Model\.inertPointer\(root\.pointerSample, x, y, panel\.focusPrimed\)\s*root\.pointerSample = m\.sample\s*if \(m\.moved\) root\.wakeKeys\("pointer"\)/.test(ptr.slice(0, ptr.indexOf("\n  }\n"))))
  assert.ok(!/Model\.pointerMove\(root\.pointerSample/.test(bar), "the inert sample never bypasses the focus prime")
  assert.ok(/enabled: root\.keysInert\s*acceptedButtons: Qt\.AllButtons\s*onPressed: function\(mouse\) \{ root\.inertPressed\(mouse\) \}/.test(bar))
  const press = bar.slice(bar.indexOf("function inertPressed(mouse)"))
  assert.ok(/if \(Model\.inertPress\(panel\.focusPrimed\) === "wake"\) \{\s*root\.wakeKeys\("pointer"\)\s*mouse\.accepted = false\s*\} else mouse\.accepted = true/.test(press.slice(0, press.indexOf("\n  }\n"))))
  // The panel's focus prime is the shell's own property.
  assert.ok(/property bool focusPrimed: false/.test(fs.readFileSync("/usr/share/omarchy/shell/Ui/KeyboardPanel.qml", "utf8")) ||
    !fs.existsSync("/usr/share/omarchy/shell/Ui/KeyboardPanel.qml"))
})

test("reopened panel: nothing during the focus prime wakes it or becomes the sample", () => {
  // Before the prime: dropped, whatever the sample and however far.
  for (const primed of [false, undefined, null, 1, "true"]) {
    assert.deepStrictEqual(M.inertPointer(null, 100, 50, primed), { sample: null, moved: false }, String(primed))
    assert.deepStrictEqual(M.inertPointer({ x: 0, y: 0 }, 500, 500, primed), { sample: null, moved: false }, String(primed))
    assert.strictEqual(M.inertPress(primed), "swallow", String(primed))
  }
  assert.strictEqual(M.inertPress(true), "wake")
  // After it: exactly pointerMove, the first position after the prime being
  // the sample.
  let r = M.inertPointer(M.inertPointer(null, 10, 10, false).sample, 200, 100, true)
  assert.deepStrictEqual(r, { sample: { x: 200, y: 100 }, moved: false }, "the first primed position is the sample")
  assert.deepStrictEqual(M.inertPointer(r.sample, 201.5, 98.5, true), { sample: { x: 200, y: 100 }, moved: false })
  assert.deepStrictEqual(M.inertPointer(r.sample, 210, 100, true), { sample: { x: 200, y: 100 }, moved: true })
  assert.deepStrictEqual(M.inertPointer(r.sample, NaN, 1, true), { sample: { x: 200, y: 100 }, moved: false })
})

test("dialogs: a hover never selects the confirm button, only the dialog's keys do", () => {
  assert.strictEqual(M.DIALOG_SAFE_INDEX, 0)
  // The safe button is always kept.
  for (const o of [undefined, null, {}, { keyed: true }, { keyed: false }, { pointerMoved: true }])
    assert.strictEqual(M.dialogSelection(0, o), 0, JSON.stringify(o))
  // The confirm button: only from the keys. A hover is never keyed, whether
  // or not the pointer moved (a layout change can slide the button under a
  // resting pointer at any time).
  assert.strictEqual(M.dialogSelection(1, { keyed: true }), 1)
  for (const o of [undefined, null, {}, { keyed: false }, { keyed: 1 }, { keyed: "true" }, { pointerMoved: true }, { keyed: false, pointerMoved: true }])
    assert.strictEqual(M.dialogSelection(1, o), 0, JSON.stringify(o))
  // Anything that is not one of the two buttons is the safe one.
  for (const i of [-1, 2, undefined, null, "1", NaN]) assert.strictEqual(M.dialogSelection(i, { keyed: true }), 0, String(i))
})

test("dialogs: the widget passes every selection change through dialogSelection", () => {
  const bar = qmlCode("BarWidget.qml")
  for (const id of ["confirmDialog", "shutdownDialog"]) {
    assert.ok(new RegExp("onOpenedChanged: if \\(" + id + "\\.opened\\) root\\.dialogOpened\\(" + id + "\\)").test(bar), id)
    assert.ok(new RegExp("onSelectedIndexChanged: root\\.keepDialogSelection\\(" + id + "\\)").test(bar), id)
  }
  const opened = bar.slice(bar.indexOf("function dialogOpened(dialog)"))
  assert.ok(/\{\s*dialog\.selectedIndex = Model\.DIALOG_SAFE_INDEX\s*\}/.test(opened.slice(0, opened.indexOf("\n  }\n") + 4)))
  const keep = bar.slice(bar.indexOf("function keepDialogSelection(dialog)"))
  assert.ok(/var keep = Model\.dialogSelection\(dialog\.selectedIndex, \{ keyed: root\.dialogKeyed \}\)\s*if \(keep !== dialog\.selectedIndex\) dialog\.selectedIndex = keep/.test(keep.slice(0, keep.indexOf("\n  }\n"))))
  // keyed is set only around the dialog keys' toggle.
  const key = bar.slice(bar.indexOf("function dialogKey(dialog, what)"))
  assert.ok(/if \(what === "toggle"\) \{\s*root\.dialogKeyed = true\s*dialog\.selectedIndex = dialog\.selectedIndex === 0 \? 1 : 0\s*root\.dialogKeyed = false\s*\}/.test(key.slice(0, key.indexOf("\n  }\n"))))
  assert.strictEqual((bar.match(/root\.dialogKeyed = true/g) || []).length, 1)
  // No pointer state gates the dialog's selection any more.
  assert.ok(!/dialogPointer/.test(bar), "no pointer-moved path for the dialogs")
  assert.ok(!/pointerMoved/.test(bar))
})

test("panel: closing it closes the dropdown's list", () => {
  const bar = qmlCode("BarWidget.qml")
  const opened = bar.slice(bar.indexOf("onOpenedChanged: {"))
  const body = opened.slice(0, opened.indexOf("\n  }\n"))
  assert.ok(/return\s*\}\s*root\.wakeKeys\("close"\)\s*envDropdown\.close\(\)/.test(body))
})

test("dialogs: each opens on its safe button (Cancel, Later), every time", () => {
  const bar = qmlCode("BarWidget.qml")
  assert.ok(/onOpenedChanged: if \(confirmDialog\.opened\) root\.dialogOpened\(confirmDialog\)/.test(bar))
  assert.ok(/onOpenedChanged: if \(shutdownDialog\.opened\) root\.dialogOpened\(shutdownDialog\)/.test(bar))
  // Index 0 is the cancel button in the shell's ConfirmDialog (handleKey:
  // Enter on 0 is canceled()).
  assert.ok(/cancelText: "Later"/.test(bar) && /cancelText: "Cancel"/.test(bar))
  const offer = bar.slice(bar.indexOf("function offerShutdown(kind)"))
  assert.ok(/shutdownDialog\.selectedIndex = 0/.test(offer.slice(0, offer.indexOf("\n  }\n"))))
  const ask = bar.slice(bar.indexOf("function askSwitch(row)"))
  assert.ok(/confirmDialog\.selectedIndex = 0/.test(ask.slice(0, ask.indexOf("\n  }\n"))))
})

test("shutdown offer: never opened by itself when the panel reopened to show the result", () => {
  const staged = { kind: "success", message: "x", warning: "", offerShutdown: true }
  assert.strictEqual(M.offerShutdownAfterSwitch(staged, true), false)
  assert.strictEqual(M.offerShutdownAfterSwitch(staged, false), true)
  for (const o of [null, undefined, {}, { offerShutdown: false }, { offerShutdown: "true" }, { offerShutdown: 1 }])
    for (const r of [true, false]) assert.strictEqual(M.offerShutdownAfterSwitch(o, r), false, JSON.stringify([o, r]))
  for (const r of [undefined, null, 0, "", "yes"]) assert.strictEqual(M.offerShutdownAfterSwitch(staged, r), true, String(r))
  const bar = qmlCode("BarWidget.qml")
  const fin = bar.slice(bar.indexOf("function onSwitchFinished(owner, outcome)"))
  const body = fin.slice(0, fin.indexOf("\n    }\n"))
  assert.ok(/var reopened = !root\.opened\s*if \(reopened\) \{\s*root\.reopenForOutcome = true\s*root\.open\(\)\s*\}/.test(body))
  assert.ok(/if \(Model\.offerShutdownAfterSwitch\(outcome, reopened\)\) root\.offerShutdown\("staged"\)/.test(body))
  assert.ok(!/shutdownOffered/.test(body), "onSwitchFinished never sets shutdownOffered itself")
  assert.strictEqual((body.match(/offerShutdown\(/g) || []).length, 1, "one offer, behind offerShutdownAfterSwitch")
  // The shutdown dialog opens only through offerShutdown.
  assert.strictEqual((bar.match(/root\.shutdownOffered = true/g) || []).length, 1)
  const offer = bar.slice(bar.indexOf("function offerShutdown(kind)"))
  assert.ok(/root\.shutdownOffered = true/.test(offer.slice(0, offer.indexOf("\n  }\n"))))
})

test("switch checks: a switch asked for while stopped checks are ending says why", () => {
  assert.strictEqual(M.checksEndingProblem(true), M.CHECKS_ENDING_TEXT)
  assert.ok(/Nothing was run\.$/.test(M.CHECKS_ENDING_TEXT))
  assert.ok(/still ending/.test(M.CHECKS_ENDING_TEXT) && /Try again/.test(M.CHECKS_ENDING_TEXT))
  for (const v of [false, undefined, null, 1, "true"]) assert.strictEqual(M.checksEndingProblem(v), "", String(v))
})

test("switch checks: a watchdog refuses a switch still being checked after CHECK_TIMEOUT_MS", () => {
  assert.strictEqual(M.CHECK_TIMEOUT_MS, 15000)
  assert.ok(M.CHECK_TIMEOUT_MS > (M.DEBUG_TIMEOUT_S + M.DEBUG_KILL_AFTER_S) * 1000 + 2000, "longer than a debug read can last")
  const state = qmlCode("MuxState.qml")
  const at = state.indexOf("id: checkWatchdog")
  const timer = state.slice(state.lastIndexOf("Timer {", at), state.indexOf("\n  }\n", at))
  assert.ok(/interval: Model\.CHECK_TIMEOUT_MS\s*repeat: false/.test(timer))
  assert.ok(/if \(root\.phase !== "checking"\) return/.test(timer))
  // Refused before the checks are stopped: one ending as it stops finds the
  // phase over.
  assert.ok(/root\.refused\(Model\.CHECK_TIMEOUT_TEXT\)\s*checkStat\.running = false\s*checkAc\.running = false\s*checkRunning\.running = false/.test(timer))
  const req = state.slice(state.indexOf("function requestSwitch("))
  const reqBody = req.slice(0, req.indexOf("\n  }\n"))
  assert.ok(/checkWatchdog\.restart\(\)\s*return true/.test(reqBody), "armed with every request")
  // A request while stopped checks are still ending is refused with a
  // reason (finish, so the panel shows it), never dropped in silence.
  assert.ok(/var ending = Model\.checksEndingProblem\(checkStat\.running \|\| checkAc\.running \|\| checkRunning\.running\)\s*if \(ending !== ""\) \{\s*root\.switchOwner = owner\s*root\.refused\(ending\)\s*return false\s*\}/.test(reqBody))
  assert.ok(reqBody.indexOf("checksEndingProblem") < reqBody.indexOf("root.phase = \"checking\""), "before anything starts")
  const fin = state.slice(state.indexOf("function finish(outcome)"))
  assert.ok(/checkWatchdog\.stop\(\)/.test(fin.slice(0, fin.indexOf("\n  }\n"))))
  const start = state.slice(state.indexOf("function startSwitch()"))
  const startBody = start.slice(0, start.indexOf("\n  }\n"))
  assert.ok(startBody.indexOf("checkWatchdog.stop()") !== -1 && startBody.indexOf("checkWatchdog.stop()") < startBody.indexOf('root.phase = "running"'))
  // finish() clears the pgrep wait, so a debug read ending later starts no pgrep.
  assert.ok(/root\.pgrepWaiting = false/.test(fin.slice(0, fin.indexOf("\n  }\n"))))
})

test("debug read: parsed through parseDebugRead; one run's end is never taken for the next one's", () => {
  const state = qmlCode("MuxState.qml")
  assert.ok(/root\.debug = Model\.parseDebugRead\(debugProc\.out, debugProc\.err, debugProc\.exitCode\)/.test(state))
  assert.ok(!/Model\.parseDebug\(/.test(state))
  assert.ok(/debugProc\.run = \+\+root\.debugRuns/.test(state))
  assert.ok(/var run = debugProc\.run\s*Qt\.callLater\(function\(\) \{\s*if \(debugProc\.run !== run \|\| debugProc\.running\) return\s*debugProc\.exited = true/.test(state))
})

test("debug read: only through the ownership gate, on the stat taken right before it", () => {
  const state = qmlCode("MuxState.qml")
  for (const file of qmlFiles) {
    assert.ok(!/Model\.debugArgv\(|Model\.debugCommand\(|Model\.binaryPresent\(/.test(qmlCode(file)), file + " builds an ungated debug read")
  }
  const fn = state.slice(state.indexOf("function readDebug(stats)"))
  const body = fn.slice(0, fn.indexOf("\n  }\n"))
  assert.ok(body.length > 0 && fn.length > 0, "readDebug(stats)")
  assert.ok(/var argv = Model\.debugReadArgv\(root\.binaryPath, stats, root\.hardware\.flags\)\s*if \(argv\.length === 0\) \{\s*root\.debug = Model\.emptyDebug\(\)\s*return\s*\}/.test(body),
    "gated first; a refused binary leaves no earlier read's state")
  assert.ok(body.indexOf("Model.debugReadArgv") < body.indexOf("debugProc.running = true"))
  assert.ok(body.indexOf("Model.debugReadArgv") < body.indexOf("root.debugAgain = true"), "a read waits only once it passed")
  assert.ok(/if \(debugProc\.running \|\| root\.phase === "checking"\) \{ root\.debugAgain = true; return \}/.test(body), "never while a switch is checked")
  assert.strictEqual((state.match(/debugProc\.running = true/g) || []).length, 1, "the debug read starts in one place")
  // Called from one place: the end of the stat, with that stat's result.
  assert.strictEqual((state.match(/root\.readDebug\(/g) || []).length, 1, "readDebug has one caller")
  assert.ok(/root\.stats = Model\.parseStat\(text\)\s*root\.statRead = true\s*root\.readDebug\(root\.stats\)/.test(state))
  // Every read asked for again goes through a new stat.
  assert.ok(/root\.debugAgain = false\s*root\.checkBinary\(\)\s*\}\)/.test(state), "after a read ends")
  const fin = state.slice(state.indexOf("function finish(outcome)"))
  assert.ok(/if \(root\.debugAgain && !debugProc\.running\) \{\s*root\.debugAgain = false\s*root\.checkBinary\(\)/.test(fin.slice(0, fin.indexOf("\n  }\n"))), "after a switch")
  const exited = state.slice(state.indexOf("function switchExited()"))
  assert.ok(/root\.debugAgain = true\s*root\.finish\(outcome\)\s*\}/.test(exited.slice(0, exited.indexOf("\n  }\n") + 4)), "a switch's end reads again through finish")
  // A read that ends after the gate failed is dropped, and so is the earlier one.
  const fd = state.slice(state.indexOf("function finishDebug()"))
  const fdBody = fd.slice(0, fd.indexOf("\n  }\n"))
  const drop = "if (!root.ownership.ok) { root.debug = Model.emptyDebug(); return }"
  assert.ok(fdBody.indexOf(drop) !== -1 && fdBody.indexOf(drop) < fdBody.indexOf("root.debug = Model.parseDebugRead"))
  // The switch's own stat refusing the binary drops the earlier read too.
  const ss = state.slice(state.indexOf("function startSwitch()"))
  const ssBody = ss.slice(0, ss.indexOf("\n  }\n"))
  assert.ok(/root\.stats = checkStat\.result\s*var verdict = Model\.ownershipVerdict\(root\.binaryPath, checkStat\.result\)\s*if \(!verdict\.ok\) \{\s*root\.debug = Model\.emptyDebug\(\)\s*return root\.refused\(/.test(ssBody),
    "a refused pre-switch stat clears the debug read")
  assert.ok(!/\bpresent\b/.test(state), "no ungated presence flag")
  const bar = qmlCode("BarWidget.qml")
  assert.ok(/meta: Model\.summary\(MuxState\.debug, MuxState\.debugBlocked\)/.test(bar))
  assert.ok(/readonly property bool debugBlocked: root\.hardware\.state === "unavailable" \|\| \(root\.statRead && !root\.ownership\.ok\)/.test(state))
})

// ---------------------------------------------------- manifest and layout

test("manifest: identity, version and the settings schema", () => {
  const m = JSON.parse(read("manifest.json"))
  assert.strictEqual(m.schemaVersion, 1)
  assert.strictEqual(m.id, "io.github.rsd.msi-mux")
  assert.strictEqual(m.id, M.PLUGIN_ID)
  assert.strictEqual(m.name, "MSI GPU MUX")
  assert.strictEqual(m.version, "0.2.8")
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
  // The widget's hardcoded ids are the manifest's.
  assert.strictEqual(/moduleName: "([^"]*)"/.exec(bar)[1], m.id)
  assert.strictEqual(/ipcTarget: "([^"]*)"/.exec(bar)[1], m.id)
  assert.ok(/root\.setting\("binaryPath", ""\)/.test(bar) && /root\.setting\("warnBeforeIntegrated", true\)/.test(bar))
})

// The files the plugin ships, listed one by one (tests/ included).
const SHIPPED = ["BarWidget.qml", "LICENSE", "Model.js", "MuxState.qml", "README.md", "manifest.json", "preview.png",
  "qmldir", "setup.sh", "tests/debug-read-test.sh", "tests/debug-read-text.js", "tests/env-file-test.sh",
  "tests/env-file-text.js", "tests/fixtures/debug-discrete.json", "tests/fixtures/fake-msi-mux-switch",
  "tests/fixtures/fake-msi-mux-switch-flood", "tests/fixtures/fake-msi-mux-switch-hang", "tests/model-test.js", "tests/qmllint-check.js", "tests/run.sh", "tests/setup-test.sh"]

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
