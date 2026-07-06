import type { ChatMetrics, ChatResult } from "./types"

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
}

interface CompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** Pull `<think>…</think>` out of content (llama.cpp emits reasoning inline). */
const splitThink = (raw: string): { content: string; reasoning: string } => {
  const match = raw.match(/<think>([\s\S]*?)<\/think>/)
  if (match === null) return { content: raw.trim(), reasoning: "" }
  return {
    content: raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim(),
    reasoning: (match[1] ?? "").trim()
  }
}

export const chat = async (opts: {
  port: number
  model: string
  messages: readonly ChatMessage[]
  temperature: number
  maxTokens: number
  timeoutMs?: number
}): Promise<ChatResult> => {
  const started = Date.now()
  const res = await fetch(`http://127.0.0.1:${opts.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer EMPTY" },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30 * 60 * 1000)
  })
  const wallMs = Date.now() - started
  if (!res.ok) {
    throw new Error(`:${opts.port} ${opts.model} → HTTP ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as CompletionResponse
  const message = body.choices?.[0]?.message
  const inline = splitThink(message?.content ?? "")
  const completionTokens = body.usage?.completion_tokens ?? 0
  const metrics: ChatMetrics = {
    wallMs,
    promptTokens: body.usage?.prompt_tokens ?? 0,
    completionTokens,
    tokensPerSec: wallMs > 0 ? Math.round((completionTokens / wallMs) * 10000) / 10 : 0
  }
  return {
    content: inline.content,
    reasoning: message?.reasoning_content ?? inline.reasoning,
    metrics
  }
}
