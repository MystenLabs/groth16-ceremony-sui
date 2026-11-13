#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Run a one-or-more-contributor mock ceremony and collect logs.

Run from the repository root, usually on the remote ceremony host.

Environment knobs:
  NETWORK=testnet
  RUN_NAME=mock-<utc timestamp>
  ARTIFACT_MODE=small          (small | existing)
  R1CS=<used only when ARTIFACT_MODE=existing>
  PTAU=<used only when ARTIFACT_MODE=existing>
  GENESIS=<used only when ARTIFACT_MODE=existing>
  BASE_ZKEY=<used only when ARTIFACT_MODE=existing>
  PUBLISH_PACKAGE=auto         (auto | 1 | 0)
  PUBLISH_GAS_BUDGET=200000000
  COORDINATOR_PORT=<random high port by default>
  COORDINATOR_URL=http://127.0.0.1:$COORDINATOR_PORT
  CONTRIBUTOR_COUNT=1
  FUNDING_MODE=self-funded     (self-funded | automatic | mixed)
                              mixed alternates self-funded, automatic; use
                              CONTRIBUTOR_COUNT=4 for two of each
  CONTRIBUTOR_NAME=mock-contributor
  FUND_SUI=0.06
  FUND_WAL=0.30
  RUN_GENESIS_VERIFY=1
  RUN_AUDIT=1

Outputs:
  $RUN_ROOT/$RUN_NAME/artifacts/
  $RUN_ROOT/$RUN_NAME/manifest.json
  $RUN_ROOT/$RUN_NAME/logs/
  $RUN_ROOT/$RUN_NAME/state.json
  $RUN_ROOT/$RUN_NAME/blobs/
  $RUN_ROOT/$RUN_NAME/contributors/
  $RUN_ROOT/$RUN_NAME/audit/
  $RUN_ROOT/$RUN_NAME/logs/summary.env
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
die() { echo "error: $*" >&2; exit 1; }
q() { printf '%q' "$1"; }

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

fmt_elapsed_ms() {
  local ms="$1"
  local h=$((ms / 3600000))
  local m=$(((ms % 3600000) / 60000))
  local s=$(((ms % 60000) / 1000))
  local fraction=$((ms % 1000))
  if ((h > 0)); then
    printf '%dh%dm%d.%03ds' "$h" "$m" "$s" "$fraction"
  elif ((m > 0)); then
    printf '%dm%d.%03ds' "$m" "$s" "$fraction"
  else
    printf '%d.%03ds' "$s" "$fraction"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found on PATH"
}

abspath() {
  node -e "const path=require('path'); console.log(path.resolve(process.argv[1]))" "$1"
}

json_get() {
  local file="$1" key="$2"
  node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(j[process.argv[2]] || '')" "$file" "$key"
}

json_published_package() {
  local file="$1"
  node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const xs=j.objectChanges||[]; const p=xs.find((x)=>x.type==='published')?.packageId || j.packageId || ''; console.log(p)" "$file"
}

run_log() {
  local log_file="$1"
  shift
  mkdir -p "$(dirname "$log_file")"
  {
    printf '\n[%s] $' "$(ts)"
    printf ' %q' "$@"
    printf '\n'
  } | tee -a "$log_file"
  local start_ms end_ms rc elapsed_ms
  start_ms="$(now_ms)"
  set +e
  "$@" 2>&1 | tee -a "$log_file"
  rc="${PIPESTATUS[0]}"
  set -e
  end_ms="$(now_ms)"
  elapsed_ms="$((end_ms - start_ms))"
  if ((rc == 0)); then
    printf '[%s] command completed in %s\n' "$(ts)" "$(fmt_elapsed_ms "$elapsed_ms")" | tee -a "$log_file"
  else
    printf '[%s] command failed after %s (exit %s)\n' "$(ts)" "$(fmt_elapsed_ms "$elapsed_ms")" "$rc" | tee -a "$log_file"
  fi
  return "$rc"
}

stage_artifact() {
  local src="$1" dest="$2"
  if [[ "$(abspath "$src")" == "$(abspath "$dest")" ]]; then
    return 0
  fi
  ln -f "$src" "$dest" 2>/dev/null || cp -p "$src" "$dest"
}

start_tmux_shell() {
  local session="$1" log_file="$2" cmd="$3"
  mkdir -p "$(dirname "$log_file")"
  tmux kill-session -t "$session" 2>/dev/null || true
  local inner="cd $(q "$REPO_ROOT") && export PATH=$(q "$PATH") && set -o pipefail; $cmd 2>&1 | tee -a $(q "$log_file")"
  tmux new-session -d -s "$session" "$inner"
}

wait_for_http() {
  local url="$1"
  for _ in $(seq 1 60); do
    if curl -fsS -X POST "$url/heartbeat" \
      -H 'Content-Type: application/json' \
      --data '{"mock":true}' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_for_session_exit() {
  local session="$1" label="$2"
  while tmux has-session -t "$session" 2>/dev/null; do
    sleep 10
  done
  echo "[$(ts)] $label session exited"
}

export PATH="$HOME/.local/bin:$PATH"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

require_cmd node
require_cmd tmux
require_cmd curl
require_cmd sui
require_cmd walrus

[[ -d coordinator/node_modules ]] || die "coordinator/node_modules missing; run npm install in coordinator/"

NETWORK="${NETWORK:-testnet}"
RUN_ROOT="ceremony-runs"
RUN_NAME="${RUN_NAME:-mock-$(date -u +%Y%m%dT%H%M%SZ)}"
node --input-type=module -e '
  import { validateRunName } from "./coordinator/src/lib/config.js";
  try { validateRunName(process.argv[1]); }
  catch (e) { console.error(e.message); process.exit(1); }
' "$RUN_NAME" || die "invalid RUN_NAME"
RUN_DIR="$(abspath "$RUN_ROOT/$RUN_NAME")"
ARTIFACTS_DIR="$RUN_DIR/artifacts"
LOG_DIR="$RUN_DIR/logs"
WORKDIR="$RUN_DIR"
CONTRIB_WORKDIR="$RUN_DIR/contributors"
AUDIT_WORKDIR="$RUN_DIR/audit"
MANIFEST="$RUN_DIR/manifest.json"

ARTIFACT_MODE="${ARTIFACT_MODE:-small}"
PUBLISH_PACKAGE="${PUBLISH_PACKAGE:-auto}"
PUBLISH_GAS_BUDGET="${PUBLISH_GAS_BUDGET:-200000000}"

RUN_GENESIS_VERIFY="${RUN_GENESIS_VERIFY:-1}"
RUN_AUDIT="${RUN_AUDIT:-1}"
COORDINATOR_PORT="${COORDINATOR_PORT:-$((18090 + RANDOM % 1000))}"
COORDINATOR_URL="${COORDINATOR_URL:-http://127.0.0.1:$COORDINATOR_PORT}"
CONTRIBUTOR_NAME="${CONTRIBUTOR_NAME:-mock-contributor}"
CONTRIBUTOR_ENTROPY="${CONTRIBUTOR_ENTROPY:-mock-entropy-$RUN_NAME}"
CONTRIBUTOR_COUNT="${CONTRIBUTOR_COUNT:-1}"
FUNDING_MODE="${FUNDING_MODE:-self-funded}"
[[ "$FUNDING_MODE" == self-funded || "$FUNDING_MODE" == automatic || "$FUNDING_MODE" == mixed ]] || die "FUNDING_MODE must be self-funded, automatic, or mixed"
FUND_SUI="${FUND_SUI:-$(node --input-type=module -e 'import { fundingDefaults, formatCoinAmount } from "./coordinator/src/lib/funding-policy.js"; console.log(formatCoinAmount(fundingDefaults(process.argv[1]).sui));' "$NETWORK")}"
FUND_WAL="${FUND_WAL:-$(node --input-type=module -e 'import { fundingDefaults, formatCoinAmount } from "./coordinator/src/lib/funding-policy.js"; console.log(formatCoinAmount(fundingDefaults(process.argv[1]).wal));' "$NETWORK")}"
ATTESTOR_SESSION="${ATTESTOR_SESSION:-mock-attestor-$RUN_NAME}"
CONTRIBUTOR_SESSION="${CONTRIBUTOR_SESSION:-mock-contributor-$RUN_NAME}"

[[ "$CONTRIBUTOR_COUNT" =~ ^[0-9]+$ && "$CONTRIBUTOR_COUNT" -ge 1 ]] || die "CONTRIBUTOR_COUNT must be a positive integer"

mkdir -p "$ARTIFACTS_DIR" "$LOG_DIR" "$WORKDIR" "$CONTRIB_WORKDIR" "$AUDIT_WORKDIR"

case "$ARTIFACT_MODE" in
  small)
    run_log "$LOG_DIR/build-small-artifacts.log" node coordinator/scripts/build-small-artifacts.mjs --out "$ARTIFACTS_DIR" --force
    R1CS="$ARTIFACTS_DIR/square.r1cs"
    PTAU="$ARTIFACTS_DIR/pot_final.ptau"
    GENESIS="$ARTIFACTS_DIR/circuit_0000.p2c"
    BASE_ZKEY="$ARTIFACTS_DIR/circuit_0000.zkey"
    ;;
  existing)
    R1CS="$(abspath "${R1CS:-coordinator/artifacts/zklogin-o2.r1cs}")"
    PTAU="$(abspath "${PTAU:-coordinator/artifacts/pot_final.ptau}")"
    GENESIS="$(abspath "${GENESIS:-coordinator/artifacts/circuit_0000.p2c}")"
    BASE_ZKEY="$(abspath "${BASE_ZKEY:-coordinator/artifacts/circuit_0000.zkey}")"
    stage_artifact "$R1CS" "$ARTIFACTS_DIR/$(basename "$R1CS")"
    stage_artifact "$PTAU" "$ARTIFACTS_DIR/$(basename "$PTAU")"
    stage_artifact "$GENESIS" "$ARTIFACTS_DIR/$(basename "$GENESIS")"
    stage_artifact "$BASE_ZKEY" "$ARTIFACTS_DIR/$(basename "$BASE_ZKEY")"
    R1CS="$ARTIFACTS_DIR/$(basename "$R1CS")"
    PTAU="$ARTIFACTS_DIR/$(basename "$PTAU")"
    GENESIS="$ARTIFACTS_DIR/$(basename "$GENESIS")"
    BASE_ZKEY="$ARTIFACTS_DIR/$(basename "$BASE_ZKEY")"
    ;;
  *)
    die "unknown ARTIFACT_MODE=$ARTIFACT_MODE (small | existing)"
    ;;
esac

[[ -f "$R1CS" ]] || die "missing R1CS: $R1CS"
[[ -f "$PTAU" ]] || die "missing PTAU: $PTAU"
[[ -f "$GENESIS" ]] || die "missing genesis p2c: $GENESIS"
[[ -f "$BASE_ZKEY" ]] || die "missing base zkey: $BASE_ZKEY"

PUBLISH_ARGS=(--publish-gas-budget "$PUBLISH_GAS_BUDGET")
case "$PUBLISH_PACKAGE" in
  auto) ;;
  1) PUBLISH_ARGS+=(--publish-package) ;;
  0) PUBLISH_ARGS+=(--no-publish-package) ;;
  *) die "PUBLISH_PACKAGE must be auto, 1, or 0" ;;
esac

ACTIVE_ADDR="$(sui client active-address | tr -d '\r\n')"
SUMMARY="$LOG_DIR/summary.env"
cat >"$SUMMARY" <<EOF
RUN_NAME=$RUN_NAME
RUN_DIR=$RUN_DIR
NETWORK=$NETWORK
ARTIFACT_MODE=$ARTIFACT_MODE
PUBLISH_PACKAGE=$PUBLISH_PACKAGE
PUBLISH_GAS_BUDGET=$PUBLISH_GAS_BUDGET
ACTIVE_ADDR=$ACTIVE_ADDR
COORDINATOR_URL=$COORDINATOR_URL
MANIFEST=$MANIFEST
WORKDIR=$WORKDIR
CONTRIB_WORKDIR=$CONTRIB_WORKDIR
AUDIT_WORKDIR=$AUDIT_WORKDIR
ARTIFACTS_DIR=$ARTIFACTS_DIR
R1CS=$R1CS
PTAU=$PTAU
GENESIS=$GENESIS
BASE_ZKEY=$BASE_ZKEY
RUN_GENESIS_VERIFY=$RUN_GENESIS_VERIFY
RUN_AUDIT=$RUN_AUDIT
FUND_SUI=$FUND_SUI
FUND_WAL=$FUND_WAL
CONTRIBUTOR_COUNT=$CONTRIBUTOR_COUNT
FUNDING_MODE=$FUNDING_MODE
ATTESTOR_SESSION=$ATTESTOR_SESSION
CONTRIBUTOR_SESSION=$CONTRIBUTOR_SESSION
EOF

echo "mock ceremony run: $RUN_DIR"
echo "logs: $LOG_DIR"

run_log "$LOG_DIR/key-init.log" node coordinator/src/key.js init --run "$RUN_NAME"

run_log "$LOG_DIR/create.log" \
  node coordinator/src/create.js \
    --network "$NETWORK" \
    --run "$RUN_NAME" \
    --r1cs "$R1CS" \
    --ptau "$PTAU" \
    --auditors "$ACTIVE_ADDR" \
    --threshold 1 \
    "${PUBLISH_ARGS[@]}" \
    --coordinator-url "$COORDINATOR_URL" \
    --permissioned

PACKAGE_ID="$(json_get "$MANIFEST" package_id)"
CEREMONY_ID="$(json_get "$MANIFEST" ceremony_id)"
ORGANIZER_CAP_ID="$(json_get "$MANIFEST" organizer_cap_id)"
[[ -n "$PACKAGE_ID" && -n "$CEREMONY_ID" && -n "$ORGANIZER_CAP_ID" ]] || die "create did not write package/ceremony/cap ids to $MANIFEST"
{
  echo "PACKAGE_ID=$PACKAGE_ID"
  echo "CEREMONY_ID=$CEREMONY_ID"
  echo "ORGANIZER_CAP_ID=$ORGANIZER_CAP_ID"
} >>"$SUMMARY"

run_log "$LOG_DIR/approve-r1cs.log" \
  node coordinator/src/admin.js approve-r1cs \
    --network "$NETWORK" \
    --run "$RUN_NAME"

if [[ "$RUN_GENESIS_VERIFY" == "1" ]]; then
  run_log "$LOG_DIR/genesis-verify.log" \
    node coordinator/src/genesis.js verify \
      --r1cs "$R1CS" \
      --ptau "$PTAU" \
      --zkey "$BASE_ZKEY" \
      --out "$(dirname "$GENESIS")"
else
  echo "[$(ts)] skipping genesis verify (set RUN_GENESIS_VERIFY=1 to enable)" | tee "$LOG_DIR/genesis-verify.log"
fi

run_log "$LOG_DIR/start-phase2.log" \
  node coordinator/src/admin.js start-phase2 \
    --network "$NETWORK" \
    --run "$RUN_NAME" \
    --genesis "$GENESIS"

run_log "$LOG_DIR/status-after-start.log" \
  node coordinator/src/admin.js status \
    --network "$NETWORK" \
    --run "$RUN_NAME"

ATTESTOR_CMD="export PATH=\"\$HOME/.local/bin:\$PATH\"; BASE_ZKEY=$(q "$BASE_ZKEY") BASE_PTAU=$(q "$PTAU") node coordinator/src/attestor.js --network $(q "$NETWORK") --run $(q "$RUN_NAME") --port $(q "$COORDINATOR_PORT")"
start_tmux_shell "$ATTESTOR_SESSION" "$LOG_DIR/attestor.log" "$ATTESTOR_CMD"
echo "[$(ts)] attestor tmux session: $ATTESTOR_SESSION" | tee -a "$LOG_DIR/attestor.log"
wait_for_http "$COORDINATOR_URL" || die "coordinator HTTP did not become ready at $COORDINATOR_URL"

contributor_workdir() {
  local idx="$1"
  if [[ "$CONTRIBUTOR_COUNT" == "1" ]]; then
    printf '%s\n' "$CONTRIB_WORKDIR"
  else
    printf '%s\n' "$CONTRIB_WORKDIR/contributor-$idx"
  fi
}

contributor_log() {
  local idx="$1"
  if [[ "$CONTRIBUTOR_COUNT" == "1" ]]; then
    printf '%s\n' "$LOG_DIR/contributor.log"
  else
    printf '%s\n' "$LOG_DIR/contributor-$idx.log"
  fi
}

contributor_name() {
  local idx="$1"
  if [[ "$CONTRIBUTOR_COUNT" == "1" ]]; then
    printf '%s\n' "$CONTRIBUTOR_NAME"
  else
    printf '%s\n' "$CONTRIBUTOR_NAME-$idx"
  fi
}

run_contributor() {
  local idx="$1"
  local c_workdir c_log c_name c_entropy c_session
  c_workdir="$(contributor_workdir "$idx")"
  c_log="$(contributor_log "$idx")"
  c_name="$(contributor_name "$idx")"
  if [[ "$CONTRIBUTOR_COUNT" == "1" ]]; then
    c_entropy="$CONTRIBUTOR_ENTROPY"
    c_session="$CONTRIBUTOR_SESSION"
  else
    c_entropy="$CONTRIBUTOR_ENTROPY-$idx"
    c_session="$CONTRIBUTOR_SESSION-$idx"
  fi
  mkdir -p "$c_workdir"

  local c_funding_mode="$FUNDING_MODE"
  if [[ "$c_funding_mode" == mixed ]]; then
    if ((idx % 2 == 1)); then c_funding_mode=self-funded; else c_funding_mode=automatic; fi
  fi
  echo "CONTRIBUTOR_${idx}_FUNDING_MODE=$c_funding_mode" >> "$SUMMARY"

  local contrib_cmd
  local funding_setup='unset CEREMONY_FUNDING_URL' funding_option='--self-funded'
  if [[ "$c_funding_mode" == automatic ]]; then
    # Resolve the secret inside the child shell; never print it in runner logs.
    funding_setup="CEREMONY_FUNDING_URL=\$(node coordinator/src/admin.js funding-url --network $(q "$NETWORK") --run $(q "$RUN_NAME")) && export CEREMONY_FUNDING_URL"
    funding_option=''
  fi
  contrib_cmd="$funding_setup && node cli/bin/ceremony.js contribute --ceremony $(q "$CEREMONY_ID") $funding_option --network $(q "$NETWORK") --workdir $(q "$c_workdir") --name $(q "$c_name") --entropy $(q "$c_entropy") --coordinator-url $(q "$COORDINATOR_URL")"
  start_tmux_shell "$c_session" "$c_log" "$contrib_cmd"
  echo "[$(ts)] contributor #$idx ($c_funding_mode) tmux session: $c_session" | tee -a "$c_log"

  if [[ "$c_funding_mode" == self-funded ]]; then
    local contribution_address=''
    for attempt in $(seq 1 120); do
      contribution_address="$(sed -n 's/.*Address: \(0x[0-9a-f]\{64\}\).*/\1/p' "$c_log" | head -1)"
      [[ -z "$contribution_address" ]] || break
      if ! tmux has-session -t "$c_session" 2>/dev/null; then
        die "contributor #$idx exited before funding; inspect $c_log"
      fi
      sleep 5
    done
    [[ -n "$contribution_address" ]] || die "timed out waiting for contributor #$idx's address"
    run_log "$LOG_DIR/allowlist-$idx.log" \
      node coordinator/src/admin.js enroll-without-funding "$contribution_address" \
        --network "$NETWORK" --run "$RUN_NAME"
    run_log "$LOG_DIR/fund-$idx.log" \
      node coordinator/src/admin.js fund "$contribution_address" \
        --network "$NETWORK" --run "$RUN_NAME" \
        --sui "$FUND_SUI" --wal "$FUND_WAL"
  fi

  wait_for_session_exit "$c_session" "contributor #$idx" | tee -a "$c_log"
  grep -q "Contribution accepted" "$c_log" || die "contributor #$idx did not report acceptance; inspect $c_log"

  run_log "$LOG_DIR/status-after-contribution-$idx.log" \
    node coordinator/src/admin.js status \
      --network "$NETWORK" \
      --run "$RUN_NAME"
}

for contributor_idx in $(seq 1 "$CONTRIBUTOR_COUNT"); do
  run_contributor "$contributor_idx"
done

run_log "$LOG_DIR/status-after-contribution.log" \
  node coordinator/src/admin.js status \
    --network "$NETWORK" \
    --run "$RUN_NAME"

run_log "$LOG_DIR/finalize-phase2.log" \
  node coordinator/src/admin.js finalize-phase2 \
    --network "$NETWORK" \
    --run "$RUN_NAME"

run_log "$LOG_DIR/seal.log" \
  env BASE_ZKEY="$BASE_ZKEY" BASE_PTAU="$PTAU" \
  node coordinator/src/admin.js seal \
    --network "$NETWORK" \
    --run "$RUN_NAME" \
    --name mock-beacon

run_log "$LOG_DIR/status-closed.log" \
  node coordinator/src/admin.js status \
    --network "$NETWORK" \
    --run "$RUN_NAME"

if [[ "$RUN_AUDIT" == "1" ]]; then
  run_log "$LOG_DIR/audit.log" \
    node coordinator/src/audit.js \
      --network "$NETWORK" \
      --run "$RUN_NAME" \
      --ptau "$PTAU"
else
  echo "[$(ts)] skipping final audit (set RUN_AUDIT=1 to enable)" | tee "$LOG_DIR/audit.log"
fi

tmux kill-session -t "$ATTESTOR_SESSION" 2>/dev/null || true
echo "[$(ts)] stopped attestor session $ATTESTOR_SESSION" | tee -a "$LOG_DIR/attestor.log"

{
  echo "FINAL_MANIFEST=$MANIFEST"
  echo "TELEMETRY=$LOG_DIR/telemetry.jsonl"
  echo "ENROLLMENT_REQUESTS=$LOG_DIR/enrollment-requests.jsonl"
  if [[ "$CONTRIBUTOR_COUNT" == "1" ]]; then
    echo "CONTRIBUTOR_RECEIPTS=$CONTRIB_WORKDIR/receipt-*.json"
  else
    echo "CONTRIBUTOR_RECEIPTS=$CONTRIB_WORKDIR/contributor-*/receipt-*.json"
  fi
} >>"$SUMMARY"

echo
echo "mock ceremony complete"
echo "  ceremony: $CEREMONY_ID"
echo "  run dir:  $RUN_DIR"
echo "  summary:  $SUMMARY"
echo "  logs:     $LOG_DIR"
