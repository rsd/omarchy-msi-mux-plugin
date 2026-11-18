#!/usr/bin/env node

// For tests/env-file-test.sh. Model.js is a QML JS module (no exports), so it
// is evaluated and the functions lifted out, as tests/model-test.js does.
//
//   env-file-text.js <base>                prints Model.envFileText(<base>)
//   env-file-text.js --read-argv <home>    prints Model.envReadArgv(<home>)
//   env-file-text.js --write-argv <home> <base>
//                                          prints Model.envWriteArgv(...)
//   env-file-text.js --remove-argv <home>  prints Model.envRemoveArgv(<home>)
//   env-file-text.js --parse-read          prints Model.parseEnvRead(stdin)
//
// An argv is printed NUL-terminated, one argument after another.

const fs = require("fs")
const path = require("path")

const source = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
const M = new Function(source + "\nreturn { envFileText, envReadArgv, envWriteArgv, envRemoveArgv, parseEnvRead }")()
const [mode, a, b] = process.argv.slice(2)

const printArgv = (argv) => {
  if (argv.length === 0) {
    console.error("env-file-text.js: no argv for " + JSON.stringify(process.argv.slice(2)))
    process.exit(2)
  }
  process.stdout.write(argv.map(x => x + "\0").join(""))
}

if (mode === "--read-argv") printArgv(M.envReadArgv(a))
else if (mode === "--write-argv") printArgv(M.envWriteArgv(a, b))
else if (mode === "--remove-argv") printArgv(M.envRemoveArgv(a))
else if (mode === "--parse-read") process.stdout.write(M.parseEnvRead(fs.readFileSync(0, "latin1")) + "\n")
else {
  const text = M.envFileText(mode)
  if (text === "") {
    console.error("env-file-text.js: unknown base " + JSON.stringify(mode))
    process.exit(2)
  }
  process.stdout.write(text)
}
