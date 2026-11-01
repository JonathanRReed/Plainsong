#pragma once

#include <cstdint>

namespace transcribe::qwen3_asr::decode_budget {

// Shared by the 0.6B and 1.7B single and batch decoders. Reaching this
// budget without EOS still returns TRANSCRIBE_ERR_OUTPUT_TRUNCATED.
constexpr int k_max_new = 2048;
constexpr int k_prompt_overhead = 48;  // Representative chat affixes, advisory only.

constexpr int64_t required_context(int prompt_tokens) {
    return static_cast<int64_t>(prompt_tokens) + k_max_new;
}

// Call after the input gate. Keep the existing 1024 floor, power-of-two
// attention width and caller/model ceiling.
constexpr int kv_context_size(int prompt_tokens, int ceiling) {
    int64_t rows = 1024;
    while (rows < required_context(prompt_tokens)) {
        rows *= 2;
    }
    return static_cast<int>(rows > ceiling ? ceiling : rows);
}

constexpr int64_t max_audio_ms(int ceiling, int hop_length, int sample_rate) {
    if (ceiling <= 0 || hop_length <= 0 || sample_rate <= 0) {
        return 0;
    }
    const int64_t audio_tokens = ceiling - required_context(k_prompt_overhead);
    // Three stride-2 encoder convolutions, then mel frames to milliseconds.
    return audio_tokens > 0 ? audio_tokens * 8 * hop_length * 1000 / sample_rate : 0;
}

}  // namespace transcribe::qwen3_asr::decode_budget
