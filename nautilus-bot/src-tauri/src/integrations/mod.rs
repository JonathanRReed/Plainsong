//! Slack and Mantisbot integration for notifications and exports
//!
//! Supports:
//! - Slack webhook notifications for new recordings
//! - Slack file upload for transcripts
//! - Mantisbot API for ticket creation

#![allow(dead_code)]

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Slack integration client
pub struct SlackClient {
    webhook_url: Option<String>,
    bot_token: Option<String>,
    client: reqwest::Client,
}

impl SlackClient {
    /// Create a new Slack client from environment variables
    pub fn new() -> Self {
        let webhook_url = std::env::var("SLACK_WEBHOOK_URL").ok();
        let bot_token = std::env::var("SLACK_BOT_TOKEN").ok();

        Self {
            webhook_url,
            bot_token,
            client: reqwest::Client::new(),
        }
    }

    /// Check if Slack is configured
    pub fn is_configured(&self) -> bool {
        self.webhook_url.is_some() || self.bot_token.is_some()
    }

    /// Send a notification message to Slack
    pub async fn send_notification(&self, message: &SlackMessage) -> Result<()> {
        if let Some(webhook_url) = &self.webhook_url {
            self.client
                .post(webhook_url)
                .json(message)
                .send()
                .await
                .context("Failed to send Slack webhook notification")?;

            Ok(())
        } else if let Some(_bot_token) = &self.bot_token {
            // Use Slack API for posting messages
            // This would require channel ID
            tracing::warn!("Slack bot token provided but channel not specified");
            Ok(())
        } else {
            Err(anyhow::anyhow!("Slack not configured"))
        }
    }

    /// Notify about a new recording
    pub async fn notify_recording_complete(
        &self,
        recording_id: &str,
        title: &str,
        duration: i64,
    ) -> Result<()> {
        let message = SlackMessage {
            text: Some(format!("New recording completed: {}", title)),
            blocks: Some(vec![
                SlackBlock::header(&format!("New Recording: {}", title)),
                SlackBlock::section(&format!(
                    "*Duration:* {} seconds\n*ID:* {}",
                    duration, recording_id
                )),
            ]),
            ..Default::default()
        };

        self.send_notification(&message).await
    }

    /// Share transcript summary
    pub async fn share_transcript_summary(
        &self,
        title: &str,
        summary: &str,
        action_items: &[String],
    ) -> Result<()> {
        let actions_text = if action_items.is_empty() {
            "No action items identified.".to_string()
        } else {
            action_items
                .iter()
                .map(|item| format!("• {}", item))
                .collect::<Vec<_>>()
                .join("\n")
        };

        let message = SlackMessage {
            text: Some(format!("Meeting summary for {}", title)),
            blocks: Some(vec![
                SlackBlock::header(&format!("Meeting Summary: {}", title)),
                SlackBlock::section(&format!("*Summary:*\n{}", summary)),
                SlackBlock::section(&format!("*Action Items:*\n{}", actions_text)),
            ]),
            ..Default::default()
        };

        self.send_notification(&message).await
    }
}

impl Default for SlackClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Slack message payload
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SlackMessage {
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<SlackBlock>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<SlackAttachment>>,
}

/// Slack block element
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackBlock {
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<SlackText>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<SlackText>>,
}

impl SlackBlock {
    pub fn header(text: &str) -> Self {
        Self {
            r#type: "header".to_string(),
            text: Some(SlackText {
                r#type: "plain_text".to_string(),
                text: text.to_string(),
            }),
            fields: None,
        }
    }

    pub fn section(text: &str) -> Self {
        Self {
            r#type: "section".to_string(),
            text: Some(SlackText {
                r#type: "mrkdwn".to_string(),
                text: text.to_string(),
            }),
            fields: None,
        }
    }
}

/// Slack text element
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackText {
    pub r#type: String,
    pub text: String,
}

/// Slack attachment
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SlackAttachment {
    pub color: String,
    pub title: String,
    pub text: String,
}

/// Mantisbot API client for ticket creation
pub struct MantisbotClient {
    api_url: Option<String>,
    api_token: Option<String>,
    client: reqwest::Client,
}

impl MantisbotClient {
    /// Create a new Mantisbot client from environment variables
    pub fn new() -> Self {
        let api_url = std::env::var("MANTISBOT_API_URL").ok();
        let api_token = std::env::var("MANTISBOT_API_TOKEN").ok();

        Self {
            api_url,
            api_token,
            client: reqwest::Client::new(),
        }
    }

    /// Check if Mantisbot is configured
    pub fn is_configured(&self) -> bool {
        self.api_url.is_some() && self.api_token.is_some()
    }

    /// Create a ticket from action items
    pub async fn create_ticket_from_action_items(
        &self,
        meeting_title: &str,
        action_items: &[crate::llm::ActionItem],
    ) -> Result<Vec<String>> {
        if !self.is_configured() {
            return Err(anyhow::anyhow!("Mantisbot not configured"));
        }

        let api_url = self.api_url.as_ref().unwrap();
        let api_token = self.api_token.as_ref().unwrap();

        let mut ticket_ids = Vec::new();

        for item in action_items {
            let ticket = MantisTicket {
                summary: format!("[From {}] {}", meeting_title, item.task),
                description: format!(
                    "Action item from meeting: {}\n\nTask: {}\nAssignee: {}\nDeadline: {}",
                    meeting_title,
                    item.task,
                    item.assignee.as_deref().unwrap_or("Unassigned"),
                    item.deadline.as_deref().unwrap_or("Not specified")
                ),
                category: "Meeting Action Items".to_string(),
            };

            let response = self
                .client
                .post(format!("{}/tickets", api_url))
                .header("Authorization", format!("Bearer {}", api_token))
                .json(&ticket)
                .send()
                .await
                .context("Failed to create Mantis ticket")?;

            if response.status().is_success() {
                let result: MantisTicketResponse = response
                    .json()
                    .await
                    .context("Failed to parse Mantis response")?;
                let id = result.id.clone();
                ticket_ids.push(result.id);
                tracing::info!("Created Mantis ticket: {}", id);
            } else {
                tracing::warn!("Failed to create Mantis ticket: {}", response.status());
            }
        }

        Ok(ticket_ids)
    }
}

impl Default for MantisbotClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Mantis ticket payload
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MantisTicket {
    pub summary: String,
    pub description: String,
    pub category: String,
}

/// Mantis ticket response
#[derive(Debug, Clone, Deserialize)]
struct MantisTicketResponse {
    pub id: String,
}

/// Integration manager for handling both Slack and Mantisbot
pub struct IntegrationManager {
    pub slack: SlackClient,
    pub mantisbot: MantisbotClient,
}

impl IntegrationManager {
    pub fn new() -> Self {
        Self {
            slack: SlackClient::new(),
            mantisbot: MantisbotClient::new(),
        }
    }

    /// Check if any integrations are configured
    pub fn has_integrations(&self) -> bool {
        self.slack.is_configured() || self.mantisbot.is_configured()
    }

    /// Share meeting results to configured integrations
    pub async fn share_meeting_results(
        &self,
        _recording_id: &str,
        title: &str,
        summary: &str,
        action_items: &[crate::llm::ActionItem],
    ) -> Result<()> {
        // Send Slack notification
        if self.slack.is_configured() {
            let action_strings: Vec<String> =
                action_items.iter().map(|item| item.task.clone()).collect();

            if let Err(e) = self
                .slack
                .share_transcript_summary(title, summary, &action_strings)
                .await
            {
                tracing::warn!("Failed to send Slack notification: {}", e);
            }
        }

        // Create Mantis tickets for action items
        if self.mantisbot.is_configured() && !action_items.is_empty() {
            match self
                .mantisbot
                .create_ticket_from_action_items(title, action_items)
                .await
            {
                Ok(ticket_ids) => {
                    tracing::info!("Created {} Mantis tickets", ticket_ids.len());
                }
                Err(e) => {
                    tracing::warn!("Failed to create Mantis tickets: {}", e);
                }
            }
        }

        Ok(())
    }
}

impl Default for IntegrationManager {
    fn default() -> Self {
        Self::new()
    }
}
