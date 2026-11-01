#include "../vendor/transcribe-cpp-sys-0.2.3/src/arch/qwen3_asr/decode-budget.h"

namespace budget = transcribe::qwen3_asr::decode_budget;

// Exercise the arithmetic used by both native decode paths, without ggml,
// model weights, Metal, or a second copy of the budget calculation.
static_assert(budget::k_max_new == 2048);
static_assert(budget::k_prompt_overhead == 48);
static_assert(budget::required_context(63488) == 65536);
static_assert(budget::required_context(63489) > 65536);
static_assert(budget::required_context(2048) == 4096);
static_assert(budget::required_context(2049) > 4096);
static_assert(budget::kv_context_size(2048, 65536) == 4096);
static_assert(budget::kv_context_size(2049, 65536) == 8192);
static_assert(budget::kv_context_size(2952, 5000) == 5000);
static_assert(budget::kv_context_size(63488, 65536) == 65536);
static_assert(budget::max_audio_ms(65536, 160, 16000) == 5075200);
static_assert(budget::max_audio_ms(4096, 160, 16000) == 160000);
static_assert(budget::max_audio_ms(2096, 160, 16000) == 0);
static_assert(budget::max_audio_ms(2097, 160, 16000) == 80);
static_assert(budget::max_audio_ms(0, 160, 16000) == 0);
static_assert(budget::max_audio_ms(65536, 0, 16000) == 0);
static_assert(budget::max_audio_ms(65536, 160, 0) == 0);

// A representative 180-second input at 12.5 audio tokens/s plus chat affixes
// fits one decode. This proves capacity only, not transcript completeness.
static_assert(budget::required_context(2250 + budget::k_prompt_overhead) == 4346);
static_assert(budget::kv_context_size(2250 + budget::k_prompt_overhead, 65536) == 8192);

int main() {}
