// Usage and subscription state. The Worker talks to this interface, backed
// by D1 in production and by an in-memory map in tests. It stores counters,
// subscription status and, for Stripe billing, license key hashes and
// activations: never audio, transcripts, prompts or a usable license key.

export function d1Store(db) {
  return {
    async getUsage(customerId, period) {
      const row = await db
        .prepare(
          "SELECT dictation_seconds, meeting_seconds, llm_tokens FROM usage WHERE customer_id = ? AND period = ?",
        )
        .bind(customerId, period)
        .first();
      return {
        dictationSeconds: row?.dictation_seconds ?? 0,
        meetingSeconds: row?.meeting_seconds ?? 0,
        llmTokens: row?.llm_tokens ?? 0,
      };
    },
    async addUsage(customerId, period, delta) {
      await db
        .prepare(
          `INSERT INTO usage (customer_id, period, dictation_seconds, meeting_seconds, llm_tokens)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (customer_id, period) DO UPDATE SET
             dictation_seconds = dictation_seconds + excluded.dictation_seconds,
             meeting_seconds = meeting_seconds + excluded.meeting_seconds,
             llm_tokens = llm_tokens + excluded.llm_tokens`,
        )
        .bind(
          customerId,
          period,
          Math.round(delta.dictationSeconds ?? 0),
          Math.round(delta.meetingSeconds ?? 0),
          Math.round(delta.llmTokens ?? 0),
        )
        .run();
    },
    async getSubscriptionStatus(customerId) {
      const row = await db
        .prepare("SELECT status FROM subscriptions WHERE customer_id = ?")
        .bind(customerId)
        .first();
      return row?.status ?? null;
    },
    async setSubscriptionStatus(customerId, status, updatedAt) {
      await db
        .prepare(
          `INSERT INTO subscriptions (customer_id, status, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (customer_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
           WHERE excluded.updated_at >= subscriptions.updated_at`,
        )
        .bind(customerId, status, updatedAt)
        .run();
    },
    async getLicense(keyHash) {
      const row = await db.prepare("SELECT customer_id FROM licenses WHERE key_hash = ?").bind(keyHash).first();
      return row ? { customerId: row.customer_id } : null;
    },
    async putLicense(keyHash, customerId, createdAt) {
      await db
        .prepare("INSERT INTO licenses (key_hash, customer_id, created_at) VALUES (?, ?, ?) ON CONFLICT (key_hash) DO NOTHING")
        .bind(keyHash, customerId, createdAt)
        .run();
    },
    async listActivations(keyHash) {
      const { results } = await db
        .prepare("SELECT activation_id FROM activations WHERE key_hash = ? ORDER BY created_at")
        .bind(keyHash)
        .all();
      return (results ?? []).map((row) => row.activation_id);
    },
    async addActivation(keyHash, activationId, label, createdAt) {
      await db
        .prepare("INSERT INTO activations (key_hash, activation_id, label, created_at) VALUES (?, ?, ?, ?)")
        .bind(keyHash, activationId, label, createdAt)
        .run();
    },
  };
}

export function memoryStore() {
  const usage = new Map();
  const subscriptions = new Map();
  const licenses = new Map();
  const activations = new Map();
  return {
    usage,
    subscriptions,
    licenses,
    async getUsage(customerId, period) {
      return { dictationSeconds: 0, meetingSeconds: 0, llmTokens: 0, ...usage.get(`${customerId}:${period}`) };
    },
    async addUsage(customerId, period, delta) {
      const current = await this.getUsage(customerId, period);
      usage.set(`${customerId}:${period}`, {
        dictationSeconds: current.dictationSeconds + (delta.dictationSeconds ?? 0),
        meetingSeconds: current.meetingSeconds + (delta.meetingSeconds ?? 0),
        llmTokens: current.llmTokens + (delta.llmTokens ?? 0),
      });
    },
    async getSubscriptionStatus(customerId) {
      return subscriptions.get(customerId)?.status ?? null;
    },
    async setSubscriptionStatus(customerId, status, updatedAt) {
      const current = subscriptions.get(customerId);
      if (!current || updatedAt >= current.updatedAt) subscriptions.set(customerId, { status, updatedAt });
    },
    async getLicense(keyHash) {
      return licenses.get(keyHash) ?? null;
    },
    async putLicense(keyHash, customerId) {
      if (!licenses.has(keyHash)) licenses.set(keyHash, { customerId });
    },
    async listActivations(keyHash) {
      return [...(activations.get(keyHash) ?? [])];
    },
    async addActivation(keyHash, activationId) {
      activations.set(keyHash, [...(activations.get(keyHash) ?? []), activationId]);
    },
  };
}
