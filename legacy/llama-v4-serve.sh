#!/usr/bin/env bash
set -uo pipefail
GGUF_DIR="$HOME/Downloads/DeepSeek-V4-Flash-GGUF"
BIN="$HOME/src/llama.cpp-v4/build/bin/llama-server"
MODEL=$(find "$GGUF_DIR" -name "*00001-of-*.gguf" 2>/dev/null | head -1)
[ -z "$MODEL" ] && MODEL=$(find "$GGUF_DIR" -name "*.gguf" 2>/dev/null | head -1)
if [ -z "$MODEL" ] || [ ! -x "$BIN" ]; then
  echo "Missing model ($MODEL) or binary ($BIN)"; exit 1
fi
export PATH="/opt/cuda/bin:$PATH"
export LD_LIBRARY_PATH="/opt/cuda/lib64:${LD_LIBRARY_PATH:-}"
# Offload MoE expert tensors of the first N of 43 layers to CPU to free VRAM
# headroom for compute buffers / concurrent subagent slots. Higher N = more free
# VRAM but slower (those layers run experts on CPU). Tune via NCMOE env.
NCMOE="${NCMOE:-4}"
# Offloading the first NCMOE layers' experts frees VRAM only on the GPU those
# early layers sit on (GPU0 under the split below), so rebalance the split to
# even out free VRAM per card. Fewer offloaded layers (4) -> less VRAM freed on
# GPU0 -> shift split back toward GPU1 vs the NCMOE=8 setting (which used 56,44).
TS="${TS:-52,48}"
# Persist slot KV to tmpfs (faster than disk, enables save/restore so recovery can skip reprefill).
# NOTE: --cache-reuse is unsupported by DeepSeek4's MLA/hybrid KV (auto-disabled), so omitted.
SLOT_SAVE_PATH="${SLOT_SAVE_PATH:-/dev/shm/llama-v4-slots}"
mkdir -p "$SLOT_SAVE_PATH"

# Restore slots from tmpfs on startup (skips reprefill for ongoing conversations).
RESTORE_SLOTS() {
  local ready=0
  for i in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:8080/health" >/dev/null 2>&1; then
      ready=1; break
    fi
    sleep 1
  done
  if [ "$ready" -eq 0 ]; then
    echo "Server not ready after 60s, skipping slot restore" >&2
    return
  fi
  for f in "$SLOT_SAVE_PATH"/*.session; do
    [ -f "$f" ] || continue
    local slot_id=$(basename "$f" .session | sed 's/slot_//')
    echo "Restoring slot $slot_id from $f"
    curl -sf -X POST "http://127.0.0.1:8080/slots?action=restore&id_slot=$slot_id" \
      -H "Content-Type: application/json" \
      -d "{\"filename\":\"$(basename $f)\"}" 2>/dev/null || true
  done
}

# On exit, save all active slots so recovery is instant on next start.
# NOTE: cannot use `exec` here because the trap must fire from the shell process.
SAVE_SLOTS() {
  for s in 0 1 2 3; do
    curl -sf -X POST "http://127.0.0.1:8080/slots?action=save&id_slot=$s" \
      -H "Content-Type: application/json" \
      -d "{\"filename\":\"slot_$s.session\"}" 2>/dev/null
  done
}
trap SAVE_SLOTS EXIT

# Start in background so we can restore slots once ready, then wait for server.
"$BIN" \
  -m "$MODEL" \
  --alias deepseek-v4-flash \
  --host 127.0.0.1 --port 8080 \
  -ngl 999 \
  --tensor-split "$TS" \
  -t 24 -tb 24 \
  -fit off \
  --cache-prompt \
  --n-cpu-moe "$NCMOE" \
  --slot-save-path "$SLOT_SAVE_PATH" \
  -c 262144 &
BGPID=$!

RESTORE_SLOTS

wait $BGPID
