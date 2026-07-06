import * as os from "node:os"
import * as path from "node:path"

const home = os.homedir()
const env = (key: string, fallback: string): string => process.env[key] ?? fallback

/**
 * Every host-specific location in one place. All of them can be overridden
 * with environment variables so the suite stays portable across machines.
 */
export const paths = {
  home,
  repoRoot: path.resolve(import.meta.dir, "../../.."),

  pi: {
    settings: path.join(home, ".pi/agent/settings.json"),
    models: path.join(home, ".pi/agent/models.json")
  },

  systemdUserDir: path.join(home, ".config/systemd/user"),
  localBin: path.join(home, ".local/bin"),
  lms: env("LMS_BIN", path.join(home, ".lmstudio/bin/lms")),
  cudaBin: env("CUDA_BIN_DIR", "/opt/cuda/bin"),
  cudaLib: env("CUDA_LIB_DIR", "/opt/cuda/lib64"),

  /** Agnostic model store: ~/Machine/models/{gguf,hf}/<model>/, no launcher nesting. */
  modelStore: env("MODEL_STORE", path.join(home, "Machine/models")),

  llama: {
    bin: env("LLAMA_BIN", path.join(home, "src/llama.cpp-v4/build/bin/llama-server")),
    ggufDir: env("LLAMA_GGUF_DIR", path.join(home, "Machine/models/gguf/deepseek-v4-flash")),
    slotDir: env("SLOT_SAVE_PATH", "/dev/shm/llama-v4-slots")
  },

  vllm: {
    image: env("VLLM_IMAGE", "fraserpricee/vllm:dspark-cu132-20260627"),
    modelDir: env("MODEL_DIR", path.join(home, "Machine/models/hf/deepseek-v4-flash-dspark")),
    hfCache: env("HF_CACHE", path.join(home, ".cache/huggingface")),
    container: "vllm-dspark"
  },

  ds4: {
    dir: env("DS4_DIR", path.join(home, "src/ds4")),
    repo: env("DS4_REPO", "https://github.com/antirez/ds4"),
    kvDir: env("DS4_KV_DIR", path.join(home, ".cache/ds4-kv")),
    /** download_model.sh maintains this symlink to the selected quant */
    model: env("DS4_MODEL", path.join(home, "src/ds4/ds4flash.gguf"))
  },

  council: {
    ornithGguf: env(
      "ORNITH_GGUF",
      path.join(
        home,
        "Machine/models/gguf/ornith-1.0-397b/deepreinforce-ai_Ornith-1.0-397B-IQ3_XXS-00001-of-00005.gguf"
      )
    ),
    scoutGguf: env("SCOUT_GGUF", path.join(home, "Machine/models/gguf/qwen3-4b/Qwen3-4B-Q4_K_M.gguf"))
  }
} as const
