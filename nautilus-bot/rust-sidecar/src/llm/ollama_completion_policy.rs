//! Admission for a locally hosted model. No eviction or model loading here.
const RESERVE: u64 = 6 * 1024 * 1024 * 1024;

pub(super) fn embedding_batch_limit(
    size: Option<u64>,
    scratch_per_input: Option<u64>,
    resident: bool,
    available: Option<u64>,
    requested: usize,
) -> Result<usize, &'static str> {
    let size = size
        .filter(|value| *value > 0)
        .ok_or("Could not verify the embedding model size.")?;
    let scratch = scratch_per_input
        .filter(|value| *value > 0)
        .ok_or("Could not verify the embedding model memory requirements.")?;
    let available =
        available.ok_or("Could not verify current memory headroom for local embeddings.")?;
    let base = RESERVE
        .checked_add(size / 2)
        .and_then(|value| {
            if resident {
                Some(value)
            } else {
                value.checked_add(size)
            }
        })
        .ok_or("The embedding memory requirement is too large.")?;
    let count = available
        .checked_sub(base)
        .map(|remaining| remaining / scratch)
        .unwrap_or(0);
    let count = usize::try_from(count)
        .unwrap_or(usize::MAX)
        .min(requested)
        .min(8);
    if count == 0 {
        return Err(
            "Not enough current memory headroom for local embeddings alongside other applications.",
        );
    }
    Ok(count)
}

pub(super) fn context(
    requested: Option<usize>,
    configured: Option<usize>,
    capacity: Option<usize>,
) -> Result<i32, &'static str> {
    let tokens = requested.or(configured).unwrap_or(4096);
    if tokens == 0 || capacity.is_some_and(|limit| tokens > limit) {
        return Err("The requested Ollama context is invalid or exceeds the model capacity.");
    }
    i32::try_from(tokens).map_err(|_| "The requested Ollama context is too large.")
}

pub(super) fn admit(
    size: Option<u64>,
    kv_bytes_per_token: Option<u64>,
    tokens: i32,
    resident_context: Option<usize>,
    available: Option<u64>,
) -> Result<i32, &'static str> {
    let size = size
        .filter(|size| *size > 0)
        .ok_or("Could not verify the local Ollama model size. Try again after checking Ollama.")?;
    let available =
        available.ok_or("Could not verify current memory headroom for local Ollama processing.")?;
    let context = if let Some(resident) = resident_context {
        // Use the existing allocation exactly. Changing num_ctx can reload it.
        if resident < tokens as usize {
            return Err("The loaded Ollama model has a smaller context. Finish other work and unload it in Ollama before changing its allocation.");
        }
        i32::try_from(resident).map_err(|_| "The loaded Ollama context is too large.")?
    } else {
        tokens
    };
    let required = if resident_context.is_some() {
        RESERVE.checked_add(size / 2)
    } else {
        let kv = kv_bytes_per_token.filter(|value| *value > 0).ok_or("Could not verify the model's context memory requirements. Choose the built-in engine or another local model.")?;
        size.checked_add(size / 2).and_then(|value| value.checked_add(RESERVE))
            .and_then(|value| kv.checked_mul(tokens as u64).and_then(|cache| value.checked_add(cache)))
    }.ok_or("The local Ollama memory requirement is too large.")?;
    if available < required {
        return Err("Not enough current memory headroom for this Ollama model and context alongside other applications.");
    }
    Ok(context)
}

#[cfg(test)]
mod tests {
    use super::*;
    const GIB: u64 = 1024 * 1024 * 1024;
    #[test]
    fn embedding_batches_shrink_to_headroom_without_eviction() {
        assert_eq!(
            embedding_batch_limit(Some(GIB), Some(GIB), false, Some(10 * GIB), 20).unwrap(),
            2
        );
        assert_eq!(
            embedding_batch_limit(Some(GIB), Some(GIB), false, Some(32 * GIB), 20).unwrap(),
            8
        );
        assert!(
            embedding_batch_limit(Some(14 * GIB), Some(GIB), false, Some(24 * GIB), 1).is_err()
        );
        assert!(embedding_batch_limit(Some(GIB), None, false, Some(32 * GIB), 1).is_err());
        assert!(embedding_batch_limit(Some(GIB), Some(GIB), false, None, 1).is_err());
    }
    #[test]
    fn rejects_large_models_on_a_busy_machine() {
        assert!(admit(Some(14 * GIB), Some(128_000), 4096, None, Some(20 * GIB)).is_err());
        assert!(admit(Some(GIB), Some(128_000), 4096, None, Some(7 * GIB)).is_err());
    }
    #[test]
    fn counts_context_cache_and_rejects_unknown_inputs() {
        assert!(admit(Some(GIB), Some(128_000), 4096, None, Some(9 * GIB)).is_ok());
        assert!(admit(Some(GIB), Some(128_000), 32768, None, Some(9 * GIB)).is_err());
        for (size, kv, available) in [
            (None, Some(1), Some(32 * GIB)),
            (Some(GIB), None, Some(32 * GIB)),
            (Some(GIB), Some(1), None),
        ] {
            assert!(admit(size, kv, 4096, None, available).is_err());
        }
    }
    #[test]
    fn resident_reuse_keeps_exact_allocation_and_still_checks_memory() {
        assert_eq!(
            admit(Some(2 * GIB), None, 4096, Some(8192), Some(8 * GIB)).unwrap(),
            8192
        );
        assert!(admit(Some(2 * GIB), None, 16384, Some(8192), Some(32 * GIB)).is_err());
        assert!(admit(Some(2 * GIB), None, 4096, Some(8192), Some(2 * GIB)).is_err());
    }
    #[test]
    fn context_never_falls_back_after_invalid_explicit_input() {
        assert_eq!(context(None, None, None).unwrap(), 4096);
        assert_eq!(context(None, Some(8192), Some(16384)).unwrap(), 8192);
        assert!(context(Some(0), Some(4096), None).is_err());
        assert!(context(Some(usize::MAX), None, None).is_err());
        assert!(context(Some(16384), None, Some(8192)).is_err());
    }
    #[test]
    fn overflow_is_a_refusal() {
        assert!(admit(Some(u64::MAX), Some(u64::MAX), 4096, None, Some(u64::MAX)).is_err());
    }
}
