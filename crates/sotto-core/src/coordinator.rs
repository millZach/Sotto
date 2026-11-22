use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, mpsc, oneshot};
use uuid::Uuid;

use crate::protocol::HostErrorCode;
use crate::provider::{
    AnswerRequestInput, HeldProviderAdapter, ProviderAdapter, ProviderEvent, SendMessageRequest,
};
use crate::remote_commands::validate_remote_command;
use crate::stores::{
    StoredMessage, StoredThreadEvent, ThreadEvent, ThreadEventAttribution, ThreadStore,
};
use crate::workspace::{
    now_iso, parse_public_provider_entity_id, provider_label, summarize_thread, write_atomic_json,
    AgentCapabilities, AgentConfiguration, AgentDelivery, AgentModel, AgentProject,
    AgentProviderStatus, AgentThread, AgentThreadDetail, AgentThreadWorktree, AgentTurnRecord,
    ClientUpdateRow, DeliveredDraft, StagedAttachmentHandle, StagedAttachments, ACTIVE_PROVIDERS,
};

const PUBLISH_COALESCE_MS: u64 = 50;

#[derive(Debug, Clone)]
pub struct ClientContext {
    pub client_id: String,
    pub user: String,
    pub may_answer: bool,
}

#[derive(Debug, Clone)]
pub struct CoordinatorError {
    pub code: HostErrorCode,
    pub message: String,
}

impl CoordinatorError {
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self {
            code: HostErrorCode::InvalidRequest,
            message: msg.into(),
        }
    }

    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self {
            code: HostErrorCode::Forbidden,
            message: msg.into(),
        }
    }

    pub fn stale(msg: impl Into<String>) -> Self {
        Self {
            code: HostErrorCode::StaleRequest,
            message: msg.into(),
        }
    }

    pub fn unavailable(msg: impl Into<String>) -> Self {
        Self {
            code: HostErrorCode::Unavailable,
            message: msg.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub enum CoordinatorBroadcast {
    Shell(Value),
    Detail(AgentThreadDetail),
}

enum ActorMessage {
    GetShell {
        may_answer: bool,
        reply: oneshot::Sender<Value>,
    },
    GetDetail {
        thread_id: String,
        reply: oneshot::Sender<Option<AgentThreadDetail>>,
    },
    ReadEvents {
        thread_id: Option<String>,
        after_seq: i64,
        limit: usize,
        reply: oneshot::Sender<(Vec<StoredThreadEvent>, bool, i64)>,
    },
    ObserveThreads {
        thread_ids: Vec<String>,
        reply: oneshot::Sender<Vec<(String, Option<AgentThreadDetail>)>>,
    },
    StageImage {
        name: String,
        mime_type: String,
        data_b64: String,
        reply: oneshot::Sender<Result<StagedAttachmentHandle, CoordinatorError>>,
    },
    StageFilePart {
        upload_id: String,
        index: usize,
        count: usize,
        name: String,
        mime_type: String,
        size_bytes: usize,
        digest: String,
        data_b64: String,
        reply: oneshot::Sender<Result<Option<StagedAttachmentHandle>, CoordinatorError>>,
    },
    RunCommand {
        client: ClientContext,
        command: Map<String, Value>,
        reply: oneshot::Sender<Result<Value, CoordinatorError>>,
    },
    GitStatusReady {
        thread_id: String,
        git: Value,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

/// Cloneable handle to the single-owner Coordinator actor.
#[derive(Clone)]
pub struct CoordinatorHandle {
    tx: mpsc::UnboundedSender<ActorMessage>,
    broadcast_tx: broadcast::Sender<CoordinatorBroadcast>,
}

impl CoordinatorHandle {
    pub fn spawn(
        data_directory: PathBuf,
        host_id: String,
        credentials_secure: bool,
        providers: BTreeMap<String, Arc<dyn ProviderAdapter>>,
    ) -> Result<Self, String> {
        let threads_store = ThreadStore::open(&data_directory.join("threads.sqlite"))
            .map_err(|e| format!("Could not open threads.sqlite: {e}"))?;
        let (tx, rx) = mpsc::unbounded_channel();
        let (provider_tx, provider_rx) = mpsc::unbounded_channel();
        let (broadcast_tx, _) = broadcast::channel(512);

        let mut full_providers: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
        for &id in ACTIVE_PROVIDERS {
            if let Some(p) = providers.get(id) {
                full_providers.insert(id.to_string(), Arc::clone(p));
            } else {
                full_providers.insert(id.to_string(), Arc::new(HeldProviderAdapter::new(id)));
            }
        }

        let actor = CoordinatorActor::new(
            data_directory,
            host_id,
            credentials_secure,
            threads_store,
            full_providers,
            provider_tx,
            tx.clone(),
            broadcast_tx.clone(),
        );

        tokio::spawn(actor.run(rx, provider_rx));
        Ok(Self { tx, broadcast_tx })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CoordinatorBroadcast> {
        self.broadcast_tx.subscribe()
    }

    pub async fn shell(&self, may_answer: bool) -> Result<Value, CoordinatorError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMessage::GetShell {
                may_answer,
                reply: reply_tx,
            })
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))?;
        reply_rx
            .await
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))
    }

    pub async fn detail(&self, thread_id: String) -> Result<Option<AgentThreadDetail>, CoordinatorError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMessage::GetDetail {
                thread_id,
                reply: reply_tx,
            })
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))?;
        reply_rx
            .await
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))
    }

    pub async fn events(
        &self,
        thread_id: Option<String>,
        after_seq: i64,
        limit: usize,
    ) -> Result<(Vec<StoredThreadEvent>, bool, i64), CoordinatorError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMessage::ReadEvents {
                thread_id,
                after_seq,
                limit,
                reply: reply_tx,
            })
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))?;
        reply_rx
            .await
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))
    }

    pub async fn observe(
        &self,
        thread_ids: Vec<String>,
    ) -> Result<Vec<(String, Option<AgentThreadDetail>)>, CoordinatorError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMessage::ObserveThreads {
                thread_ids,
                reply: reply_tx,
            })
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))?;
        reply_rx
            .await
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))
    }

    pub async fn stage_image(
        &self,
        name: String,
        mime_type: String,
        data_b64: String,
    ) -> Result<StagedAttachmentHandle, CoordinatorError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMessage::StageImage {
                name,
                mime_type,
                data_b64,
                reply: reply_tx,
            })
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))?;
        reply_rx
            .await
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn stage_file_part(
        &self,
        upload_id: String,
        index: usize,
        count: usize,
        name: String,
        mime_type: String,
        size_bytes: usize,
        digest: String,
        data_b64: String,
    ) -> Result<Option<StagedAttachmentHandle>, CoordinatorError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMessage::StageFilePart {
                upload_id,
                index,
                count,
                name,
                mime_type,
                size_bytes,
                digest,
                data_b64,
                reply: reply_tx,
            })
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))?;
        reply_rx
            .await
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))?
    }

    pub async fn run_command(
        &self,
        client: ClientContext,
        command: Map<String, Value>,
    ) -> Result<Value, CoordinatorError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMessage::RunCommand {
                client,
                command,
                reply: reply_tx,
            })
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))?;
        reply_rx
            .await
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))?
    }

    pub async fn shutdown(&self) {
        let (reply_tx, reply_rx) = oneshot::channel();
        if self.tx.send(ActorMessage::Shutdown { reply: reply_tx }).is_ok() {
            let _ = reply_rx.await;
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedWorkspace {
    #[serde(default)]
    projects: Vec<AgentProject>,
    #[serde(default)]
    threads: Vec<AgentThread>,
    #[serde(default)]
    configuration: AgentConfiguration,
}

struct CoordinatorActor {
    data_directory: PathBuf,
    host_id: String,
    credentials_secure: bool,
    thread_store: ThreadStore,
    providers: BTreeMap<String, Arc<dyn ProviderAdapter>>,
    provider_events_tx: mpsc::UnboundedSender<ProviderEvent>,
    self_tx: mpsc::UnboundedSender<ActorMessage>,
    broadcast_tx: broadcast::Sender<CoordinatorBroadcast>,

    configuration: AgentConfiguration,
    active_project_id: Option<String>,
    active_thread_id: Option<String>,
    projects: Vec<AgentProject>,
    threads: Vec<AgentThread>,
    details: HashMap<String, AgentThreadDetail>,
    deliveries: Vec<AgentDelivery>,
    delivered_drafts: Vec<DeliveredDraft>,
    provider_statuses: BTreeMap<String, AgentProviderStatus>,
    models: Vec<AgentModel>,
    models_revision: u64,
    client_updates: Vec<ClientUpdateRow>,
    notice: Option<String>,
    error: Option<String>,
    global_lane_busy: bool,
    busy_thread_ids: HashSet<String>,
    staged: StagedAttachments,

    shell_dirty: bool,
    dirty_details: HashSet<String>,
}

impl CoordinatorActor {
    #[allow(clippy::too_many_arguments)]
    fn new(
        data_directory: PathBuf,
        host_id: String,
        credentials_secure: bool,
        thread_store: ThreadStore,
        providers: BTreeMap<String, Arc<dyn ProviderAdapter>>,
        provider_events_tx: mpsc::UnboundedSender<ProviderEvent>,
        self_tx: mpsc::UnboundedSender<ActorMessage>,
        broadcast_tx: broadcast::Sender<CoordinatorBroadcast>,
    ) -> Self {
        let persisted = load_persisted_workspace(&data_directory);
        let mut provider_statuses = BTreeMap::new();
        let mut models = Vec::new();
        let mut client_updates = Vec::new();
        for (id, adapter) in &providers {
            provider_statuses.insert(id.clone(), adapter.status());
            models.extend(adapter.models());
            if let Some(upd) = adapter.client_update() {
                client_updates.push(upd);
            }
        }

        let mut details = HashMap::new();
        for thread in &persisted.threads {
            let messages = thread_store.read_messages(&thread.id).unwrap_or_default();
            let activities = thread_store
                .read_activities(&thread.id)
                .unwrap_or_default()
                .into_iter()
                .map(|a| a.payload)
                .collect();
            details.insert(
                thread.id.clone(),
                AgentThreadDetail {
                    thread_id: thread.id.clone(),
                    revision: 1,
                    messages,
                    activities,
                    earlier_available: None,
                },
            );
        }

        let staged = StagedAttachments::new(&data_directory);
        Self {
            data_directory,
            host_id,
            credentials_secure,
            thread_store,
            providers,
            provider_events_tx,
            self_tx,
            broadcast_tx,
            configuration: persisted.configuration,
            active_project_id: None,
            active_thread_id: None,
            projects: persisted.projects,
            threads: persisted.threads,
            details,
            deliveries: Vec::new(),
            delivered_drafts: Vec::new(),
            provider_statuses,
            models,
            models_revision: 1,
            client_updates,
            notice: None,
            error: None,
            global_lane_busy: false,
            busy_thread_ids: HashSet::new(),
            staged,
            shell_dirty: false,
            dirty_details: HashSet::new(),
        }
    }

    async fn run(
        mut self,
        mut rx: mpsc::UnboundedReceiver<ActorMessage>,
        mut provider_rx: mpsc::UnboundedReceiver<ProviderEvent>,
    ) {
        // Connect every non-held provider at startup (ADR-0036).
        for adapter in self.providers.values() {
            if !adapter.is_held() {
                let _ = adapter.connect(self.provider_events_tx.clone()).await;
            }
        }
        self.rebuild_catalog();

        let mut flush_tick = tokio::time::interval(Duration::from_millis(PUBLISH_COALESCE_MS));
        flush_tick.tick().await;

        loop {
            tokio::select! {
                Some(msg) = rx.recv() => {
                    match msg {
                        ActorMessage::Shutdown { reply } => {
                            for adapter in self.providers.values() {
                                let _ = adapter.disconnect().await;
                            }
                            self.save_workspace();
                            let _ = reply.send(());
                            break;
                        }
                        other => {
                            self.handle_actor_message(other).await;
                        }
                    }
                }
                Some(ev) = provider_rx.recv() => {
                    self.handle_provider_event(ev);
                }
                _ = flush_tick.tick() => {
                    self.flush_dirty();
                }
            }
        }
    }

    async fn handle_actor_message(&mut self, msg: ActorMessage) {
        match msg {
            ActorMessage::GetShell { may_answer, reply } => {
                let _ = reply.send(self.build_shell(may_answer));
            }
            ActorMessage::GetDetail { thread_id, reply } => {
                let detail = self.details.get(&thread_id).cloned().or_else(|| {
                    let messages = self.thread_store.read_messages(&thread_id).unwrap_or_default();
                    let activities: Vec<Value> = self
                        .thread_store
                        .read_activities(&thread_id)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|a| a.payload)
                        .collect();
                    if messages.is_empty() && activities.is_empty() {
                        None
                    } else {
                        Some(AgentThreadDetail {
                            thread_id: thread_id.clone(),
                            revision: 1,
                            messages,
                            activities,
                            earlier_available: None,
                        })
                    }
                });
                let _ = reply.send(detail);
            }
            ActorMessage::ReadEvents {
                thread_id,
                after_seq,
                limit,
                reply,
            } => {
                let latest = self.thread_store.latest_seq().unwrap_or(0);
                let (events, has_more) = self
                    .thread_store
                    .read_events(thread_id.as_deref(), after_seq, limit)
                    .unwrap_or_default();
                let _ = reply.send((events, has_more, latest));
            }
            ActorMessage::ObserveThreads { thread_ids, reply } => {
                let mut out = Vec::with_capacity(thread_ids.len());
                for tid in &thread_ids {
                    if let Some(thread) = self.threads.iter().find(|t| t.id == *tid) {
                        if let Some(ref wt) = thread.worktree {
                            if wt.git.is_none() {
                                let path = wt.path.clone();
                                let thread_id = tid.clone();
                                let tx = self.self_tx.clone();
                                tokio::task::spawn_blocking(move || {
                                    let git = probe_git_worktree(&path);
                                    let _ = tx.send(ActorMessage::GitStatusReady { thread_id, git });
                                });
                            }
                        }
                    }
                    out.push((tid.clone(), self.details.get(tid).cloned()));
                }
                let _ = reply.send(out);
            }
            ActorMessage::StageImage {
                name,
                mime_type,
                data_b64,
                reply,
            } => {
                let res = self
                    .staged
                    .stage_image(&name, &mime_type, &data_b64)
                    .map_err(CoordinatorError::invalid);
                let _ = reply.send(res);
            }
            ActorMessage::StageFilePart {
                upload_id,
                index,
                count,
                name,
                mime_type,
                size_bytes,
                digest,
                data_b64,
                reply,
            } => {
                let res = self
                    .staged
                    .stage_file_part(
                        &upload_id,
                        index,
                        count,
                        &name,
                        &mime_type,
                        size_bytes,
                        &digest,
                        &data_b64,
                    )
                    .map_err(CoordinatorError::invalid);
                let _ = reply.send(res);
            }
            ActorMessage::GitStatusReady { thread_id, git } => {
                if let Some(thread) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    if let Some(ref mut wt) = thread.worktree {
                        wt.git = Some(git);
                        self.shell_dirty = true;
                        self.flush_dirty();
                    }
                }
            }
            ActorMessage::RunCommand {
                client,
                command,
                reply,
            } => {
                let res = self.execute_command(&client, &command).await;
                let _ = reply.send(res);
                self.flush_dirty();
            }
            ActorMessage::Shutdown { .. } => unreachable!(),
        }
    }

    async fn execute_command(
        &mut self,
        client: &ClientContext,
        command: &Map<String, Value>,
    ) -> Result<Value, CoordinatorError> {
        let cmd_type = match validate_remote_command(command, client.may_answer) {
            Ok(t) => t,
            Err(refusal) => {
                return Err(CoordinatorError {
                    code: refusal.code,
                    message: refusal
                        .message
                        .unwrap_or_else(|| refusal.code.default_message().to_string()),
                });
            }
        };

        let thread_lane = command
            .get("threadId")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        if let Some(ref tid) = thread_lane {
            self.busy_thread_ids.insert(tid.clone());
        } else {
            self.global_lane_busy = true;
        }

        let outcome = match cmd_type {
            "configure" => self.cmd_configure(command).await,
            "connect" => self.cmd_connect(command).await,
            "disconnect" => self.cmd_disconnect(command).await,
            "refresh" => self.cmd_refresh(command).await,
            "create-project" => self.cmd_create_project(command),
            "select-project" => {
                self.active_project_id = command
                    .get("projectId")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                Ok(())
            }
            "create-thread" => self.cmd_create_thread(command).await,
            "select-thread" => {
                self.active_thread_id = command
                    .get("threadId")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                Ok(())
            }
            "rename-thread" => self.cmd_rename_thread(command),
            "settle-thread" => self.cmd_settle_thread(command, true),
            "restore-thread" => self.cmd_settle_thread(command, false),
            "configure-thread" => self.cmd_configure_thread(command),
            "manual-send" => self.cmd_manual_send(command).await,
            "answer" => self.cmd_answer(client, command).await,
            "interrupt" => self.cmd_interrupt(command).await,
            "compact-thread" => self.cmd_compact(command).await,
            "observe-threads" => Ok(()),
            _ => Err(CoordinatorError::invalid(
                HostErrorCode::InvalidRequest.default_message(),
            )),
        };

        if let Some(ref tid) = thread_lane {
            self.busy_thread_ids.remove(tid);
        } else {
            self.global_lane_busy = false;
        }
        self.shell_dirty = true;

        outcome?;
        Ok(self.build_shell(client.may_answer))
    }

    async fn cmd_configure(&mut self, command: &Map<String, Value>) -> Result<(), CoordinatorError> {
        let Some(patch) = command.get("patch").and_then(Value::as_object) else {
            return Err(CoordinatorError::invalid("Configure needs a patch object."));
        };
        self.configuration.apply_patch(patch);
        self.save_workspace();
        Ok(())
    }

    async fn cmd_connect(&mut self, command: &Map<String, Value>) -> Result<(), CoordinatorError> {
        let provider_id = command
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or(&self.configuration.provider)
            .to_string();
        let suppress_notice = command.get("notice") == Some(&Value::Bool(false));
        let Some(adapter) = self.providers.get(&provider_id).cloned() else {
            return Err(CoordinatorError::invalid("Unknown provider."));
        };
        match adapter.connect(self.provider_events_tx.clone()).await {
            Ok(()) => {
                self.provider_statuses
                    .insert(provider_id.clone(), adapter.status());
                self.rebuild_catalog();
                if !suppress_notice {
                    self.notice = Some(format!("{} connected", adapter.name()));
                }
                self.error = None;
                Ok(())
            }
            Err(err) => {
                self.provider_statuses
                    .insert(provider_id, adapter.status());
                self.error = Some(err.clone());
                Err(CoordinatorError::unavailable(err))
            }
        }
    }

    async fn cmd_disconnect(&mut self, command: &Map<String, Value>) -> Result<(), CoordinatorError> {
        let provider_id = command
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or(&self.configuration.provider)
            .to_string();
        if let Some(adapter) = self.providers.get(&provider_id).cloned() {
            let _ = adapter.disconnect().await;
            self.provider_statuses.insert(provider_id, adapter.status());
            self.rebuild_catalog();
        }
        Ok(())
    }

    async fn cmd_refresh(&mut self, command: &Map<String, Value>) -> Result<(), CoordinatorError> {
        let provider_id = command
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or(&self.configuration.provider)
            .to_string();
        if let Some(adapter) = self.providers.get(&provider_id).cloned() {
            self.provider_statuses.insert(provider_id, adapter.status());
            self.rebuild_catalog();
        }
        Ok(())
    }

    fn cmd_create_project(&mut self, command: &Map<String, Value>) -> Result<(), CoordinatorError> {
        let provider = command
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or(&self.configuration.provider)
            .to_string();
        let Some(title) = command.get("title").and_then(Value::as_str) else {
            return Err(CoordinatorError::invalid("Project title is required."));
        };
        let Some(path) = command.get("path").and_then(Value::as_str) else {
            return Err(CoordinatorError::invalid("Project path is required."));
        };
        let id = Uuid::new_v4().to_string();
        let project = AgentProject {
            id: id.clone(),
            title: title.to_string(),
            path: path.to_string(),
            host_id: Some(self.host_id.clone()),
            provider_id: Some(provider),
            workspace_settled_at: None,
        };
        self.projects.push(project);
        self.active_project_id = Some(id);
        self.save_workspace();
        Ok(())
    }

    async fn cmd_create_thread(&mut self, command: &Map<String, Value>) -> Result<(), CoordinatorError> {
        let Some(project_id) = command.get("projectId").and_then(Value::as_str) else {
            return Err(CoordinatorError::invalid("Thread projectId is required."));
        };
        let Some(project) = self.projects.iter().find(|p| p.id == project_id).cloned() else {
            return Err(CoordinatorError::invalid("Unknown project."));
        };
        let model_id = command
            .get("modelId")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let provider_id = model_id
            .as_deref()
            .and_then(parse_public_provider_entity_id)
            .map(|(prov, _, _)| prov.to_string())
            .or_else(|| project.provider_id.clone())
            .unwrap_or_else(|| self.configuration.provider.clone());
        let thread_id = command
            .get("threadId")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let title = command
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("New thread")
            .to_string();
        let title_source = command
            .get("titleSource")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let runtime_mode = command
            .get("runtimeMode")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let reasoning_effort = command
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let provider_mode = command
            .get("providerMode")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let working_copy = command
            .get("workingCopy")
            .and_then(Value::as_str)
            .unwrap_or("shared")
            .to_string();

        if let Some(adapter) = self.providers.get(&provider_id).cloned() {
            if !adapter.is_held() {
                adapter
                    .create_thread(
                        thread_id.clone(),
                        project.path.clone(),
                        model_id.clone(),
                        runtime_mode.clone(),
                        reasoning_effort.clone(),
                    )
                    .await
                    .map_err(CoordinatorError::unavailable)?;
            }
        }

        let now = now_iso();
        let thread = AgentThread {
            id: thread_id.clone(),
            project_id: project.id,
            provider_id,
            title,
            title_source,
            kind: Some("project".into()),
            status: "idle".into(),
            model_id,
            reasoning_effort,
            runtime_mode,
            provider_mode,
            native_session_started: false,
            created_at: now.clone(),
            updated_at: now,
            settled_at: None,
            last_user_message_id: None,
            last_turn: None,
            requests: Vec::new(),
            activities: Vec::new(),
            summary: summarize_thread(&[], &[], "idle"),
            worktree: Some(AgentThreadWorktree {
                mode: working_copy,
                path: project.path,
                git: None,
            }),
        };
        self.threads.push(thread);
        let detail = AgentThreadDetail {
            thread_id: thread_id.clone(),
            revision: 1,
            messages: Vec::new(),
            activities: Vec::new(),
            earlier_available: None,
        };
        self.details.insert(thread_id.clone(), detail);
        self.active_thread_id = Some(thread_id);
        self.save_workspace();
        Ok(())
    }

    fn cmd_rename_thread(&mut self, command: &Map<String, Value>) -> Result<(), CoordinatorError> {
        let Some(tid) = command.get("threadId").and_then(Value::as_str) else {
            return Err(CoordinatorError::invalid("threadId is required."));
        };
        let Some(title) = command.get("title").and_then(Value::as_str) else {
            return Err(CoordinatorError::invalid("title is required."));
        };
        let Some(thread) = self.threads.iter_mut().find(|t| t.id == tid) else {
            return Err(CoordinatorError::invalid("Unknown thread."));
        };
        thread.title = title.to_string();
        thread.title_source = Some("user".into());
        thread.updated_at = now_iso();
        self.save_workspace();
        Ok(())
    }

    fn cmd_settle_thread(
        &mut self,
        command: &Map<String, Value>,
        settle: bool,
    ) -> Result<(), CoordinatorError> {
        let Some(tid) = command.get("threadId").and_then(Value::as_str) else {
            return Err(CoordinatorError::invalid("threadId is required."));
        };
        let Some(thread) = self.threads.iter_mut().find(|t| t.id == tid) else {
            return Err(CoordinatorError::invalid("Unknown thread."));
        };
        thread.settled_at = settle.then(now_iso);
        thread.updated_at = now_iso();
        self.save_workspace();
        Ok(())
    }

    fn cmd_configure_thread(&mut self, command: &Map<String, Value>) -> Result<(), CoordinatorError> {
        let Some(tid) = command.get("threadId").and_then(Value::as_str) else {
            return Err(CoordinatorError::invalid("threadId is required."));
        };
        let Some(thread) = self.threads.iter_mut().find(|t| t.id == tid) else {
            return Err(CoordinatorError::invalid("Unknown thread."));
        };
        if let Some(m) = command.get("modelId").and_then(Value::as_str) {
            thread.model_id = Some(m.to_string());
        }
        if let Some(e) = command.get("reasoningEffort").and_then(Value::as_str) {
            thread.reasoning_effort = Some(e.to_string());
        }
        if let Some(r) = command.get("runtimeMode").and_then(Value::as_str) {
            thread.runtime_mode = Some(r.to_string());
        }
        if let Some(p) = command.get("providerMode").and_then(Value::as_str) {
            thread.provider_mode = Some(p.to_string());
        }
        thread.updated_at = now_iso();
        self.save_workspace();
        Ok(())
    }

    async fn cmd_manual_send(&mut self, command: &Map<String, Value>) -> Result<(), CoordinatorError> {
        let Some(tid) = command.get("threadId").and_then(Value::as_str) else {
            return Err(CoordinatorError::invalid("threadId is required."));
        };
        let text = command
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let draft_id = command
            .get("draftId")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let command_id = Uuid::new_v4().to_string();

        let Some(thread) = self.threads.iter().find(|t| t.id == tid).cloned() else {
            return Err(CoordinatorError::invalid("Unknown thread."));
        };

        let mut attachments = Vec::new();
        if let Some(arr) = command.get("attachments").and_then(Value::as_array) {
            for item in arr {
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    if let Some(entry) = self.staged.get(id) {
                        attachments.push(entry.clone());
                    }
                }
            }
        }

        // Reject image attachments if the thread's model explicitly declares `supportsImages: false`.
        let has_image = attachments.iter().any(|a| a.handle.kind == "image");
        if has_image {
            let supports_images = thread
                .model_id
                .as_deref()
                .and_then(|mid| self.models.iter().find(|m| m.id == mid))
                .and_then(|m| m.supports_images)
                .unwrap_or(true);
            if !supports_images {
                let now = now_iso();
                self.deliveries.push(AgentDelivery {
                    command_id,
                    draft_id,
                    thread_id: tid.to_string(),
                    message_id: None,
                    status: "failed".into(),
                    error: Some("The selected model does not read images. Nothing was sent.".into()),
                    created_at: now.clone(),
                    updated_at: now,
                    local_feedback_ms: Some(0),
                    provider_latency_ms: None,
                });
                self.error = Some("The selected model does not read images. Nothing was sent.".into());
                return Ok(());
            }
        }

        let Some(adapter) = self.providers.get(&thread.provider_id).cloned() else {
            return Err(CoordinatorError::unavailable("Provider is not available."));
        };

        let cwd = thread
            .worktree
            .as_ref()
            .map(|w| w.path.clone())
            .unwrap_or_else(|| self.data_directory.to_string_lossy().into_owned());

        let started = Instant::now();
        let ack = adapter
            .send_message(SendMessageRequest {
                thread_id: tid.to_string(),
                cwd,
                model_id: thread.model_id.clone(),
                reasoning_effort: thread.reasoning_effort.clone(),
                runtime_mode: thread.runtime_mode.clone(),
                text: text.clone(),
                command_id: command_id.clone(),
                draft_id: draft_id.clone(),
                attachments: attachments.clone(),
            })
            .await
            .map_err(CoordinatorError::unavailable)?;

        let now = now_iso();
        let stored_attachments = if attachments.is_empty() {
            None
        } else {
            Some(Value::Array(
                attachments
                    .iter()
                    .map(|a| serde_json::to_value(&a.handle).unwrap_or(Value::Null))
                    .collect(),
            ))
        };
        let user_message = StoredMessage {
            id: ack.message_id.clone(),
            role: "user".into(),
            text,
            created_at: now.clone(),
            command_id: Some(command_id.clone()),
            turn_message_id: None,
            attachments: stored_attachments,
            watcher_own_change: None,
            watcher_observed_changes: None,
            provider_error: None,
        };

        let _ = self.thread_store.append_event(
            tid,
            &ThreadEvent::MessageAdded {
                at: now.clone(),
                message: user_message.clone(),
                redacted: None,
            },
        );
        self.push_message_to_detail(tid, user_message);

        let is_accepted = ack.status == "accepted";
        if let Some(t) = self.threads.iter_mut().find(|t| t.id == tid) {
            if is_accepted {
                t.status = "running".into();
                t.last_turn = Some(AgentTurnRecord {
                    id: ack.turn_id.clone(),
                    status: "running".into(),
                    message_id: Some(ack.message_id.clone()),
                });
            }
            t.native_session_started = true;
            t.last_user_message_id = Some(ack.message_id.clone());
            t.updated_at = now.clone();
            if let Some(detail) = self.details.get(tid) {
                t.summary = summarize_thread(&detail.messages, &detail.activities, &t.status);
            }
        }

        let elapsed = started.elapsed().as_millis() as u64;
        self.deliveries.push(AgentDelivery {
            command_id,
            draft_id: draft_id.clone(),
            thread_id: tid.to_string(),
            message_id: Some(ack.message_id),
            status: ack.status,
            error: None,
            created_at: now.clone(),
            updated_at: now,
            local_feedback_ms: Some(elapsed),
            provider_latency_ms: is_accepted.then_some(ack.provider_latency_ms),
        });
        self.delivered_drafts.push(DeliveredDraft {
            draft_id,
            thread_id: tid.to_string(),
        });
        self.save_workspace();
        Ok(())
    }

    async fn cmd_answer(
        &mut self,
        client: &ClientContext,
        command: &Map<String, Value>,
    ) -> Result<(), CoordinatorError> {
        let Some(tid) = command.get("threadId").and_then(Value::as_str) else {
            return Err(CoordinatorError::invalid("threadId is required."));
        };
        let Some(request_id) = command.get("requestId").and_then(Value::as_str) else {
            return Err(CoordinatorError::invalid("requestId is required."));
        };
        let answer = command
            .get("answer")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let approved = command.get("approved").and_then(Value::as_bool);
        let permission_choice = command
            .get("permissionChoice")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let question_answers = command.get("questionAnswers").cloned();

        let (provider_id, title) = {
            let Some(thread) = self.threads.iter().find(|t| t.id == tid) else {
                return Err(CoordinatorError::invalid("Unknown thread."));
            };
            let has_req = thread
                .requests
                .iter()
                .any(|r| r.get("id").and_then(Value::as_str) == Some(request_id));
            if !has_req {
                return Err(CoordinatorError::stale(
                    HostErrorCode::StaleRequest.default_message(),
                ));
            }
            (thread.provider_id.clone(), thread.title.clone())
        };

        let Some(adapter) = self.providers.get(&provider_id).cloned() else {
            return Err(CoordinatorError::unavailable("Provider is not available."));
        };

        adapter
            .answer_request(AnswerRequestInput {
                thread_id: tid.to_string(),
                request_id: request_id.to_string(),
                answer,
                approved,
                permission_choice: permission_choice.clone(),
                question_answers,
            })
            .await
            .map_err(CoordinatorError::unavailable)?;

        let _ = self.thread_store.append_event(
            tid,
            &ThreadEvent::AnswerGiven {
                at: now_iso(),
                request_id: request_id.to_string(),
                answer: None,
                approved,
                permission_choice,
                question_option_ids: None,
                attribution: ThreadEventAttribution {
                    client_id: client.client_id.clone(),
                    user: Some(client.user.clone()),
                    transport: "socket".into(),
                },
            },
        );

        if let Some(thread) = self.threads.iter_mut().find(|t| t.id == tid) {
            thread
                .requests
                .retain(|r| r.get("id").and_then(Value::as_str) != Some(request_id));
            thread.updated_at = now_iso();
        }
        self.notice = Some(format!("Answered {title}."));
        Ok(())
    }

    async fn cmd_interrupt(&mut self, command: &Map<String, Value>) -> Result<(), CoordinatorError> {
        let Some(tid) = command.get("threadId").and_then(Value::as_str) else {
            return Err(CoordinatorError::invalid("threadId is required."));
        };
        let Some(provider_id) = self
            .threads
            .iter()
            .find(|t| t.id == tid)
            .map(|t| t.provider_id.clone())
        else {
            return Err(CoordinatorError::invalid("Unknown thread."));
        };
        if let Some(adapter) = self.providers.get(&provider_id).cloned() {
            adapter
                .interrupt(tid.to_string())
                .await
                .map_err(CoordinatorError::unavailable)?;
        }
        self.finish_turn(tid, "interrupted");
        Ok(())
    }

    async fn cmd_compact(&mut self, command: &Map<String, Value>) -> Result<(), CoordinatorError> {
        let Some(tid) = command.get("threadId").and_then(Value::as_str) else {
            return Err(CoordinatorError::invalid("threadId is required."));
        };
        let Some(provider_id) = self
            .threads
            .iter()
            .find(|t| t.id == tid)
            .map(|t| t.provider_id.clone())
        else {
            return Err(CoordinatorError::invalid("Unknown thread."));
        };
        if let Some(adapter) = self.providers.get(&provider_id).cloned() {
            adapter
                .compact(tid.to_string())
                .await
                .map_err(CoordinatorError::unavailable)?;
        }
        Ok(())
    }

    fn handle_provider_event(&mut self, event: ProviderEvent) {
        match event {
            ProviderEvent::StatusChanged {
                provider_id,
                status,
                models,
                client_update,
            } => {
                self.provider_statuses.insert(provider_id.clone(), status);
                self.models.retain(|m| m.provider_id != provider_id);
                self.models.extend(models);
                self.models_revision += 1;
                if let Some(upd) = client_update {
                    self.client_updates.retain(|u| u.id != provider_id);
                    self.client_updates.push(upd);
                }
                self.shell_dirty = true;
            }
            ProviderEvent::TurnStarted {
                thread_id,
                turn_id,
                after_message_id,
                activity,
            } => {
                self.upsert_activity_in_detail(&thread_id, activity);
                if let Some(thread) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    thread.status = "running".into();
                    thread.last_turn = Some(AgentTurnRecord {
                        id: turn_id,
                        status: "running".into(),
                        message_id: after_message_id,
                    });
                    if let Some(detail) = self.details.get(&thread_id) {
                        thread.summary =
                            summarize_thread(&detail.messages, &detail.activities, &thread.status);
                    }
                }
                self.shell_dirty = true;
            }
            ProviderEvent::MessageAdded { thread_id, message } => {
                let _ = self.thread_store.append_event(
                    &thread_id,
                    &ThreadEvent::MessageAdded {
                        at: message.created_at.clone(),
                        message: message.clone(),
                        redacted: None,
                    },
                );
                self.push_message_to_detail(&thread_id, message);
                self.refresh_thread_summary(&thread_id);
                self.shell_dirty = true;
            }
            ProviderEvent::MessageTextAppended {
                thread_id,
                message_id,
                append_text,
            } => {
                let _ = self.thread_store.append_event(
                    &thread_id,
                    &ThreadEvent::MessageTextAppended {
                        at: now_iso(),
                        message_id: message_id.clone(),
                        append_text: append_text.clone(),
                        redacted: None,
                    },
                );
                if let Some(detail) = self.details.get_mut(&thread_id) {
                    if let Some(msg) = detail.messages.iter_mut().find(|m| m.id == message_id) {
                        msg.text.push_str(&append_text);
                        detail.revision += 1;
                        self.dirty_details.insert(thread_id.clone());
                    }
                }
                self.refresh_thread_summary(&thread_id);
                self.shell_dirty = true;
            }
            ProviderEvent::MessageReplaced { thread_id, message } => {
                let _ = self.thread_store.append_event(
                    &thread_id,
                    &ThreadEvent::MessageReplaced {
                        at: message.created_at.clone(),
                        message: message.clone(),
                        redacted: None,
                    },
                );
                if let Some(detail) = self.details.get_mut(&thread_id) {
                    if let Some(msg) = detail.messages.iter_mut().find(|m| m.id == message.id) {
                        *msg = message;
                    } else {
                        detail.messages.push(message);
                    }
                    detail.revision += 1;
                    self.dirty_details.insert(thread_id.clone());
                }
                self.refresh_thread_summary(&thread_id);
                self.shell_dirty = true;
            }
            ProviderEvent::ActivityUpserted {
                thread_id,
                activity,
            } => {
                self.upsert_activity_in_detail(&thread_id, activity);
                self.refresh_thread_summary(&thread_id);
                self.shell_dirty = true;
            }
            ProviderEvent::RequestOpened { thread_id, request } => {
                if let Some(thread) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    if let Some(rid) = request.get("id").and_then(Value::as_str) {
                        thread
                            .requests
                            .retain(|r| r.get("id").and_then(Value::as_str) != Some(rid));
                    }
                    thread.requests.push(request);
                    thread.updated_at = now_iso();
                    self.shell_dirty = true;
                }
            }
            ProviderEvent::RequestCleared {
                thread_id,
                request_id,
            } => {
                if let Some(thread) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    thread
                        .requests
                        .retain(|r| r.get("id").and_then(Value::as_str) != Some(request_id.as_str()));
                    thread.updated_at = now_iso();
                    self.shell_dirty = true;
                }
            }
            ProviderEvent::TurnCompleted {
                thread_id,
                turn_id: _,
                status,
            } => {
                self.finish_turn(&thread_id, &status);
            }
        }
    }

    fn finish_turn(&mut self, thread_id: &str, status: &str) {
        let now = now_iso();
        if let Some(detail) = self.details.get_mut(thread_id) {
            let mut changed = false;
            for act in &mut detail.activities {
                if act.get("kind").and_then(Value::as_str) == Some("turn")
                    && act.get("status").and_then(Value::as_str) == Some("running")
                {
                    if let Some(obj) = act.as_object_mut() {
                        obj.insert("status".into(), Value::String(status.to_string()));
                        obj.insert("completedAt".into(), Value::String(now.clone()));
                        let title = if status == "interrupted" {
                            "Turn interrupted"
                        } else {
                            "Turn completed"
                        };
                        obj.insert("title".into(), Value::String(title.into()));
                        changed = true;
                    }
                }
            }
            if changed {
                detail.revision += 1;
                let _ = self
                    .thread_store
                    .save_activities(thread_id, None, None, &detail.activities);
                self.dirty_details.insert(thread_id.to_string());
            }
        }
        if let Some(thread) = self.threads.iter_mut().find(|t| t.id == thread_id) {
            thread.status = "idle".into();
            if let Some(ref mut turn) = thread.last_turn {
                turn.status = status.to_string();
            }
            thread.updated_at = now;
            if let Some(detail) = self.details.get(thread_id) {
                thread.summary =
                    summarize_thread(&detail.messages, &detail.activities, &thread.status);
            }
        }
        self.shell_dirty = true;
    }

    fn push_message_to_detail(&mut self, thread_id: &str, message: StoredMessage) {
        let detail = self
            .details
            .entry(thread_id.to_string())
            .or_insert_with(|| AgentThreadDetail {
                thread_id: thread_id.to_string(),
                revision: 0,
                messages: Vec::new(),
                activities: Vec::new(),
                earlier_available: None,
            });
        detail.messages.push(message);
        detail.revision += 1;
        self.dirty_details.insert(thread_id.to_string());
    }

    fn upsert_activity_in_detail(&mut self, thread_id: &str, activity: Value) {
        let detail = self
            .details
            .entry(thread_id.to_string())
            .or_insert_with(|| AgentThreadDetail {
                thread_id: thread_id.to_string(),
                revision: 0,
                messages: Vec::new(),
                activities: Vec::new(),
                earlier_available: None,
            });
        if let Some(id) = activity.get("id").and_then(Value::as_str) {
            if let Some(existing) = detail
                .activities
                .iter_mut()
                .find(|a| a.get("id").and_then(Value::as_str) == Some(id))
            {
                *existing = activity;
            } else {
                detail.activities.push(activity);
            }
        } else {
            detail.activities.push(activity);
        }
        detail.revision += 1;
        let _ = self
            .thread_store
            .save_activities(thread_id, None, None, &detail.activities);
        self.dirty_details.insert(thread_id.to_string());
    }

    fn refresh_thread_summary(&mut self, thread_id: &str) {
        if let (Some(thread), Some(detail)) = (
            self.threads.iter_mut().find(|t| t.id == thread_id),
            self.details.get(thread_id),
        ) {
            thread.summary = summarize_thread(&detail.messages, &detail.activities, &thread.status);
        }
    }

    fn rebuild_catalog(&mut self) {
        self.models.clear();
        self.client_updates.clear();
        for adapter in self.providers.values() {
            if !adapter.is_held() {
                self.models.extend(adapter.models());
                if let Some(upd) = adapter.client_update() {
                    self.client_updates.push(upd);
                }
            }
        }
        self.models_revision += 1;
    }

    fn flush_dirty(&mut self) {
        for tid in self.dirty_details.drain() {
            if let Some(detail) = self.details.get(&tid) {
                let _ = self
                    .broadcast_tx
                    .send(CoordinatorBroadcast::Detail(detail.clone()));
            }
        }
        if self.shell_dirty {
            self.shell_dirty = false;
            let shell = self.build_shell(false);
            let _ = self.broadcast_tx.send(CoordinatorBroadcast::Shell(shell));
        }
    }

    fn build_shell(&self, may_answer: bool) -> Value {
        let providers: Vec<&AgentProviderStatus> = ACTIVE_PROVIDERS
            .iter()
            .filter_map(|id| self.provider_statuses.get(*id))
            .collect();
        let active_provider = self
            .provider_statuses
            .get(&self.configuration.provider)
            .or_else(|| providers.iter().copied().find(|p| p.connection == "connected"));
        let connected = active_provider
            .map(|p| p.connection == "connected")
            .unwrap_or(false);
        let capabilities = active_provider
            .map(|p| p.capabilities.clone())
            .unwrap_or_else(AgentCapabilities::none);
        let host_name = provider_label(&self.configuration.provider);

        let busy_ids: Vec<&String> = self.busy_thread_ids.iter().collect();

        json!({
            "activeProjectId": self.active_project_id,
            "activeThreadId": self.active_thread_id,
            "assignments": [],
            "busyThreadIds": busy_ids,
            "clientCapabilities": { "mayAnswer": may_answer },
            "clientUpdates": self.client_updates,
            "composing": false,
            "configuration": self.configuration,
            "connection": if connected { "connected" } else { "disconnected" },
            "credentials": {
                "antigravity": false,
                "grokSpeech": false,
                "reasoning": false,
                "secure": self.credentials_secure,
            },
            "deliveredDrafts": self.delivered_drafts,
            "deliveries": self.deliveries,
            "draft": "",
            "draftAttachments": [],
            "draftRequestId": null,
            "draftThreadId": null,
            "error": self.error,
            "followupReceipts": [],
            "followups": [],
            "globalLaneBusy": self.global_lane_busy,
            "historyEnabled": true,
            "host": {
                "capabilities": capabilities,
                "connected": connected,
                "hostId": self.host_id,
                "models": self.models,
                "modelsRevision": self.models_revision,
                "name": host_name,
                "projects": self.projects,
                "providers": providers,
                "threads": self.threads,
            },
            "notice": self.notice,
            "pendingRequest": "",
            "queue": [],
            "speech": { "id": 0, "text": "" },
            "voice": { "action": "none", "error": null, "revision": 0, "status": "off" },
        })
    }

    fn save_workspace(&self) {
        let state = PersistedWorkspace {
            projects: self.projects.clone(),
            threads: self.threads.clone(),
            configuration: self.configuration.clone(),
        };
        let _ = write_atomic_json(&self.data_directory.join("workspace.json"), &state);
        // Also write `threads.json` in Sotto's `ThreadRegistry` schema (`{ version, bindings }`)
        // so TypeScript restarts and the referee harness resolve each thread's provider binding.
        let bindings: Vec<Value> = self
            .threads
            .iter()
            .map(|t| {
                json!({
                    "threadId": t.id,
                    "providerId": t.provider_id,
                    "sessionId": t.id,
                    "projectId": t.project_id,
                    "title": t.title,
                })
            })
            .collect();
        let registry = json!({
            "version": 1,
            "bindings": bindings,
        });
        let _ = write_atomic_json(&self.data_directory.join("threads.json"), &registry);
    }
}

fn load_persisted_workspace(dir: &Path) -> PersistedWorkspace {
    let path = dir.join("workspace.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn probe_git_worktree(folder: &str) -> Value {
    let branch = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(folder)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string());
    match branch {
        Some(b) if !b.is_empty() => {
            let dirty = Command::new("git")
                .args(["status", "--porcelain"])
                .current_dir(folder)
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| !o.stdout.is_empty())
                .unwrap_or(false);
            json!({
                "isRepository": true,
                "branch": b,
                "dirty": dirty,
            })
        }
        _ => json!({ "isRepository": false }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::MockProviderAdapter;
    use tempfile::tempdir;

    #[tokio::test]
    async fn runs_full_project_thread_send_question_answer_and_interrupt_flow() {
        let dir = tempdir().unwrap();
        let mock = Arc::new(MockProviderAdapter::new("codex"));
        let mut providers: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
        providers.insert("codex".into(), mock.clone());

        let coord = CoordinatorHandle::spawn(
            dir.path().to_path_buf(),
            "host-1".into(),
            false,
            providers,
        )
        .unwrap();

        let client = ClientContext {
            client_id: "c1".into(),
            user: "Test Desktop".into(),
            may_answer: true,
        };

        // Create project
        let shell = coord
            .run_command(
                client.clone(),
                json!({
                    "type": "create-project",
                    "provider": "codex",
                    "title": "Referee project",
                    "path": dir.path().to_string_lossy(),
                    "useExisting": true
                })
                .as_object()
                .unwrap()
                .clone(),
            )
            .await
            .unwrap();
        let project_id = shell["host"]["projects"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();

        // Create thread
        let thread_id = "00000000-0000-4000-8000-00000000000a";
        let _ = coord
            .run_command(
                client.clone(),
                json!({
                    "type": "create-thread",
                    "threadId": thread_id,
                    "projectId": project_id,
                    "title": "Referee thread",
                    "titleSource": "user",
                    "modelId": "native:codex:model:fixture-model",
                    "workingCopy": "shared",
                    "managed": false
                })
                .as_object()
                .unwrap()
                .clone(),
            )
            .await
            .unwrap();

        // Send message
        let shell = coord
            .run_command(
                client.clone(),
                json!({
                    "type": "manual-send",
                    "threadId": thread_id,
                    "text": "Referee prompt one"
                })
                .as_object()
                .unwrap()
                .clone(),
            )
            .await
            .unwrap();
        assert_eq!(shell["host"]["threads"][0]["status"], "running");

        // Emit a question and answer it
        mock.emit_request(
            thread_id,
            json!({ "id": "req-1", "kind": "question", "text": "Which colour?" }),
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
        let answered = coord
            .run_command(
                client.clone(),
                json!({
                    "type": "answer",
                    "threadId": thread_id,
                    "requestId": "req-1",
                    "answer": "Blue"
                })
                .as_object()
                .unwrap()
                .clone(),
            )
            .await
            .unwrap();
        assert_eq!(answered["notice"], "Answered Referee thread.");

        // Complete the turn
        mock.complete_turn(thread_id, "Referee reply one");
        tokio::time::sleep(Duration::from_millis(80)).await;

        let detail = coord.detail(thread_id.into()).await.unwrap().unwrap();
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[0].text, "Referee prompt one");
        assert_eq!(detail.messages[1].text, "Referee reply one");

        let (events, _, _) = coord.events(Some(thread_id.into()), 0, 50).await.unwrap();
        assert_eq!(events.len(), 3); // message-added, answer-given, message-added

        coord.shutdown().await;
    }
}
