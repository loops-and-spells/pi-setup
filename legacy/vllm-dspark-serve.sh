#!/usr/bin/env bash
set -uo pipefail

# vLLM + DSpark server for DeepSeek-V4-Flash-DSpark
# Uses Docker image from Fraser Price (RTX Pro 6000 Blackwell-optimized)
# Stops llama-server first since both can't share VRAM.

IMAGE="${VLLM_IMAGE:-fraserpricee/vllm:dspark-cu132-20260627}"
MODEL_DIR="${MODEL_DIR:-$HOME/Downloads/DeepSeek-V4-Flash-DSpark-hf}"
HF_CACHE="${HF_CACHE:-$HOME/.cache/huggingface}"
VLLM_PORT="${VLLM_PORT:-8081}"
TP_SIZE="${TP_SIZE:-2}"
GPU_MEM_UTIL="${GPU_MEM_UTIL:-0.85}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-262144}"
MAX_NUM_SEQS="${MAX_NUM_SEQS:-1}"
# The Fraser Price Docker image has n_predict=4 hardcoded, so num_speculative_tokens must be a multiple of 4.
# 4 is closest to the model's native dspark_block_size=5.
DSPARK_TOKENS="${DSPARK_TOKENS:-4}"

# Validate
if [ ! -d "$MODEL_DIR" ] || [ ! -f "$MODEL_DIR/config.json" ]; then
	echo "ERROR: Model not found at $MODEL_DIR" >&2
	echo "Download with: hf download deepseek-ai/DeepSeek-V4-Flash-DSpark --local-dir $MODEL_DIR" >&2
	exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
	echo "Pulling Docker image: $IMAGE"
	docker pull "$IMAGE"
fi

# Stop llama-server first to free VRAM
LLAMA_SVC="llama-v4.service"
if systemctl --user is-active "$LLAMA_SVC" >/dev/null 2>&1; then
	echo "Stopping $LLAMA_SVC to free VRAM..."
	systemctl --user stop "$LLAMA_SVC"
	sleep 3
fi

# Clean up any old container with the same name
docker rm -f vllm-dspark 2>/dev/null || true

echo "Starting vLLM + DSpark on port $VLLM_PORT..."
echo "Model: $MODEL_DIR"
echo "TP: $TP_SIZE, GPU mem: $GPU_MEM_UTIL, max len: $MAX_MODEL_LEN"
echo ""

docker run --gpus all \
	--name vllm-dspark \
	--ipc=host \
	--network host \
	-v "$MODEL_DIR:/model" \
	-v "$HF_CACHE:/root/.cache/huggingface" \
	-e VLLM_USE_B12X_MOE=1 \
	-e VLLM_USE_B12X_WO_PROJECTION=1 \
	-e VLLM_DSPARK_CONFIDENCE_SCHEDULER=off \
	-e VLLM_DSPARK_LOCAL_ARGMAX=1 \
	-e VLLM_DSPARK_REPLICATE_MARKOV_W1=1 \
	-e VLLM_DSPARK_FUSED_MARKOV_ARGMAX=0 \
	-e VLLM_DSPARK_REFERENCE_KV_QUANT_DEQUANT=0 \
	-e VLLM_DSV4_B12X_COMPRESSED_MLA=0 \
	-e VLLM_DSV4_DSPARK_DEFER_TARGET_CAPTURE=0 \
	-e B12X_W4A16_TC_DECODE=0 \
	-e NCCL_P2P_DISABLE=0 \
	-e NCCL_IB_DISABLE=1 \
	-e NCCL_SOCKET_IFNAME=lo \
	-e VLLM_NCCL_SO_PATH=/opt/libnccl-local-inference.so.2.30.4 \
	-e VLLM_MEMORY_PROFILER_ESTIMATE_CUDAGRAPHS=0 \
	"$IMAGE" \
	vllm serve /model \
	--port "$VLLM_PORT" \
	--tensor-parallel-size "$TP_SIZE" \
	--distributed-executor-backend mp \
	--kv-cache-dtype fp8 \
	--block-size 256 \
	--max-model-len "$MAX_MODEL_LEN" \
	--max-num-seqs "$MAX_NUM_SEQS" \
	--max-num-batched-tokens 8192 \
	--gpu-memory-utilization "$GPU_MEM_UTIL" \
	--trust-remote-code \
	--tokenizer-mode deepseek_v4 \
	--reasoning-parser deepseek_v4 \
	--speculative-config "{\"method\":\"dspark\",\"num_speculative_tokens\":$DSPARK_TOKENS}"
