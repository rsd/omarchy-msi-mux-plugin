#!/usr/bin/env node

// For tests/debug-read-test.sh. Model.js is a QML JS module (no exports), so it
// is evaluated and the functions lifted out, as tests/model-test.js does.
//
//   debug-read-text.js --argv <path> [flags...]
//                        prints Model.debugArgv(<path>, [flags...])
//   debug-read-text.js --parse <stdout file> <stderr file> <exit status>
//                        prints Model.parseDebugRead(...) as one JSON line
//   debug-read-text.js --constants
//                        prints DEBUG_MAX_BYTES, DEBUG_TIMEOUT_S and
//                        DEBUG_KILL_AFTER_S, one per line
//
// An argv is printed NUL-terminated, one argument after another.

const fs = require("fs")
const path = require("path")

const source = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
const M = new Function(source + "\nreturn { debugArgv, parseDebugRead, DEBUG_MAX_BYTES, DEBUG_TIMEOUT_S, DEBUG_KILL_AFTER_S }")()
const [mode, ...rest] = process.argv.slice(2)

if (mode === "--argv") {
  const argv = M.debugArgv(rest[0], rest.slice(1))
  if (argv.length === 0) {
    console.error("debug-read-text.js: no argv for " + JSON.stringify(rest))
    process.exit(2)
  }
  process.stdout.write(argv.map(x => x + "\0").join(""))
} else if (mode === "--parse") {
  const out = fs.readFileSync(rest[0], "utf8")
  const err = fs.readFileSync(rest[1], "utf8")
  process.stdout.write(JSON.stringify(M.parseDebugRead(out, err, Number(rest[2]))) + "\n")
} else if (mode === "--constants") {
  process.stdout.write([M.DEBUG_MAX_BYTES, M.DEBUG_TIMEOUT_S, M.DEBUG_KILL_AFTER_S].join("\n") + "\n")
} else {
  console.error("debug-read-text.js: unknown mode " + JSON.stringify(mode))
  process.exit(2)
}
