//! Plainsong Plus: the optional paid tier (NOT LAUNCHED).
//!
//! Compiled in only with the `plainsong-plus` Cargo feature, which no release
//! build enables. Without it, `plus_get_status` reports `available: false`
//! and nothing else here exists, so a shipped app can neither show nor reach
//! Plus.
//!
//! The account is a Polar license key. Activating it on the relay Worker
//! (`infra/plus-worker`) registers this Mac and returns a 24 h entitlement
//! token; the key and activation id live in the keychain as internal secrets
//! and the token only in memory. Every Plus request re-uses the token and
//! quietly re-activates when it is close to expiring.

use serde_json::{json, Value};

#[cfg(feature = "plainsong-plus")]
pub use enabled::*;

/// What the settings screen needs to decide whether to show Plus at all.
pub async fn status() -> Value {
    #[cfg(feature = "plainsong-plus")]
    {
        enabled::account_status().await
    }
    #[cfg(not(feature = "plainsong-plus"))]
    {
        json!({ "available": false, "signedIn": false })
    }
}

#[cfg(feature = "plainsong-plus")]
mod enabled {
    use super::{json, Value};
    use crate::secrets;
    use anyhow::{anyhow, bail, Context, Result};
    use serde::Deserialize;
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const DEFAULT_PLUS_URL: &str = "https://plus.plainsong.jonathanrreed.com";
    const LICENSE_KEY_SECRET: &str = "plus-license-key";
    const ACTIVATION_ID_SECRET: &str = "plus-activation-id";
    /// Re-activate this long before the token's stated expiry.
    const REFRESH_MARGIN_SECONDS: u64 = 10 * 60;
    const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(20);

    /// The chat alias for dictation cleanup and Voice Edit (latency first).
    pub const PLUS_FAST_MODEL: &str = "plainsong-fast";

    struct CachedToken {
        token: String,
        expires_at: u64,
    }

    static TOKEN: Mutex<Option<CachedToken>> = Mutex::new(None);

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ActivateReply {
        token: String,
        activation_id: String,
        expires_at: String,
    }

    #[derive(Deserialize)]
    struct ErrorReply {
        error: ErrorBody,
    }

    #[derive(Deserialize)]
    struct ErrorBody {
        message: String,
    }

    /// The relay base URL. `PLAINSONG_PLUS_URL` points a dev build at a local
    /// `wrangler dev` or a staging Worker.
    pub fn base_url() -> String {
        std::env::var("PLAINSONG_PLUS_URL")
            .ok()
            .map(|url| url.trim().trim_end_matches('/').to_string())
            .filter(|url| !url.is_empty())
            .unwrap_or_else(|| DEFAULT_PLUS_URL.to_string())
    }

    fn now_seconds() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0)
    }

    fn stored(key: &str) -> Option<String> {
        secrets::get_internal_secret(key)
            .ok()
            .flatten()
            .filter(|value| !value.trim().is_empty())
    }

    /// True once a license key is stored. Cheap and synchronous, so ASR
    /// readiness can ask it.
    pub fn is_signed_in() -> bool {
        stored(LICENSE_KEY_SECRET).is_some()
    }

    fn http() -> reqwest::Client {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(ACCOUNT_TIMEOUT)
            .build()
            .unwrap_or_default()
    }

    /// A Worker error reply as a user-facing message, else a status line.
    pub(crate) fn error_message(status: reqwest::StatusCode, body: &str) -> String {
        match serde_json::from_str::<ErrorReply>(body) {
            Ok(reply) => reply.error.message,
            Err(_) => format!("Plainsong Plus returned status {}", status.as_u16()),
        }
    }

    fn parse_expiry(value: &str) -> u64 {
        chrono::DateTime::parse_from_rfc3339(value)
            .map(|at| at.timestamp().max(0) as u64)
            .unwrap_or_else(|_| now_seconds() + 60 * 60)
    }

    async fn request_token(
        license_key: &str,
        activation_id: Option<&str>,
    ) -> Result<ActivateReply> {
        let response = http()
            .post(format!("{}/v1/activate", base_url()))
            .json(&json!({
                "licenseKey": license_key,
                "activationId": activation_id,
                "deviceLabel": "Plainsong on macOS",
            }))
            .send()
            .await
            .context("Could not reach Plainsong Plus")?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!(error_message(status, &body));
        }
        serde_json::from_str(&body).context("Plainsong Plus sent an unreadable reply")
    }

    fn remember(reply: &ActivateReply) {
        if let Ok(mut cached) = TOKEN.lock() {
            *cached = Some(CachedToken {
                token: reply.token.clone(),
                expires_at: parse_expiry(&reply.expires_at),
            });
        }
    }

    /// Activates a license key on this Mac and stores it.
    pub async fn activate(license_key: &str) -> Result<Value> {
        let license_key = license_key.trim();
        if license_key.is_empty() {
            bail!("Enter your Plainsong Plus license key.");
        }
        let reply = request_token(license_key, None).await?;
        secrets::set_internal_secret(LICENSE_KEY_SECRET, license_key)?;
        secrets::set_internal_secret(ACTIVATION_ID_SECRET, &reply.activation_id)?;
        remember(&reply);
        Ok(account_status().await)
    }

    /// Forgets the license on this Mac. The activation stays on the Polar
    /// side until the user removes it from their account page.
    pub fn sign_out() -> Result<()> {
        if let Ok(mut cached) = TOKEN.lock() {
            *cached = None;
        }
        secrets::clear_internal_secret(LICENSE_KEY_SECRET)?;
        secrets::clear_internal_secret(ACTIVATION_ID_SECRET)?;
        Ok(())
    }

    /// A valid entitlement token, re-activating with the stored key when the
    /// cached one is missing or close to expiry.
    pub async fn access_token() -> Result<String> {
        if let Ok(cached) = TOKEN.lock() {
            if let Some(token) = cached.as_ref() {
                if token.expires_at > now_seconds() + REFRESH_MARGIN_SECONDS {
                    return Ok(token.token.clone());
                }
            }
        }
        let license_key = stored(LICENSE_KEY_SECRET)
            .ok_or_else(|| anyhow!("Sign in to Plainsong Plus in Settings first."))?;
        let activation_id = stored(ACTIVATION_ID_SECRET);
        let reply = request_token(&license_key, activation_id.as_deref()).await?;
        if activation_id.as_deref() != Some(reply.activation_id.as_str()) {
            secrets::set_internal_secret(ACTIVATION_ID_SECRET, &reply.activation_id)?;
        }
        remember(&reply);
        Ok(reply.token)
    }

    /// Drops the cached token so the next request re-activates; used after
    /// the Worker rejects one.
    pub fn forget_token() {
        if let Ok(mut cached) = TOKEN.lock() {
            *cached = None;
        }
    }

    pub(super) async fn account_status() -> Value {
        let signed_in = is_signed_in();
        let mut status = json!({
            "available": true,
            "signedIn": signed_in,
            "serviceUrl": base_url(),
        });
        if !signed_in {
            return status;
        }
        match usage().await {
            Ok(usage) => status["usage"] = usage,
            Err(error) => status["error"] = json!(error.to_string()),
        }
        status
    }

    async fn usage() -> Result<Value> {
        let token = access_token().await?;
        let response = http()
            .get(format!("{}/v1/usage", base_url()))
            .bearer_auth(token)
            .send()
            .await
            .context("Could not reach Plainsong Plus")?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            if status == reqwest::StatusCode::UNAUTHORIZED {
                forget_token();
            }
            bail!(error_message(status, &body));
        }
        serde_json::from_str(&body).context("Plainsong Plus sent an unreadable reply")
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn worker_errors_become_their_own_message() {
            let body = r#"{"error":{"code":"fair_use_reached","message":"Allowance used up."}}"#;
            assert_eq!(
                error_message(reqwest::StatusCode::TOO_MANY_REQUESTS, body),
                "Allowance used up."
            );
            assert_eq!(
                error_message(reqwest::StatusCode::BAD_GATEWAY, "<html>"),
                "Plainsong Plus returned status 502"
            );
        }

        #[test]
        fn expiry_parses_rfc3339_and_falls_back_to_an_hour() {
            assert_eq!(parse_expiry("2026-09-25T00:00:00.000Z"), 1_790_294_400);
            let fallback = parse_expiry("not a date");
            assert!(fallback > now_seconds() && fallback <= now_seconds() + 3600);
        }
    }
}

#[cfg(test)]
mod feature_gate_tests {
    use crate::asr::AsrProviderType;
    use crate::llm::Provider;

    #[cfg(not(feature = "plainsong-plus"))]
    #[tokio::test]
    async fn a_build_without_plus_cannot_name_offer_or_reach_it() {
        let status = super::status().await;
        assert_eq!(status["available"], false);
        assert!(serde_json::from_str::<AsrProviderType>("\"plainsong_plus\"").is_err());
        assert!(AsrProviderType::all()
            .iter()
            .all(|provider| provider.display_name() != "Plainsong Plus"));
        assert!(Provider::from_settings_value("plainsong-plus").is_err());
    }

    #[cfg(feature = "plainsong-plus")]
    #[test]
    fn a_plus_build_adds_one_speech_route_and_one_cleanup_provider() {
        assert!(AsrProviderType::all().contains(&AsrProviderType::PlainsongPlus));
        assert!(AsrProviderType::PlainsongPlus.is_remote());
        assert!(AsrProviderType::PlainsongPlus
            .provider_secret_name()
            .is_none());
        let provider = Provider::from_settings_value("plainsong-plus").expect("known");
        assert_eq!(provider, Provider::PlainsongPlus);
        assert!(provider.is_remote());
        assert_eq!(provider.as_settings_value(), "plainsong-plus");
        assert_eq!(provider.default_model(), super::PLUS_FAST_MODEL);
    }
}
