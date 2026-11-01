#ifdef NDEBUG
#error "Run this control with assertions enabled"
#endif
// Link against the patched native library and its ggml libraries. No model.
#include "arch/moonshine_streaming/decoder.h"
#include "arch/moonshine_streaming/moonshine_streaming.h"
#include "arch/moonshine_streaming/weights.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include <algorithm>
#include <cassert>
#include <cstring>
#include <vector>
using namespace transcribe::moonshine_streaming;
int main() {
    auto backend = ggml_backend_cpu_init();
    assert(backend);
    MoonshineStreamingHParams hp{};
    hp.dec_d_model = 3;
    hp.dec_n_layers = 3;
    constexpr int T = 513;
    constexpr size_t count = 3 * T * 3;
    std::vector<float> k(count), v(count);
    for (size_t i = 0; i < count; ++i) {
        k[i] = (static_cast<int>(i % 257) - 128) / 7.0f;
        v[i] = (static_cast<int>(i % 193) - 96) / 13.0f;
    }
    for (auto type : {GGML_TYPE_F32, GGML_TYPE_F16}) {
        MoonshineStreamingKvCache cache;
        ggml_init_params cp{8 * 1024 * 1024, nullptr, true};
        cache.ctx = ggml_init(cp);
        cache.T_enc = T;
        // Trailing guard elements prove the final layer's tail stays in range.
        cache.cross_k = ggml_new_tensor_1d(cache.ctx, type, count + 16);
        cache.cross_v = ggml_new_tensor_1d(cache.ctx, type, count + 16);
        cache.buffer = ggml_backend_alloc_ctx_tensors(cache.ctx, backend);
        assert(cache.buffer);
        ggml_backend_buffer_clear(cache.buffer, 0);
        const size_t elem = ggml_element_size(cache.cross_k);
        std::vector<unsigned char> expected_k((count + 16) * elem, 0), expected_v(expected_k.size(), 0);
        if (type == GGML_TYPE_F32) {
            std::memcpy(expected_k.data(), k.data(), count * elem);
            std::memcpy(expected_v.data(), v.data(), count * elem);
        } else {
            for (size_t i = 0; i < count; ++i) {
                auto a = ggml_fp32_to_fp16(k[i]), b = ggml_fp32_to_fp16(v[i]);
                std::memcpy(expected_k.data() + i * elem, &a, elem);
                std::memcpy(expected_v.data() + i * elem, &b, elem);
            }
        }
        for (int layer = 0; layer < hp.dec_n_layers; ++layer) {
            for (int f = 0; f < T;) {
                const int n = std::min(k_cross_kv_commit_frames, T - f);
                auto ctx = ggml_init(cp);
                auto cb = build_cross_kv_commit_graph(ctx, hp, cache, T, layer, f, n);
                assert(cb.graph && cb.k_in->ne[1] == n && cb.v_in->ne[1] == n);
                auto buf = ggml_backend_alloc_ctx_tensors(ctx, backend);
                assert(buf);
                const size_t source = (static_cast<size_t>(layer) * T + f) * hp.dec_d_model;
                const size_t bytes = static_cast<size_t>(n) * hp.dec_d_model * sizeof(float);
                ggml_backend_tensor_set(cb.k_in, k.data() + source, 0, bytes);
                ggml_backend_tensor_set(cb.v_in, v.data() + source, 0, bytes);
                assert(ggml_backend_graph_compute(backend, cb.graph) == GGML_STATUS_SUCCESS);
                ggml_backend_buffer_free(buf);
                ggml_free(ctx);
                f += n;
            }
        }
        std::vector<unsigned char> actual_k(expected_k.size()), actual_v(expected_v.size());
        ggml_backend_tensor_get(cache.cross_k, actual_k.data(), 0, actual_k.size());
        ggml_backend_tensor_get(cache.cross_v, actual_v.data(), 0, actual_v.size());
        assert(actual_k == expected_k && actual_v == expected_v);
        cache.free();
    }
    ggml_backend_free(backend);
}
