use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::stores::StoredMessage;
use crate::workspace::{
    now_iso, provider_label, public_provider_entity_id, AgentCapabilities, AgentModel,
    AgentProviderStatus, ClientUpdateRow, StagedAttachmentEntry,
};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone)]
pub struct SendMessageRequest {
    pub thread_id: String,
    /// What the provider's record for this thread carries for Node if this send creates one.
    pub record_seed: ThreadRecordSeed,
    pub message_id: String,
    pub cwd: String,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub runtime_mode: Option<String>,
    pub text: String,
    pub command_id: String,
    pub draft_id: String,
    pub attachments: Vec<StagedAttachmentEntry>,
}

/// The thread facts a provider record this host creates carries so Node can read it after a rollback (ADR-0214).
/// Node's schema for every provider store requires `projectId`, `title` and `createdAt`, which a provider adapter has
/// no other way to know.
#[derive(Debug, Clone, Default)]
pub struct ThreadRecordSeed {
    pub project_id: String,
    pub title: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct SendMessageAck {
    pub message_id: String,
    pub turn_id: String,
    pub status: String,
    pub provider_latency_ms: u64,
}

#[derive(Debug, Clone)]
pub struct AnswerRequestInput {
    pub thread_id: String,
    pub request_id: String,
    pub answer: String,
    pub approved: Option<bool>,
    pub permission_choice: Option<String>,
    pub question_answers: Option<Value>,
    pub skipped: Option<bool>,
}

#[derive(Debug, Clone)]
pub enum ProviderEvent {
    StatusChanged {
        provider_id: String,
        status: AgentProviderStatus,
        models: Vec<AgentModel>,
        client_update: Option<ClientUpdateRow>,
    },
    TurnStarted {
        thread_id: String,
        turn_id: String,
        after_message_id: Option<String>,
        activity: Value,
    },
    MessageAdded {
        thread_id: String,
        message: StoredMessage,
    },
    MessageTextAppended {
        thread_id: String,
        message_id: String,
        append_text: String,
    },
    MessageReplaced {
        thread_id: String,
        message: StoredMessage,
    },
    ActivityUpserted {
        thread_id: String,
        activity: Value,
    },
    RequestOpened {
        thread_id: String,
        request: Value,
    },
    RequestCleared {
        thread_id: String,
        request_id: String,
    },
    TurnCompleted {
        thread_id: String,
        turn_id: String,
        status: String,
    },
}

/// Language-neutral provider adapter interface implemented by Codex, Claude Code, and held/mock
/// providers in `sotto-core`.
pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn is_held(&self) -> bool {
        false
    }
    fn status(&self) -> AgentProviderStatus;
    fn models(&self) -> Vec<AgentModel>;
    fn client_update(&self) -> Option<ClientUpdateRow> {
        None
    }

    fn connect(&self, events: mpsc::UnboundedSender<ProviderEvent>) -> BoxFuture<'_, Result<(), String>>;
    fn disconnect(&self) -> BoxFuture<'_, Result<(), String>>;

    fn create_thread(
        &self,
        thread_id: String,
        cwd: String,
        model_id: Option<String>,
        runtime_mode: Option<String>,
        reasoning_effort: Option<String>,
    ) -> BoxFuture<'_, Result<(), String>>;

    fn send_message(&self, req: SendMessageRequest) -> BoxFuture<'_, Result<SendMessageAck, String>>;

    fn answer_request(&self, req: AnswerRequestInput) -> BoxFuture<'_, Result<(), String>>;

    fn interrupt(&self, thread_id: String) -> BoxFuture<'_, Result<(), String>>;

    fn compact(&self, thread_id: String) -> BoxFuture<'_, Result<(), String>>;

    fn configure_thread(
        &self,
        _thread_id: String,
        _model_id: Option<String>,
        _runtime_mode: Option<String>,
        _reasoning_effort: Option<String>,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    /// Reads a thread's waiting questions and permissions from the provider again, as Node's host `refreshThread` reads a
    /// thread for an answer check (ADR-0025). `None` when the adapter has no read of its own: the questions it last
    /// reported are what it holds, so they stand. A failure's words are the adapter's and go no further than the host.
    fn read_thread_requests(&self, _thread_id: String) -> BoxFuture<'_, ThreadRequestsRead> {
        Box::pin(async { Ok(None) })
    }
}

/// Stand-in adapter for providers held by an Owl feature gate or inactive during a referee run.
pub struct HeldProviderAdapter {
    id: String,
    name: String,
}

impl HeldProviderAdapter {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            name: provider_label(id).to_string(),
        }
    }
}

impl ProviderAdapter for HeldProviderAdapter {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn is_held(&self) -> bool {
        true
    }

    fn status(&self) -> AgentProviderStatus {
        AgentProviderStatus::held(&self.id)
    }

    fn models(&self) -> Vec<AgentModel> {
        Vec::new()
    }

    fn connect(&self, _events: mpsc::UnboundedSender<ProviderEvent>) -> BoxFuture<'_, Result<(), String>> {
        let msg = format!("{} is available in Sotto Owl; it is not in this build.", self.name);
        Box::pin(async move { Err(msg) })
    }

    fn disconnect(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn create_thread(
        &self,
        _thread_id: String,
        _cwd: String,
        _model_id: Option<String>,
        _runtime_mode: Option<String>,
        _reasoning_effort: Option<String>,
    ) -> BoxFuture<'_, Result<(), String>> {
        let msg = format!("{} is available in Sotto Owl; it is not in this build.", self.name);
        Box::pin(async move { Err(msg) })
    }

    fn send_message(&self, _req: SendMessageRequest) -> BoxFuture<'_, Result<SendMessageAck, String>> {
        let msg = format!("{} is available in Sotto Owl; it is not in this build.", self.name);
        Box::pin(async move { Err(msg) })
    }

    fn answer_request(&self, _req: AnswerRequestInput) -> BoxFuture<'_, Result<(), String>> {
        let msg = format!("{} is available in Sotto Owl; it is not in this build.", self.name);
        Box::pin(async move { Err(msg) })
    }

    fn interrupt(&self, _thread_id: String) -> BoxFuture<'_, Result<(), String>> {
        let msg = format!("{} is available in Sotto Owl; it is not in this build.", self.name);
        Box::pin(async move { Err(msg) })
    }

    fn compact(&self, _thread_id: String) -> BoxFuture<'_, Result<(), String>> {
        let msg = format!("{} is available in Sotto Owl; it is not in this build.", self.name);
        Box::pin(async move { Err(msg) })
    }
}

/// Deterministic in-memory provider used by Rust unit and protocol v1 socket tests.
pub struct MockProviderAdapter {
    id: String,
    name: String,
    version: String,
    connected: Arc<Mutex<bool>>,
    events_tx: Arc<Mutex<Option<mpsc::UnboundedSender<ProviderEvent>>>>,
    active_turns: Arc<Mutex<std::collections::HashMap<String, String>>>,
    /// The next thread read, held until a test answers it.
    held_read: Arc<Mutex<Option<HeldReadEnds>>>,
}

/// The adapter's ends of a held read: it tells the test the read began, and waits for what the read returns.
type HeldReadEnds = (oneshot::Sender<()>, oneshot::Receiver<ThreadRequestsRead>);

/// What a provider's read of a thread's waiting requests returns.
pub type ThreadRequestsRead = Result<Option<Vec<Value>>, String>;

/// A mock thread read a test holds: `started` is told once the host asks, and the read returns what `finish` sends.
pub struct HeldThreadRead {
    pub started: oneshot::Receiver<()>,
    pub finish: oneshot::Sender<ThreadRequestsRead>,
}

impl MockProviderAdapter {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            name: provider_label(id).to_string(),
            version: format!("{id}/0.154.0"),
            connected: Arc::new(Mutex::new(false)),
            events_tx: Arc::new(Mutex::new(None)),
            active_turns: Arc::new(Mutex::new(std::collections::HashMap::new())),
            held_read: Arc::new(Mutex::new(None)),
        }
    }

    /// Holds the next `read_thread_requests` until the test sends what it returns.
    pub fn hold_next_thread_read(&self) -> HeldThreadRead {
        let (started_tx, started) = oneshot::channel();
        let (finish, finish_rx) = oneshot::channel();
        *self.held_read.lock().unwrap() = Some((started_tx, finish_rx));
        HeldThreadRead { started, finish }
    }

    pub fn complete_turn(&self, thread_id: &str, reply_text: &str) {
        let turn_id = self
            .active_turns
            .lock()
            .unwrap()
            .remove(thread_id)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        if let Some(tx) = self.events_tx.lock().unwrap().as_ref() {
            let msg_id = Uuid::new_v4().to_string();
            let now = now_iso();
            let _ = tx.send(ProviderEvent::MessageAdded {
                thread_id: thread_id.to_string(),
                message: StoredMessage {
                    id: msg_id,
                    role: "assistant".into(),
                    text: reply_text.to_string(),
                    created_at: now.clone(),
                    command_id: None,
                    turn_message_id: None,
                    attachments: None,
                    watcher_own_change: None,
                    watcher_observed_changes: None,
                    provider_error: None,
                },
            });
            let _ = tx.send(ProviderEvent::TurnCompleted {
                thread_id: thread_id.to_string(),
                turn_id,
                status: "completed".into(),
            });
        }
    }

    /// Ends the thread's running turn as failed, with no reply.
    pub fn fail_turn(&self, thread_id: &str) {
        let turn_id = self
            .active_turns
            .lock()
            .unwrap()
            .remove(thread_id)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        if let Some(tx) = self.events_tx.lock().unwrap().as_ref() {
            let _ = tx.send(ProviderEvent::TurnCompleted {
                thread_id: thread_id.to_string(),
                turn_id,
                status: "failed".into(),
            });
        }
    }

    pub fn emit_request(&self, thread_id: &str, request: Value) {
        if let Some(tx) = self.events_tx.lock().unwrap().as_ref() {
            let _ = tx.send(ProviderEvent::RequestOpened {
                thread_id: thread_id.to_string(),
                request,
            });
        }
    }
}

impl ProviderAdapter for MockProviderAdapter {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn status(&self) -> AgentProviderStatus {
        let connected = *self.connected.lock().unwrap();
        AgentProviderStatus {
            id: self.id.clone(),
            name: self.name.clone(),
            connection: if connected { "connected" } else { "disconnected" }.into(),
            version: self.version.clone(),
            capabilities: AgentCapabilities::full(),
            error: None,
        }
    }

    fn models(&self) -> Vec<AgentModel> {
        vec![AgentModel {
            id: public_provider_entity_id(&self.id, "model", "fixture-model"),
            name: format!("Fixture {}", self.name),
            provider: self.name.clone(),
            provider_id: self.id.clone(),
            ready: true,
            default_reasoning_effort: Some("low".into()),
            reasoning_efforts: Some(vec!["low".into(), "high".into()]),
            runtime_modes: Some(vec![
                "approval-required".into(),
                "auto-accept-edits".into(),
                "auto".into(),
                "full-access".into(),
            ]),
            provider_modes: None,
            supports_images: Some(true),
        }]
    }

    fn client_update(&self) -> Option<ClientUpdateRow> {
        Some(ClientUpdateRow {
            id: self.id.clone(),
            installed: "0.154.0".into(),
            behind: false,
            can_install: false,
            channel: "unknown".into(),
            state: "idle".into(),
            checked_at: Some(now_iso()),
        })
    }

    fn connect(&self, events: mpsc::UnboundedSender<ProviderEvent>) -> BoxFuture<'_, Result<(), String>> {
        *self.connected.lock().unwrap() = true;
        *self.events_tx.lock().unwrap() = Some(events.clone());
        let status = self.status();
        let models = self.models();
        let update = self.client_update();
        let provider_id = self.id.clone();
        Box::pin(async move {
            let _ = events.send(ProviderEvent::StatusChanged {
                provider_id,
                status,
                models,
                client_update: update,
            });
            Ok(())
        })
    }

    fn disconnect(&self) -> BoxFuture<'_, Result<(), String>> {
        *self.connected.lock().unwrap() = false;
        Box::pin(async { Ok(()) })
    }

    fn create_thread(
        &self,
        _thread_id: String,
        _cwd: String,
        _model_id: Option<String>,
        _runtime_mode: Option<String>,
        _reasoning_effort: Option<String>,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn send_message(&self, req: SendMessageRequest) -> BoxFuture<'_, Result<SendMessageAck, String>> {
        let message_id = req.message_id;
        let turn_id = Uuid::new_v4().to_string();
        self.active_turns
            .lock()
            .unwrap()
            .insert(req.thread_id.clone(), turn_id.clone());
        let tx = self.events_tx.lock().unwrap().clone();
        let id_prefix = self.id.clone();
        Box::pin(async move {
            if let Some(tx) = tx {
                let activity = json!({
                    "id": format!("{id_prefix}-activity-{}", Uuid::new_v4()),
                    "kind": "turn",
                    "sequence": 0,
                    "startedAt": now_iso(),
                    "status": "running",
                    "timingSource": "provider",
                    "title": "Working",
                    "turnId": turn_id,
                    "afterMessageId": message_id,
                });
                let _ = tx.send(ProviderEvent::TurnStarted {
                    thread_id: req.thread_id,
                    turn_id: turn_id.clone(),
                    after_message_id: Some(message_id.clone()),
                    activity,
                });
            }
            Ok(SendMessageAck {
                message_id,
                turn_id,
                status: "accepted".into(),
                provider_latency_ms: 1,
            })
        })
    }

    fn answer_request(&self, req: AnswerRequestInput) -> BoxFuture<'_, Result<(), String>> {
        let tx = self.events_tx.lock().unwrap().clone();
        Box::pin(async move {
            if let Some(tx) = tx {
                let _ = tx.send(ProviderEvent::RequestCleared {
                    thread_id: req.thread_id,
                    request_id: req.request_id,
                });
            }
            Ok(())
        })
    }

    fn interrupt(&self, thread_id: String) -> BoxFuture<'_, Result<(), String>> {
        let turn_id = self
            .active_turns
            .lock()
            .unwrap()
            .remove(&thread_id)
            .unwrap_or_default();
        let tx = self.events_tx.lock().unwrap().clone();
        Box::pin(async move {
            if let Some(tx) = tx {
                let _ = tx.send(ProviderEvent::TurnCompleted {
                    thread_id,
                    turn_id,
                    status: "interrupted".into(),
                });
            }
            Ok(())
        })
    }

    fn compact(&self, _thread_id: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn read_thread_requests(&self, _thread_id: String) -> BoxFuture<'_, ThreadRequestsRead> {
        let held = self.held_read.lock().unwrap().take();
        Box::pin(async move {
            let Some((started, finish)) = held else {
                return Ok(None);
            };
            let _ = started.send(());
            finish.await.unwrap_or(Ok(None))
        })
    }
}
