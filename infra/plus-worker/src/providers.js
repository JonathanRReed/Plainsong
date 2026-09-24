// Upstream model providers behind the Worker. The app only ever sees
// OpenAI-shaped responses and two model aliases, so the models behind them
// can change here without an app update.
//
// Shapes: xAI speech-to-text follows @ai-sdk/xai 5.0.7 (POST /v1/stt,
// multipart `file`, repeated `keyterm`); ElevenLabs follows Plainsong's own
// asr/elevenlabs_scribe.rs; Groq is OpenAI-compatible; Anthropic is the
// Messages API. Re-check each against the vendor docs before launch.

export const CHAT_MODELS = {
  // Dictation cleanup and Voice Edit: latency first.
  "plainsong-fast": { provider: "groq", model: "openai/gpt-oss-120b" },
  // Meeting summaries and long rewrites: quality first.
  "plainsong-quality": { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
};

const MAX_KEYTERMS = 100;

export class UpstreamError extends Error {
  constructor(provider, status) {
    super(`${provider} returned ${status}`);
    this.provider = provider;
    this.status = status;
  }
}

function cleanKeyterms(keyterms) {
  const seen = new Set();
  const out = [];
  for (const raw of keyterms ?? []) {
    const term = String(raw).trim();
    if (!term || term.length > 100 || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length === MAX_KEYTERMS) break;
  }
  return out;
}

async function transcribeWithXai(env, audio, options) {
  const form = new FormData();
  form.append("file", audio, "audio.wav");
  if (options.language) form.append("language", options.language);
  for (const term of cleanKeyterms(options.keyterms)) form.append("keyterm", term);
  const response = await fetch("https://api.x.ai/v1/stt", {
    method: "POST",
    headers: { authorization: `Bearer ${env.XAI_API_KEY}` },
    body: form,
  });
  if (!response.ok) throw new UpstreamError("xai", response.status);
  const data = await response.json();
  return {
    text: data.text ?? "",
    language: data.language ?? options.language ?? null,
    duration: typeof data.duration === "number" ? data.duration : null,
    words: Array.isArray(data.words) ? data.words : [],
    provider: "xai",
  };
}

async function transcribeWithElevenLabs(env, audio, options) {
  const form = new FormData();
  form.append("audio", audio, "audio.wav");
  form.append("model_id", "scribe_v2");
  for (const term of cleanKeyterms(options.keyterms)) form.append("keyterms", term);
  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
    body: form,
  });
  if (!response.ok) throw new UpstreamError("elevenlabs", response.status);
  const data = await response.json();
  return {
    text: data.text ?? "",
    language: data.language_code ?? options.language ?? null,
    duration: null,
    words: (data.words ?? []).map((word) => ({ text: word.text, start: word.start, end: word.end })),
    provider: "elevenlabs",
  };
}

/** Primary xAI; ElevenLabs when xAI fails with a server error and a key is set. */
export async function transcribe(env, audio, options = {}) {
  try {
    return await transcribeWithXai(env, audio, options);
  } catch (error) {
    const retryable = error instanceof UpstreamError && error.status >= 500;
    if (retryable && env.ELEVENLABS_API_KEY) return transcribeWithElevenLabs(env, audio, options);
    throw error;
  }
}

function openAiResponse(alias, content, promptTokens, completionTokens) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: alias,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

async function chatWithGroq(env, route, alias, request) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: route.model,
      messages: request.messages,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
    }),
  });
  if (!response.ok) throw new UpstreamError("groq", response.status);
  const data = await response.json();
  return openAiResponse(
    alias,
    data.choices?.[0]?.message?.content ?? "",
    data.usage?.prompt_tokens ?? 0,
    data.usage?.completion_tokens ?? 0,
  );
}

async function chatWithAnthropic(env, route, alias, request) {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const messages = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content }));
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: route.model,
      max_tokens: request.max_tokens ?? 2048,
      temperature: request.temperature,
      ...(system ? { system } : {}),
      messages,
    }),
  });
  if (!response.ok) throw new UpstreamError("anthropic", response.status);
  const data = await response.json();
  const text = (data.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
  return openAiResponse(alias, text, data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0);
}

export async function chat(env, request) {
  const alias = CHAT_MODELS[request.model] ? request.model : "plainsong-fast";
  const route = CHAT_MODELS[alias];
  return route.provider === "anthropic"
    ? chatWithAnthropic(env, route, alias, request)
    : chatWithGroq(env, route, alias, request);
}
