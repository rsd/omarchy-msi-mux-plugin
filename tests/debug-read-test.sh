#!/bin/bash

# The debug read's command (Model.debugArgv: Model.DEBUG_SCRIPT around
# `timeout -k 2 10 <binary> --debug --json [flags]`) run for real against the
# fake binaries in tests/fixtures: the plain fake (its capture comes through
# byte for byte and parses), a producer's exit status kept, the flooding fake
# on stdout, stderr and both (stopped at the cap within moments, read as an
# error, never parsed), the hanging fake (ended by the timeout's TERM and then
# KILL, here with the timeout shortened to 1 s through the argv), exactly the
# cap against one byte over it, and NUL bytes counted. Each result is read by
# Model.parseDebugRead.
#
# Nothing here runs the real msi-mux-switch: every binary is a copy of a
# fixture in a temporary directory.

set -u

PLUGIN_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
FIXTURES=$PLUGIN_DIR/tests/fixtures
FAILED=0
CHECKS=0

ok() { CHECKS=$((CHECKS + 1)); echo "ok   $*"; }
fail() { CHECKS=$((CHECKS + 1)); FAILED=$((FAILED + 1)); echo "FAIL $*"; }

T=$(mktemp -d) || exit 1
trap 'rm -rf "$T"' EXIT

helper() { node "$PLUGIN_DIR/tests/debug-read-text.js" "$@"; }

mapfile -t CONST < <(helper --constants)
CAP=${CONST[0]} TIMEOUT_S=${CONST[1]} KILL_S=${CONST[2]}
FLAGS=(--allow-unsupported-hardware --allow-unvalidated-bios)

for f in fake-msi-mux-switch fake-msi-mux-switch-hang fake-msi-mux-switch-flood; do
  cp "$FIXTURES/$f" "$T/$f"
  chmod 755 "$T/$f"
done
export MM_FAKE_CAPTURE=$FIXTURES/debug-discrete.json

argv_of() { mapfile -d '' -t ARGV < <(helper --argv "$@"); }

# run_read <argv...>: runs it with stdout and stderr to $T/out and $T/err,
# under an outer `timeout 30` so a broken cap fails the case instead of
# hanging the suite. Sets STATUS and MS (wall time).
run_read() {
  local start end
  start=$(date +%s%N)
  timeout 30 "$@" >"$T/out" 2>"$T/err"
  STATUS=$?
  end=$(date +%s%N)
  MS=$(((end - start) / 1000000))
}

parsed() { helper --parse "$T/out" "$T/err" "$STATUS"; }

# The argv: bash, the script, its $0, then the timeout around the tool.
argv_of "$T/fake-msi-mux-switch" "${FLAGS[@]}"
if [[ ${ARGV[0]} == bash && ${ARGV[1]} == -c && ${ARGV[3]} == msi-mux-debug &&
  "${ARGV[*]:4}" == "timeout -k $KILL_S $TIMEOUT_S $T/fake-msi-mux-switch --debug --json ${FLAGS[*]}" ]]; then
  ok "argv: bash -c <script> msi-mux-debug timeout -k $KILL_S $TIMEOUT_S <binary> --debug --json <flags>"
else
  fail "argv: ${ARGV[*]:0:2} … ${ARGV[*]:3}"
fi
if [[ ${#ARGV[@]} -eq 13 && $CAP -eq 1048576 && $TIMEOUT_S -eq 10 && $KILL_S -eq 2 ]]; then
  ok "the cap is 1 MiB per stream, the timeout 10 s then KILL 2 s later"
else
  fail "constants: cap $CAP timeout $TIMEOUT_S kill $KILL_S argc ${#ARGV[@]}"
fi
SCRIPT=("${ARGV[@]:0:4}")

# The plain fake through the plugin's own argv: the capture byte for byte.
: >"$T/fake.log"
MM_FAKE_LOG=$T/fake.log run_read "${ARGV[@]}"
if ((STATUS == 0)) && cmp -s <(cat -- "$MM_FAKE_CAPTURE"; printf '\nstatus 0\n') "$T/out" &&
  [[ $(cat "$T/err") == $'\nend' ]]; then
  ok "plain fake: its stdout, then 'status 0'; stderr empty, then 'end'"
else
  fail "plain fake: status $STATUS, stdout $(head -c 80 "$T/out" | tr '\n' '|')…, stderr $(tr '\n' '|' <"$T/err")"
fi
if [[ $(cat "$T/fake.log") == "--debug --json ${FLAGS[*]}" ]]; then
  ok "the fake got exactly --debug --json and the flags"
else
  fail "the fake got: $(tr '\n' '|' <"$T/fake.log")"
fi
p=$(parsed)
if [[ $p == '{"ok":true,"error":"","current":"discrete","target":"discrete","pending":false,"modes":["discrete","mshybrid","integrated"]}' ]]; then
  ok "plain fake: parsed (current discrete, three modes)"
else
  fail "plain fake parsed as $p"
fi

# A producer's exit status and its stderr error line are kept.
run_read "${SCRIPT[@]}" sh -c 'printf "%s\n" "{\"event\":\"error\",\"level\":\"error\",\"message\":\"boom\"}" >&2; exit 3'
if [[ $(tail -1 "$T/out") == "status 3" && $(parsed) == *'"error":"boom"'* ]]; then
  ok "exit status 3 is kept and its error line is the message"
else
  fail "exit status: $(tr '\n' '|' <"$T/out") / $(parsed)"
fi

# Floods: stopped at the cap (the fake dies of SIGPIPE), refused unread.
for where in stdout stderr both; do
  MM_FAKE_FLOOD=$where run_read "${ARGV[@]/fake-msi-mux-switch/fake-msi-mux-switch-flood}"
  out=$(od -An -c "$T/out" | tr -s ' ' | tr -d '\n') err=$(od -An -c "$T/err" | tr -s ' ' | tr -d '\n')
  want_out=" \n s t a t u s 1 4 1 \n" want_err=" \n o v e r \n"
  [[ $where == stdout ]] && want_out=" \n o v e r \n" want_err=" \n e n d \n"
  [[ $where == both ]] && want_out=" \n o v e r \n"
  if ((STATUS == 0 && MS < 5000)) && [[ $out == "$want_out" && $err == "$want_err" ]]; then
    ok "flood on $where: over the cap in ${MS} ms; the script prints only its own lines"
  else
    fail "flood on $where: status $STATUS in ${MS} ms, stdout '$out', stderr '$err'"
  fi
  if [[ $(parsed) == *'"ok":false,"error":"msi-mux-switch --debug printed more than 1 MiB; not read."'* ]]; then
    ok "flood on $where: read as an error, not parsed"
  else
    fail "flood on $where parsed as $(parsed)"
  fi
done

# Hangs, the timeout shortened to 1 s through the argv: one that ignores
# TERM is killed 1 s later (137); one that does not ends on TERM (124).
hang=("${ARGV[@]/fake-msi-mux-switch/fake-msi-mux-switch-hang}")
hang[6]=1 hang[7]=1
# It runs in a session of its own (setsid; its first process writes the
# session ID, which is its PID), so what it started is found by that ID and
# never by name or pattern.
# shellcheck disable=SC2016 # $$ and $1 belong to the inner bash
run_read setsid bash -c 'printf "%s\n" "$$" >"$1" && shift && exec "$@"' msi-mux-hang "$T/hang.sid" "${hang[@]}"
HANG_SID=$(cat "$T/hang.sid" 2>/dev/null)
if ((STATUS == 0 && MS >= 1500 && MS < 5000)) && [[ $(cat "$T/out") == $'\nstatus 137' ]]; then
  ok "hang ignoring TERM: killed after the timeout and the grace period (${MS} ms, 137)"
else
  fail "hang ignoring TERM: status $STATUS in ${MS} ms, stdout $(tr '\n' '|' <"$T/out")"
fi
if [[ $(parsed) == *'"error":"msi-mux-switch --debug did not answer within 10 s."'* ]]; then
  ok "a timed-out read says so"
else
  fail "timed out read parsed as $(parsed)"
fi
sleep 0.2
if [[ ! $HANG_SID =~ ^[1-9][0-9]*$ ]]; then
  fail "the hanging read's session ID was not recorded ('$HANG_SID')"
else
  mapfile -t LEFT < <(ps -o pid= -s "$HANG_SID" | tr -d ' ')
  if ((${#LEFT[@]})); then
    fail "the hanging fake's session still has processes: ${LEFT[*]}"
    # Only the PIDs found in the session this test started.
    kill -KILL -- "${LEFT[@]}" 2>/dev/null
  else
    ok "the hanging fake and its children are gone (nothing left in its session)"
  fi
fi
run_read "${SCRIPT[@]}" timeout 1 sleep 30
if ((MS < 3000)) && [[ $(tail -1 "$T/out") == "status 124" && $(parsed) == *'did not answer within 10 s.'* ]]; then
  ok "hang ending on TERM: 124, read as timed out (${MS} ms)"
else
  fail "hang ending on TERM: ${MS} ms, $(tr '\n' '|' <"$T/out")"
fi

# Exactly the cap passes whole; one byte over is refused. NUL bytes count.
head -c "$CAP" /dev/zero | tr '\0' 'a' >"$T/exact"
run_read "${SCRIPT[@]}" cat -- "$T/exact"
if [[ $(head -c "$CAP" "$T/out" | cmp -s - "$T/exact" && tail -c +$((CAP + 1)) "$T/out") == $'\nstatus 0' ]]; then
  ok "exactly $CAP bytes pass whole"
else
  fail "exactly the cap: $(wc -c <"$T/out") bytes, ends $(tail -c 12 "$T/out" | tr '\n' '|')"
fi
printf 'a' >>"$T/exact"
run_read "${SCRIPT[@]}" cat -- "$T/exact"
if [[ $(cat "$T/out") == $'\nover' ]]; then ok "one byte over the cap is refused"; else fail "cap + 1: $(head -c 40 "$T/out")"; fi
head -c $((CAP + 1)) /dev/zero >"$T/nul"
run_read "${SCRIPT[@]}" cat -- "$T/nul"
if [[ $(cat "$T/out") == $'\nover' ]] && ! grep -q 'null byte' "$T/err"; then
  ok "NUL bytes count: cap + 1 of them is refused"
else
  fail "NUL bytes: $(head -c 40 "$T/out" | od -An -c | head -1) / $(head -c 80 "$T/err")"
fi
printf '{"a":\0}' >"$T/nul"
run_read "${SCRIPT[@]}" cat -- "$T/nul"
if [[ $(od -An -c "$T/out" | tr -s ' ' | tr -d '\n') == ' { " a " : 032 } \n s t a t u s 0 \n' ]]; then
  ok "a NUL byte is kept as SUB (1:1)"
else
  fail "NUL kept: $(od -An -c "$T/out" | tr -d '\n')"
fi

echo "$((CHECKS - FAILED))/$CHECKS passed"
((FAILED == 0))
