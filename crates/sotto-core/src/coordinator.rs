use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, mpsc, oneshot};
use uuid::Uuid;

use crate::ops::ThreadWorkspace;
use crate::protocol::HostErrorCode;
use crate::provider::{
    AnswerRequestInput, HeldProviderAdapter, ProviderAdapter, ProviderEvent, SendMessageAck,
    SendMessageRequest,
};
use crate::remote_commands::validate_remote_command;
use crate::stores::{
    StoredMessage, StoredThreadEvent, ThreadEvent, ThreadEventAttribution, ThreadStore,
};
use crate::workspace::{
    now_iso, parse_public_provider_entity_id, provider_label, summarize_thread, write_atomic_json,
    AgentCapabilities, AgentConfiguration, AgentDelivery, AgentModel, AgentProject,
    AgentProviderStatus, AgentThread, AgentThreadDetail, AgentThreadWorktree, AgentTurnRecord,
    ClientUpdateRow, DeliveredDraft, StagedAttachmentEntry, StagedAttachmentHandle,
    StagedAttachments, ACTIVE_PROVIDERS, ALL_PROVIDER_IDS,
};

const PUBLISH_COALESCE_MS: u64 = 50;
const HOST_VERSION: &str = match option_env!("SOTTO_HOST_VERSION") {
    Some(v) if !v.is_empty() => v,
    _ => env!("CARGO_PKG_VERSION"),
};

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

struct PendingCommand {
    client: ClientContext,
    command: Map<String, Value>,
    reply: oneshot::Sender<Result<Value, CoordinatorError>>,
}

struct InFlightSend {
    message_id: String,
    command_id: String,
    text: String,
    attachments: Vec<StagedAttachmentEntry>,
    created_at: String,
    flushed: bool,
    turn_already_completed: Option<String>,
}

enum AsyncCommandOutcome {
    Connect {
        explicit: bool,
        outcomes: Vec<(String, Result<(), String>)>,
        suppress_notice: bool,
    },
    Disconnect {
        provider_ids: Vec<String>,
    },
    ConfigureThread {
        thread_id: String,
        model_id: Option<String>,
        reasoning_effort: Option<String>,
        runtime_mode: Option<String>,
        provider_mode: Option<String>,
        result: Result<(), String>,
    },
    ManualSend {
        thread_id: String,
        command_id: String,
        draft_id: String,
        text: String,
        attachments: Vec<StagedAttachmentEntry>,
        elapsed_ms: u64,
        allocated_worktree: Option<Box<AgentThreadWorktree>>,
        result: Result<SendMessageAck, String>,
    },
    Answer {
        thread_id: String,
        request_id: String,
        title: String,
        approved: Option<bool>,
        permission_choice: Option<String>,
        client: ClientContext,
        result: Result<(), String>,
    },
    Interrupt {
        thread_id: String,
        result: Result<(), String>,
    },
    Compact {
        result: Result<(), String>,
    },
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
    GetThreadWorkspace {
        thread_id: String,
        reply: oneshot::Sender<Option<ThreadWorkspace>>,
    },
    GetRunningThreadsCount {
        reply: oneshot::Sender<usize>,
    },
    GetAttachmentContent {
        digest: String,
        reply: oneshot::Sender<Option<(String, Vec<u8>)>>,
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
        dimensions: Option<Value>,
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
    AsyncCommandDone {
        lane: Option<String>,
        client: ClientContext,
        outcome: Box<AsyncCommandOutcome>,
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
        let persisted = load_persisted_workspace(&data_directory)?;
        let thread_bindings = load_thread_bindings(&data_directory);
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
            persisted,
            thread_bindings,
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

    pub async fn thread_workspace(
        &self,
        thread_id: String,
    ) -> Result<Option<ThreadWorkspace>, CoordinatorError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMessage::GetThreadWorkspace {
                thread_id,
                reply: reply_tx,
            })
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))?;
        reply_rx
            .await
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))
    }

    pub async fn running_threads_count(&self) -> Result<usize, CoordinatorError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMessage::GetRunningThreadsCount { reply: reply_tx })
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))?;
        reply_rx
            .await
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))
    }

    pub async fn attachment_content(
        &self,
        digest: String,
    ) -> Result<Option<(String, Vec<u8>)>, CoordinatorError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMessage::GetAttachmentContent {
                digest,
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
        dimensions: Option<Value>,
    ) -> Result<StagedAttachmentHandle, CoordinatorError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMessage::StageImage {
                name,
                mime_type,
                data_b64,
                dimensions,
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

    /// Enqueues a command synchronously on the coordinator actor in arrival order and returns the
    /// reply channel so callers can preserve strict submission order without blocking their loop.
    pub fn enqueue_command(
        &self,
        client: ClientContext,
        command: Map<String, Value>,
    ) -> Result<oneshot::Receiver<Result<Value, CoordinatorError>>, CoordinatorError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMessage::RunCommand {
                client,
                command,
                reply: reply_tx,
            })
            .map_err(|_| CoordinatorError::unavailable("Host coordinator stopped."))?;
        Ok(reply_rx)
    }

    pub async fn run_command(
        &self,
        client: ClientContext,
        command: Map<String, Value>,
    ) -> Result<Value, CoordinatorError> {
        let reply_rx = self.enqueue_command(client, command)?;
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

/// Preserved TypeScript `workspace.json` + `agents.json` state matching `workspaceSchema`
/// (`src/main/agents/workspace.ts`) and `savedSchema` (`src/main/agents/control.ts`).
#[derive(Debug, Default)]
struct LoadedWorkspace {
    projects: Vec<AgentProject>,
    threads: Vec<AgentThread>,
    project_aliases: Vec<Value>,
    creations: Vec<Value>,
    cleared_thread_ids: Vec<String>,
    snapshot_extra: Map<String, Value>,
    file_extra: Map<String, Value>,
    agents_json_extra: Map<String, Value>,
    agents_config_extra: Map<String, Value>,
    had_saved_configuration: bool,
    configuration: AgentConfiguration,
}

/// TypeScript `ThreadRegistry` binding format (`threads.json` in `src/main/agents/threads.ts`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadBindingRecord {
    thread_id: String,
    provider: String,
    session_id: String,
    project_id: String,
    created_at: String,
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
    project_aliases: Vec<Value>,
    creations: Vec<Value>,
    cleared_thread_ids: Vec<String>,
    snapshot_extra: Map<String, Value>,
    file_extra: Map<String, Value>,
    agents_json_extra: Map<String, Value>,
    agents_config_extra: Map<String, Value>,
    thread_bindings: HashMap<String, ThreadBindingRecord>,
    details: HashMap<String, AgentThreadDetail>,
    deliveries: Vec<AgentDelivery>,
    delivered_drafts: Vec<DeliveredDraft>,
    provider_statuses: BTreeMap<String, AgentProviderStatus>,
    models: Vec<AgentModel>,
    models_revision: u64,
    client_updates: Vec<ClientUpdateRow>,
    notice: String,
    error: Option<String>,
    global_lane_busy: bool,
    global_queue: VecDeque<PendingCommand>,
    busy_thread_ids: HashSet<String>,
    thread_queues: HashMap<String, VecDeque<PendingCommand>>,
    in_flight_sends: HashMap<String, InFlightSend>,
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
        persisted: LoadedWorkspace,
        thread_bindings: HashMap<String, ThreadBindingRecord>,
        providers: BTreeMap<String, Arc<dyn ProviderAdapter>>,
        provider_events_tx: mpsc::UnboundedSender<ProviderEvent>,
        self_tx: mpsc::UnboundedSender<ActorMessage>,
        broadcast_tx: broadcast::Sender<CoordinatorBroadcast>,
    ) -> Self {
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

        let available_providers: Vec<String> = ACTIVE_PROVIDERS
            .iter()
            .filter(|&&id| providers.get(id).is_some_and(|adapter| !adapter.is_held()))
            .map(|&id| id.to_string())
            .collect();
        let mut configuration = persisted.configuration;
        // Mirror Node headless host startup (ADR-0036, `src/main/agents/control.ts`):
        // a legacy store saved before `disconnectedProviders` existed wrote an empty
        // `enabledProviders` array only when the user turned every provider off.
        // Record Node's full `ALL_PROVIDER_IDS` set so unadapted Node providers (`deepseek`,
        // `hermes`, `pi`) also stay turned off when switching back to Node.
        if persisted.had_saved_configuration
            && configuration.disconnected_providers.is_none()
            && configuration.enabled_providers.is_empty()
        {
            let all_off: HashSet<&str> = ALL_PROVIDER_IDS.iter().copied().collect();
            configuration.set_disconnected_providers(&all_off, &available_providers);
        } else {
            let off_owned: Vec<String> = configuration.disconnected_providers.clone().unwrap_or_default();
            let off: HashSet<&str> = off_owned.iter().map(String::as_str).collect();
            configuration.set_disconnected_providers(&off, &available_providers);
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
            configuration,
            active_project_id: None,
            active_thread_id: None,
            projects: persisted.projects,
            threads: persisted.threads,
            project_aliases: persisted.project_aliases,
            creations: persisted.creations,
            cleared_thread_ids: persisted.cleared_thread_ids,
            snapshot_extra: persisted.snapshot_extra,
            file_extra: persisted.file_extra,
            agents_json_extra: persisted.agents_json_extra,
            agents_config_extra: persisted.agents_config_extra,
            thread_bindings,
            details,
            deliveries: Vec::new(),
            delivered_drafts: Vec::new(),
            provider_statuses,
            models,
            models_revision: 1,
            client_updates,
            notice: String::new(),
            error: None,
            global_lane_busy: false,
            global_queue: VecDeque::new(),
            busy_thread_ids: HashSet::new(),
            thread_queues: HashMap::new(),
            in_flight_sends: HashMap::new(),
            staged,
            shell_dirty: false,
            dirty_details: HashSet::new(),
        }
    }

    fn available_providers(&self) -> Vec<String> {
        ACTIVE_PROVIDERS
            .iter()
            .filter(|&&id| self.providers.get(id).is_some_and(|adapter| !adapter.is_held()))
            .map(|&id| id.to_string())
            .collect()
    }

    async fn run(
        mut self,
        mut rx: mpsc::UnboundedReceiver<ActorMessage>,
        mut provider_rx: mpsc::UnboundedReceiver<ProviderEvent>,
    ) {
        // Connect every non-held provider concurrently at startup except the ones the user
        // turned off in `agents.json` (ADR-0036), while still honouring Shutdown immediately
        // so slow provider startup can never block exit.
        let disconnected: HashSet<String> = self
            .configuration
            .disconnected_providers
            .clone()
            .unwrap_or_default()
            .into_iter()
            .collect();
        let mut startup_connects: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();
        for (id, adapter) in &self.providers {
            if !adapter.is_held() && !disconnected.contains(id) {
                let adapter = Arc::clone(adapter);
                let tx = self.provider_events_tx.clone();
                startup_connects.spawn(async move {
                    let _ = adapter.connect(tx).await;
                });
            }
        }
        let mut deferred_messages: VecDeque<ActorMessage> = VecDeque::new();
        while !startup_connects.is_empty() {
            tokio::select! {
                _ = startup_connects.join_next() => {}
                Some(msg) = rx.recv() => {
                    match msg {
                        ActorMessage::Shutdown { reply } => {
                            startup_connects.abort_all();
                            while startup_connects.join_next().await.is_some() {}
                            for adapter in self.providers.values() {
                                let _ = adapter.disconnect().await;
                            }
                            self.save_workspace();
                            let _ = reply.send(());
                            return;
                        }
                        other => deferred_messages.push_back(other),
                    }
                }
            }
        }
        for (id, adapter) in &self.providers {
            self.provider_statuses.insert(id.clone(), adapter.status());
        }
        while let Ok(ev) = provider_rx.try_recv() {
            self.handle_provider_event(ev);
        }
        self.rebuild_catalog();
        for msg in deferred_messages {
            self.handle_actor_message(msg);
        }

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
                            self.handle_actor_message(other);
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

    fn handle_actor_message(&mut self, msg: ActorMessage) {
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
            ActorMessage::GetThreadWorkspace { thread_id, reply } => {
                let ws = self.resolve_thread_workspace(&thread_id);
                let _ = reply.send(ws);
            }
            ActorMessage::GetRunningThreadsCount { reply } => {
                let count = self.threads.iter().filter(|t| t.status == "running").count();
                let _ = reply.send(count);
            }
            ActorMessage::GetAttachmentContent { digest, reply } => {
                let found = self.staged.get_by_digest(&digest).and_then(|entry| {
                    std::fs::read(&entry.path)
                        .ok()
                        .map(|bytes| (entry.handle.mime_type.clone(), bytes))
                });
                let _ = reply.send(found);
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
                                if let Some(ref path) = wt.path {
                                    let path = path.clone();
                                    let thread_id = tid.clone();
                                    let tx = self.self_tx.clone();
                                    tokio::task::spawn_blocking(move || {
                                        let git = probe_git_worktree(&path);
                                        let _ = tx.send(ActorMessage::GitStatusReady { thread_id, git });
                                    });
                                }
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
                dimensions,
                reply,
            } => {
                let res = self
                    .staged
                    .stage_image(&name, &mime_type, &data_b64, dimensions)
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
                self.enqueue_or_dispatch(PendingCommand {
                    client,
                    command,
                    reply,
                });
            }
            ActorMessage::AsyncCommandDone {
                lane,
                client,
                outcome,
                reply,
            } => {
                let res = self.commit_async_command(&client, *outcome);
                if let Some(ref tid) = lane {
                    self.busy_thread_ids.remove(tid);
                } else {
                    self.global_lane_busy = false;
                }
                self.shell_dirty = true;
                let _ = reply.send(res);
                self.flush_dirty();
                self.drain_lane(lane);
            }
            ActorMessage::Shutdown { .. } => unreachable!(),
        }
    }

    fn resolve_thread_workspace(&self, thread_id: &str) -> Option<ThreadWorkspace> {
        let thread = self.threads.iter().find(|t| t.id == thread_id)?;
        let working_dir = thread
            .worktree
            .as_ref()
            .and_then(|w| w.path.as_deref())
            .or(thread.working_directory.as_deref())
            .or_else(|| {
                self.projects
                    .iter()
                    .find(|p| p.id == thread.project_id)
                    .map(|p| p.path.as_str())
            })?;
        Some(ThreadWorkspace::build(&thread.id, &thread.project_id, working_dir))
    }

    fn enqueue_or_dispatch(&mut self, pending: PendingCommand) {
        let lane = pending
            .command
            .get("threadId")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        if let Some(ref tid) = lane {
            if self.busy_thread_ids.contains(tid) {
                self.thread_queues
                    .entry(tid.clone())
                    .or_default()
                    .push_back(pending);
                return;
            }
        } else if self.global_lane_busy {
            self.global_queue.push_back(pending);
            return;
        }
        self.dispatch_command(lane, pending);
    }

    fn drain_lane(&mut self, lane: Option<String>) {
        if let Some(tid) = lane {
            if let Some(queue) = self.thread_queues.get_mut(&tid) {
                if let Some(next) = queue.pop_front() {
                    if queue.is_empty() {
                        self.thread_queues.remove(&tid);
                    }
                    self.dispatch_command(Some(tid), next);
                }
            }
        } else if let Some(next) = self.global_queue.pop_front() {
            self.dispatch_command(None, next);
        }
    }

    fn dispatch_command(&mut self, lane: Option<String>, pending: PendingCommand) {
        let PendingCommand {
            client,
            command,
            reply,
        } = pending;

        let cmd_type = match validate_remote_command(&command, client.may_answer) {
            Ok(t) => t,
            Err(refusal) => {
                let _ = reply.send(Err(CoordinatorError {
                    code: refusal.code,
                    message: refusal
                        .message
                        .unwrap_or_else(|| refusal.code.default_message().to_string()),
                }));
                self.drain_lane(lane);
                return;
            }
        };

        // Mark lane busy before async or sync dispatch.
        if let Some(ref tid) = lane {
            self.busy_thread_ids.insert(tid.clone());
        } else {
            self.global_lane_busy = true;
        }

        match cmd_type {
            // Fast, purely local commands execute synchronously and release the lane immediately.
            "configure" => {
                let res = self.cmd_configure(&command);
                self.finish_sync_command(lane, &client, res, reply);
            }
            "refresh" => {
                let res = self.cmd_refresh(&command);
                self.finish_sync_command(lane, &client, res, reply);
            }
            "create-project" => {
                let res = self.cmd_create_project(&command);
                self.finish_sync_command(lane, &client, res, reply);
            }
            "select-project" => {
                self.active_project_id = command
                    .get("projectId")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                self.finish_sync_command(lane, &client, Ok(()), reply);
            }
            "create-thread" => {
                let res = self.cmd_create_thread(&command);
                self.finish_sync_command(lane, &client, res, reply);
            }
            "select-thread" => {
                self.active_thread_id = command
                    .get("threadId")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                self.finish_sync_command(lane, &client, Ok(()), reply);
            }
            "rename-thread" => {
                let res = self.cmd_rename_thread(&command);
                self.finish_sync_command(lane, &client, res, reply);
            }
            "settle-thread" => {
                let res = self.cmd_settle_thread(&command, true);
                self.finish_sync_command(lane, &client, res, reply);
            }
            "restore-thread" => {
                let res = self.cmd_settle_thread(&command, false);
                self.finish_sync_command(lane, &client, res, reply);
            }
            "observe-threads" => {
                self.finish_sync_command(lane, &client, Ok(()), reply);
            }

            // Slow provider / git-worktree commands run outside the owner loop while holding only their lane.
            "connect" => self.spawn_cmd_connect(lane, client, &command, reply),
            "disconnect" => self.spawn_cmd_disconnect(lane, client, &command, reply),
            "configure-thread" => self.spawn_cmd_configure_thread(lane, client, &command, reply),
            "manual-send" => self.spawn_cmd_manual_send(lane, client, &command, reply),
            "answer" => self.spawn_cmd_answer(lane, client, &command, reply),
            "interrupt" => self.spawn_cmd_interrupt(lane, client, &command, reply),
            "compact-thread" => self.spawn_cmd_compact(lane, client, &command, reply),
            _ => {
                self.finish_sync_command(
                    lane,
                    &client,
                    Err(CoordinatorError::invalid(
                        HostErrorCode::InvalidRequest.default_message(),
                    )),
                    reply,
                );
            }
        }
    }

    fn finish_sync_command(
        &mut self,
        lane: Option<String>,
        client: &ClientContext,
        outcome: Result<(), CoordinatorError>,
        reply: oneshot::Sender<Result<Value, CoordinatorError>>,
    ) {
        if let Some(ref tid) = lane {
            self.busy_thread_ids.remove(tid);
        } else {
            self.global_lane_busy = false;
        }
        self.shell_dirty = true;
        let res = outcome.map(|()| self.build_shell(client.may_answer));
        let _ = reply.send(res);
        self.flush_dirty();
        self.drain_lane(lane);
    }

    fn spawn_cmd_connect(
        &mut self,
        lane: Option<String>,
        client: ClientContext,
        command: &Map<String, Value>,
        reply: oneshot::Sender<Result<Value, CoordinatorError>>,
    ) {
        let explicit_provider = command.get("provider").and_then(Value::as_str).map(ToString::to_string);
        let suppress_notice = command.get("notice") == Some(&Value::Bool(false));
        let available = self.available_providers();
        let (explicit, targets) = match explicit_provider {
            Some(provider_id) => {
                let Some(adapter) = self.providers.get(&provider_id).cloned() else {
                    self.finish_sync_command(lane, &client, Err(CoordinatorError::invalid("Unknown provider.")), reply);
                    return;
                };
                self.configuration
                    .mark_providers_turned_off(&[], &[provider_id.as_str()], &available);
                self.save_workspace();
                (true, vec![(provider_id, adapter)])
            }
            None => {
                // Plain `{ type: 'connect' }` without a provider never mutates `disconnectedProviders`
                // (ADR-0036, `src/main/agents/control.ts`): connect only available providers not turned off.
                let off: HashSet<&str> = self
                    .configuration
                    .disconnected_providers
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .map(String::as_str)
                    .collect();
                let list = available
                    .iter()
                    .filter(|id| !off.contains(id.as_str()))
                    .filter_map(|id| self.providers.get(id).cloned().map(|a| (id.clone(), a)))
                    .collect();
                (false, list)
            }
        };
        let events_tx = self.provider_events_tx.clone();
        let self_tx = self.self_tx.clone();
        tokio::spawn(async move {
            let mut outcomes = Vec::with_capacity(targets.len());
            for (provider_id, adapter) in targets {
                let result = adapter.connect(events_tx.clone()).await;
                outcomes.push((provider_id, result));
            }
            let _ = self_tx.send(ActorMessage::AsyncCommandDone {
                lane,
                client,
                outcome: Box::new(AsyncCommandOutcome::Connect {
                    explicit,
                    outcomes,
                    suppress_notice,
                }),
                reply,
            });
        });
    }

    fn spawn_cmd_disconnect(
        &mut self,
        lane: Option<String>,
        client: ClientContext,
        command: &Map<String, Value>,
        reply: oneshot::Sender<Result<Value, CoordinatorError>>,
    ) {
        let explicit_provider = command.get("provider").and_then(Value::as_str).map(ToString::to_string);
        let available = self.available_providers();
        let targets: Vec<(String, Arc<dyn ProviderAdapter>)> = match explicit_provider {
            Some(provider_id) => match self.providers.get(&provider_id).cloned() {
                Some(adapter) => {
                    self.configuration
                        .mark_providers_turned_off(&[provider_id.as_str()], &[], &available);
                    vec![(provider_id, adapter)]
                }
                None => {
                    self.finish_sync_command(lane, &client, Ok(()), reply);
                    return;
                }
            },
            None => {
                // Disconnect-all records every Node provider ID (`ALL_PROVIDER_IDS`, including
                // `deepseek`, `hermes`, `pi`) so switching back to Node never reconnects them.
                let existing: Vec<String> = self
                    .configuration
                    .disconnected_providers
                    .clone()
                    .unwrap_or_default();
                let mut all_off: HashSet<&str> = ALL_PROVIDER_IDS.iter().copied().collect();
                for id in &existing {
                    all_off.insert(id.as_str());
                }
                self.configuration
                    .set_disconnected_providers(&all_off, &available);
                self.configuration.enabled_providers.clear();
                available
                    .iter()
                    .filter_map(|id| self.providers.get(id).cloned().map(|a| (id.clone(), a)))
                    .collect()
            }
        };
        self.save_workspace();
        let self_tx = self.self_tx.clone();
        tokio::spawn(async move {
            let mut provider_ids = Vec::with_capacity(targets.len());
            for (provider_id, adapter) in targets {
                let _ = adapter.disconnect().await;
                provider_ids.push(provider_id);
            }
            let _ = self_tx.send(ActorMessage::AsyncCommandDone {
                lane,
                client,
                outcome: Box::new(AsyncCommandOutcome::Disconnect { provider_ids }),
                reply,
            });
        });
    }

    fn spawn_cmd_configure_thread(
        &mut self,
        lane: Option<String>,
        client: ClientContext,
        command: &Map<String, Value>,
        reply: oneshot::Sender<Result<Value, CoordinatorError>>,
    ) {
        let Some(tid) = command.get("threadId").and_then(Value::as_str).map(ToString::to_string) else {
            self.finish_sync_command(lane, &client, Err(CoordinatorError::invalid("threadId is required.")), reply);
            return;
        };
        let Some(thread) = self.threads.iter().find(|t| t.id == tid).cloned() else {
            self.finish_sync_command(lane, &client, Err(CoordinatorError::invalid("Unknown thread.")), reply);
            return;
        };
        let model_id = command.get("modelId").and_then(Value::as_str).map(ToString::to_string);
        let reasoning_effort = command.get("reasoningEffort").and_then(Value::as_str).map(ToString::to_string);
        let runtime_mode = command.get("runtimeMode").and_then(Value::as_str).map(ToString::to_string);
        let provider_mode = command.get("providerMode").and_then(Value::as_str).map(ToString::to_string);
        let adapter = self.providers.get(&thread.provider_id).cloned();
        let self_tx = self.self_tx.clone();

        tokio::spawn(async move {
            let result = match adapter {
                Some(a) if !a.is_held() => {
                    a.configure_thread(
                        tid.clone(),
                        model_id.clone(),
                        runtime_mode.clone(),
                        reasoning_effort.clone(),
                    )
                    .await
                }
                _ => Ok(()),
            };
            let _ = self_tx.send(ActorMessage::AsyncCommandDone {
                lane,
                client,
                outcome: Box::new(AsyncCommandOutcome::ConfigureThread {
                    thread_id: tid,
                    model_id,
                    reasoning_effort,
                    runtime_mode,
                    provider_mode,
                    result,
                }),
                reply,
            });
        });
    }

    fn spawn_cmd_manual_send(
        &mut self,
        lane: Option<String>,
        client: ClientContext,
        command: &Map<String, Value>,
        reply: oneshot::Sender<Result<Value, CoordinatorError>>,
    ) {
        let Some(tid) = command.get("threadId").and_then(Value::as_str).map(ToString::to_string) else {
            self.finish_sync_command(lane, &client, Err(CoordinatorError::invalid("threadId is required.")), reply);
            return;
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
            self.finish_sync_command(lane, &client, Err(CoordinatorError::invalid("Unknown thread.")), reply);
            return;
        };
        let project_path = self
            .projects
            .iter()
            .find(|p| p.id == thread.project_id)
            .map(|p| p.path.clone())
            .unwrap_or_else(|| self.data_directory.to_string_lossy().into_owned());

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
        let has_image = attachments.iter().any(|a| a.handle.is_image());
        if has_image {
            let supports_images = if thread.model_id.is_empty() {
                true
            } else {
                self.models
                    .iter()
                    .find(|m| m.id == thread.model_id)
                    .and_then(|m| m.supports_images)
                    .unwrap_or(true)
            };
            if !supports_images {
                let now = now_iso();
                self.deliveries.push(AgentDelivery {
                    command_id,
                    draft_id,
                    thread_id: tid,
                    message_id: None,
                    status: "failed".into(),
                    error: Some("The selected model does not read images. Nothing was sent.".into()),
                    created_at: now.clone(),
                    updated_at: now,
                    local_feedback_ms: Some(0),
                    provider_latency_ms: None,
                });
                self.error = Some("The selected model does not read images. Nothing was sent.".into());
                self.finish_sync_command(lane, &client, Ok(()), reply);
                return;
            }
        }

        let Some(adapter) = self.providers.get(&thread.provider_id).cloned() else {
            self.finish_sync_command(lane, &client, Err(CoordinatorError::unavailable("Provider is not available.")), reply);
            return;
        };

        let needs_worktree = thread
            .worktree
            .as_ref()
            .is_some_and(|w| w.mode == "independent" && (w.status == "pending" || w.path.is_none()));
        let base_branch = thread
            .worktree
            .as_ref()
            .and_then(|w| w.base_branch.clone());
        let existing_cwd = thread
            .worktree
            .as_ref()
            .and_then(|w| w.path.clone())
            .or_else(|| thread.working_directory.clone())
            .unwrap_or_else(|| project_path.clone());
        let data_dir = self.data_directory.clone();
        let self_tx = self.self_tx.clone();
        let model_opt = (!thread.model_id.is_empty()).then_some(thread.model_id.clone());

        let message_id = Uuid::new_v4().to_string();
        self.in_flight_sends.insert(
            tid.clone(),
            InFlightSend {
                message_id: message_id.clone(),
                command_id: command_id.clone(),
                text: text.clone(),
                attachments: attachments.clone(),
                created_at: now_iso(),
                flushed: false,
                turn_already_completed: None,
            },
        );

        tokio::spawn(async move {
            let started = Instant::now();
            let mut allocated_worktree = None;
            let cwd = if needs_worktree {
                let alloc = tokio::task::spawn_blocking(move || {
                    allocate_independent_worktree(&data_dir, &project_path, base_branch.as_deref())
                })
                .await
                .map_err(|_| "Could not create worktree.".to_string())
                .and_then(|r| r);
                match alloc {
                    Ok(wt) => {
                        let path = wt.path.clone().unwrap_or_default();
                        allocated_worktree = Some(Box::new(wt));
                        path
                    }
                    Err(err) => {
                        let _ = self_tx.send(ActorMessage::AsyncCommandDone {
                            lane,
                            client,
                            outcome: Box::new(AsyncCommandOutcome::ManualSend {
                                thread_id: tid,
                                command_id,
                                draft_id,
                                text,
                                attachments,
                                elapsed_ms: started.elapsed().as_millis() as u64,
                                allocated_worktree: None,
                                result: Err(err),
                            }),
                            reply,
                        });
                        return;
                    }
                }
            } else {
                existing_cwd
            };

            let result = adapter
                .send_message(SendMessageRequest {
                    thread_id: tid.clone(),
                    message_id,
                    cwd,
                    model_id: model_opt,
                    reasoning_effort: thread.reasoning_effort.clone(),
                    runtime_mode: thread.runtime_mode.clone(),
                    text: text.clone(),
                    command_id: command_id.clone(),
                    draft_id: draft_id.clone(),
                    attachments: attachments.clone(),
                })
                .await;

            let _ = self_tx.send(ActorMessage::AsyncCommandDone {
                lane,
                client,
                outcome: Box::new(AsyncCommandOutcome::ManualSend {
                    thread_id: tid,
                    command_id,
                    draft_id,
                    text,
                    attachments,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    allocated_worktree,
                    result,
                }),
                reply,
            });
        });
    }

    fn spawn_cmd_answer(
        &mut self,
        lane: Option<String>,
        client: ClientContext,
        command: &Map<String, Value>,
        reply: oneshot::Sender<Result<Value, CoordinatorError>>,
    ) {
        let Some(tid) = command.get("threadId").and_then(Value::as_str).map(ToString::to_string) else {
            self.finish_sync_command(lane, &client, Err(CoordinatorError::invalid("threadId is required.")), reply);
            return;
        };
        let Some(request_id) = command.get("requestId").and_then(Value::as_str).map(ToString::to_string) else {
            self.finish_sync_command(lane, &client, Err(CoordinatorError::invalid("requestId is required.")), reply);
            return;
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
        let skipped = command.get("skipped").and_then(Value::as_bool);

        let (provider_id, title) = {
            let Some(thread) = self.threads.iter().find(|t| t.id == tid) else {
                self.finish_sync_command(lane, &client, Err(CoordinatorError::invalid("Unknown thread.")), reply);
                return;
            };
            let has_req = thread
                .requests
                .iter()
                .any(|r| r.get("id").and_then(Value::as_str) == Some(request_id.as_str()));
            if !has_req {
                self.finish_sync_command(
                    lane,
                    &client,
                    Err(CoordinatorError::stale(HostErrorCode::StaleRequest.default_message())),
                    reply,
                );
                return;
            }
            (thread.provider_id.clone(), thread.title.clone())
        };

        let Some(adapter) = self.providers.get(&provider_id).cloned() else {
            self.finish_sync_command(lane, &client, Err(CoordinatorError::unavailable("Provider is not available.")), reply);
            return;
        };

        let self_tx = self.self_tx.clone();
        let answer_client = client.clone();
        tokio::spawn(async move {
            let result = adapter
                .answer_request(AnswerRequestInput {
                    thread_id: tid.clone(),
                    request_id: request_id.clone(),
                    answer,
                    approved,
                    permission_choice: permission_choice.clone(),
                    question_answers,
                    skipped,
                })
                .await;
            let _ = self_tx.send(ActorMessage::AsyncCommandDone {
                lane,
                client: answer_client.clone(),
                outcome: Box::new(AsyncCommandOutcome::Answer {
                    thread_id: tid,
                    request_id,
                    title,
                    approved,
                    permission_choice,
                    client: answer_client,
                    result,
                }),
                reply,
            });
        });
    }

    fn spawn_cmd_interrupt(
        &mut self,
        lane: Option<String>,
        client: ClientContext,
        command: &Map<String, Value>,
        reply: oneshot::Sender<Result<Value, CoordinatorError>>,
    ) {
        let Some(tid) = command.get("threadId").and_then(Value::as_str).map(ToString::to_string) else {
            self.finish_sync_command(lane, &client, Err(CoordinatorError::invalid("threadId is required.")), reply);
            return;
        };
        let Some(provider_id) = self
            .threads
            .iter()
            .find(|t| t.id == tid)
            .map(|t| t.provider_id.clone())
        else {
            self.finish_sync_command(lane, &client, Err(CoordinatorError::invalid("Unknown thread.")), reply);
            return;
        };
        let adapter = self.providers.get(&provider_id).cloned();
        let self_tx = self.self_tx.clone();
        tokio::spawn(async move {
            let result = match adapter {
                Some(a) => a.interrupt(tid.clone()).await,
                None => Ok(()),
            };
            let _ = self_tx.send(ActorMessage::AsyncCommandDone {
                lane,
                client,
                outcome: Box::new(AsyncCommandOutcome::Interrupt {
                    thread_id: tid,
                    result,
                }),
                reply,
            });
        });
    }

    fn spawn_cmd_compact(
        &mut self,
        lane: Option<String>,
        client: ClientContext,
        command: &Map<String, Value>,
        reply: oneshot::Sender<Result<Value, CoordinatorError>>,
    ) {
        let Some(tid) = command.get("threadId").and_then(Value::as_str).map(ToString::to_string) else {
            self.finish_sync_command(lane, &client, Err(CoordinatorError::invalid("threadId is required.")), reply);
            return;
        };
        let Some(provider_id) = self
            .threads
            .iter()
            .find(|t| t.id == tid)
            .map(|t| t.provider_id.clone())
        else {
            self.finish_sync_command(lane, &client, Err(CoordinatorError::invalid("Unknown thread.")), reply);
            return;
        };
        let adapter = self.providers.get(&provider_id).cloned();
        let self_tx = self.self_tx.clone();
        tokio::spawn(async move {
            let result = match adapter {
                Some(a) => a.compact(tid).await,
                None => Ok(()),
            };
            let _ = self_tx.send(ActorMessage::AsyncCommandDone {
                lane,
                client,
                outcome: Box::new(AsyncCommandOutcome::Compact { result }),
                reply,
            });
        });
    }

    fn commit_async_command(
        &mut self,
        client: &ClientContext,
        outcome: AsyncCommandOutcome,
    ) -> Result<Value, CoordinatorError> {
        match outcome {
            AsyncCommandOutcome::Connect {
                explicit,
                outcomes,
                suppress_notice,
            } => {
                let mut first_error: Option<String> = None;
                let mut connected_name: Option<String> = None;
                for (provider_id, result) in outcomes {
                    if let Some(adapter) = self.providers.get(&provider_id).cloned() {
                        self.provider_statuses
                            .insert(provider_id.clone(), adapter.status());
                        match result {
                            Ok(()) => {
                                connected_name = Some(adapter.name().to_string());
                            }
                            Err(err) => {
                                if first_error.is_none() {
                                    first_error = Some(err);
                                }
                            }
                        }
                    }
                }
                self.rebuild_catalog();
                if explicit {
                    if let Some(err) = first_error {
                        self.error = Some(err.clone());
                        return Err(CoordinatorError::unavailable(err));
                    }
                    if !suppress_notice {
                        if let Some(name) = connected_name {
                            self.notice = format!("{name} connected");
                        }
                    }
                    self.error = None;
                } else {
                    self.error = None;
                }
            }
            AsyncCommandOutcome::Disconnect { provider_ids } => {
                for provider_id in provider_ids {
                    if let Some(adapter) = self.providers.get(&provider_id).cloned() {
                        self.provider_statuses.insert(provider_id, adapter.status());
                    }
                }
                self.rebuild_catalog();
            }
            AsyncCommandOutcome::ConfigureThread {
                thread_id,
                model_id,
                reasoning_effort,
                runtime_mode,
                provider_mode,
                result,
            } => {
                result.map_err(CoordinatorError::unavailable)?;
                if let Some(thread) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    if let Some(m) = model_id {
                        thread.model_id = m;
                    }
                    if let Some(e) = reasoning_effort {
                        thread.reasoning_effort = Some(e);
                    }
                    if let Some(r) = runtime_mode {
                        thread.runtime_mode = Some(r);
                    }
                    if let Some(p) = provider_mode {
                        thread.provider_mode = Some(p);
                    }
                    thread.updated_at = now_iso();
                    self.save_workspace();
                }
            }
            AsyncCommandOutcome::ManualSend {
                thread_id,
                command_id,
                draft_id,
                text,
                attachments,
                elapsed_ms,
                allocated_worktree,
                result,
            } => {
                let in_flight = self.in_flight_sends.remove(&thread_id);
                if let Some(wt) = allocated_worktree {
                    if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                        t.working_directory = wt.path.clone();
                        t.worktree = Some(*wt);
                    }
                }
                let ack = result.map_err(CoordinatorError::unavailable)?;
                let now = now_iso();
                let message_id = if let Some(flushed_id) =
                    in_flight.as_ref().filter(|f| f.flushed).map(|f| f.message_id.clone())
                {
                    flushed_id
                } else {
                    let stored_attachments = encode_stored_attachments(&attachments);
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
                        &thread_id,
                        &ThreadEvent::MessageAdded {
                            at: now.clone(),
                            message: user_message.clone(),
                            redacted: None,
                        },
                    );
                    self.push_message_to_detail(&thread_id, user_message);
                    ack.message_id.clone()
                };

                let is_accepted = ack.status == "accepted";
                let turn_already_completed =
                    in_flight.and_then(|f| f.turn_already_completed);
                if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    if is_accepted {
                        if let Some(done_status) = turn_already_completed {
                            if t.last_turn.is_none() {
                                t.last_turn = Some(AgentTurnRecord {
                                    id: ack.turn_id.clone(),
                                    status: done_status,
                                    message_id: Some(message_id.clone()),
                                });
                            }
                        } else {
                            t.status = "running".into();
                            t.last_turn = Some(AgentTurnRecord {
                                id: ack.turn_id.clone(),
                                status: "running".into(),
                                message_id: Some(message_id.clone()),
                            });
                        }
                    }
                    t.native_session_started = true;
                    t.last_user_message_id = Some(message_id.clone());
                    t.updated_at = now.clone();
                    if let Some(detail) = self.details.get(&thread_id) {
                        t.summary =
                            summarize_thread(&detail.messages, &detail.activities, &t.status);
                    }
                }

                self.deliveries.push(AgentDelivery {
                    command_id,
                    draft_id: draft_id.clone(),
                    thread_id: thread_id.clone(),
                    message_id: Some(message_id),
                    status: ack.status,
                    error: None,
                    created_at: now.clone(),
                    updated_at: now,
                    local_feedback_ms: Some(elapsed_ms),
                    provider_latency_ms: is_accepted.then_some(ack.provider_latency_ms),
                });
                self.delivered_drafts.push(DeliveredDraft {
                    draft_id,
                    thread_id,
                });
                self.save_workspace();
            }
            AsyncCommandOutcome::Answer {
                thread_id,
                request_id,
                title,
                approved,
                permission_choice,
                client: answer_client,
                result,
            } => {
                result.map_err(CoordinatorError::unavailable)?;
                let _ = self.thread_store.append_event(
                    &thread_id,
                    &ThreadEvent::AnswerGiven {
                        at: now_iso(),
                        request_id: request_id.clone(),
                        answer: None,
                        approved,
                        permission_choice,
                        question_option_ids: None,
                        attribution: ThreadEventAttribution {
                            client_id: answer_client.client_id,
                            user: Some(answer_client.user),
                            transport: "socket".into(),
                        },
                    },
                );
                if let Some(thread) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    thread
                        .requests
                        .retain(|r| r.get("id").and_then(Value::as_str) != Some(request_id.as_str()));
                    thread.updated_at = now_iso();
                }
                self.notice = format!("Answered {title}.");
            }
            AsyncCommandOutcome::Interrupt { thread_id, result } => {
                result.map_err(CoordinatorError::unavailable)?;
                self.finish_turn(&thread_id, "interrupted");
            }
            AsyncCommandOutcome::Compact { result } => {
                result.map_err(CoordinatorError::unavailable)?;
            }
        }
        Ok(self.build_shell(client.may_answer))
    }

    fn cmd_configure(&mut self, command: &Map<String, Value>) -> Result<(), CoordinatorError> {
        let Some(patch) = command.get("patch").and_then(Value::as_object) else {
            return Err(CoordinatorError::invalid("Configure needs a patch object."));
        };
        let before_enabled = self.configuration.enabled_providers.clone();
        self.configuration
            .apply_patch(patch)
            .map_err(CoordinatorError::invalid)?;
        let available = self.available_providers();
        let mut to_disconnect: Vec<String> = Vec::new();
        if patch.contains_key("disconnectedProviders") {
            let off_owned = self.configuration.disconnected_providers.clone().unwrap_or_default();
            let off: HashSet<&str> = off_owned.iter().map(String::as_str).collect();
            self.configuration.set_disconnected_providers(&off, &available);
            for id in &before_enabled {
                if off.contains(id.as_str()) {
                    to_disconnect.push(id.clone());
                }
            }
        } else if patch.contains_key("enabledProviders") {
            let next_enabled = self.configuration.enabled_providers.clone();
            let removed: Vec<String> = before_enabled
                .iter()
                .filter(|p| !next_enabled.contains(p))
                .cloned()
                .collect();
            let removed_refs: Vec<&str> = removed.iter().map(String::as_str).collect();
            let next_refs: Vec<&str> = next_enabled.iter().map(String::as_str).collect();
            self.configuration
                .mark_providers_turned_off(&removed_refs, &next_refs, &available);
            to_disconnect = removed;
        }
        for provider_id in to_disconnect {
            if let Some(adapter) = self.providers.get(&provider_id).cloned() {
                tokio::spawn(async move {
                    let _ = adapter.disconnect().await;
                });
                if let Some(status) = self.provider_statuses.get_mut(&provider_id) {
                    status.connection = "disconnected".into();
                    status.error = None;
                }
            }
        }
        self.rebuild_catalog();
        self.save_workspace();
        Ok(())
    }

    fn cmd_refresh(&mut self, command: &Map<String, Value>) -> Result<(), CoordinatorError> {
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
            extra: Map::new(),
        };
        self.projects.push(project);
        self.active_project_id = Some(id);
        self.save_workspace();
        Ok(())
    }

    fn cmd_create_thread(&mut self, command: &Map<String, Value>) -> Result<(), CoordinatorError> {
        let Some(project_id) = command.get("projectId").and_then(Value::as_str) else {
            return Err(CoordinatorError::invalid("Thread projectId is required."));
        };
        let Some(project) = self.projects.iter().find(|p| p.id == project_id).cloned() else {
            return Err(CoordinatorError::invalid("Unknown project."));
        };
        let model_id = command
            .get("modelId")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_default();
        let provider_id = parse_public_provider_entity_id(&model_id)
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
        let base_branch = command
            .get("baseBranch")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if let Some(ref base) = base_branch {
            if !crate::ops::is_valid_git_base_ref(base) {
                return Err(CoordinatorError::invalid("Invalid base branch name."));
            }
        }
        let start_from_origin = command
            .get("startFromOrigin")
            .and_then(Value::as_bool);
        let existing_worktree_path = command
            .get("existingWorktreePath")
            .and_then(Value::as_str)
            .map(ToString::to_string);

        let (worktree, working_directory) = if working_copy == "independent" {
            if let Some(ref existing) = existing_worktree_path {
                if !Path::new(existing).is_dir() {
                    return Err(CoordinatorError::invalid(
                        "The selected existing worktree folder does not exist.",
                    ));
                }
                (
                    AgentThreadWorktree {
                        mode: "independent".into(),
                        status: "ready".into(),
                        path: Some(existing.clone()),
                        repository_root: None,
                        branch: None,
                        base_branch,
                        start_from_origin,
                        existing_worktree_path: Some(existing.clone()),
                        reused: Some(true),
                        temporary_branch: Some(false),
                        error: None,
                        git: None,
                    },
                    Some(existing.clone()),
                )
            } else {
                // Separate worktree is allocated on first send (AGENTS.md / ADR-0014),
                // never silently reusing the shared checkout.
                (
                    AgentThreadWorktree {
                        mode: "independent".into(),
                        status: "pending".into(),
                        path: None,
                        repository_root: None,
                        branch: None,
                        base_branch,
                        start_from_origin,
                        existing_worktree_path: None,
                        reused: None,
                        temporary_branch: None,
                        error: None,
                        git: None,
                    },
                    None,
                )
            }
        } else {
            (
                AgentThreadWorktree {
                    mode: "shared".into(),
                    status: "ready".into(),
                    path: Some(project.path.clone()),
                    repository_root: None,
                    branch: None,
                    base_branch: None,
                    start_from_origin: None,
                    existing_worktree_path: None,
                    reused: None,
                    temporary_branch: None,
                    error: None,
                    git: None,
                },
                Some(project.path.clone()),
            )
        };

        let now = now_iso();
        let thread = AgentThread {
            id: thread_id.clone(),
            project_id: project.id.clone(),
            provider_id: provider_id.clone(),
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
            updated_at: now.clone(),
            settled_at: None,
            working_directory,
            last_user_message_id: None,
            last_turn: None,
            messages: Vec::new(),
            requests: Vec::new(),
            activities: Vec::new(),
            summary: summarize_thread(&[], &[], "idle"),
            worktree: Some(worktree),
            extra: Map::new(),
        };
        self.thread_bindings
            .entry(thread_id.clone())
            .or_insert_with(|| ThreadBindingRecord {
                thread_id: thread_id.clone(),
                provider: provider_id,
                session_id: thread_id.clone(),
                project_id: project.id,
                created_at: now,
            });
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
                let flushed_id = self.flush_in_flight_user_message(&thread_id);
                self.upsert_activity_in_detail(&thread_id, activity);
                if let Some(thread) = self.threads.iter_mut().find(|t| t.id == thread_id) {
                    thread.status = "running".into();
                    thread.last_turn = Some(AgentTurnRecord {
                        id: turn_id,
                        status: "running".into(),
                        message_id: after_message_id.or(flushed_id),
                    });
                    if let Some(detail) = self.details.get(&thread_id) {
                        thread.summary =
                            summarize_thread(&detail.messages, &detail.activities, &thread.status);
                    }
                }
                self.shell_dirty = true;
            }
            ProviderEvent::MessageAdded { thread_id, message } => {
                self.flush_in_flight_user_message(&thread_id);
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
                self.flush_in_flight_user_message(&thread_id);
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
                self.flush_in_flight_user_message(&thread_id);
                self.upsert_activity_in_detail(&thread_id, activity);
                self.refresh_thread_summary(&thread_id);
                self.shell_dirty = true;
            }
            ProviderEvent::RequestOpened { thread_id, request } => {
                self.flush_in_flight_user_message(&thread_id);
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
                self.flush_in_flight_user_message(&thread_id);
                if let Some(in_flight) = self.in_flight_sends.get_mut(&thread_id) {
                    in_flight.turn_already_completed = Some(status.clone());
                }
                self.finish_turn(&thread_id, &status);
            }
        }
    }

    fn flush_in_flight_user_message(&mut self, thread_id: &str) -> Option<String> {
        let user_message = {
            let in_flight = self.in_flight_sends.get_mut(thread_id)?;
            if in_flight.flushed {
                return Some(in_flight.message_id.clone());
            }
            in_flight.flushed = true;
            StoredMessage {
                id: in_flight.message_id.clone(),
                role: "user".into(),
                text: in_flight.text.clone(),
                created_at: in_flight.created_at.clone(),
                command_id: Some(in_flight.command_id.clone()),
                turn_message_id: None,
                attachments: encode_stored_attachments(&in_flight.attachments),
                watcher_own_change: None,
                watcher_observed_changes: None,
                provider_error: None,
            }
        };
        let message_id = user_message.id.clone();
        let _ = self.thread_store.append_event(
            thread_id,
            &ThreadEvent::MessageAdded {
                at: user_message.created_at.clone(),
                message: user_message.clone(),
                redacted: None,
            },
        );
        self.push_message_to_detail(thread_id, user_message);
        if let Some(t) = self.threads.iter_mut().find(|t| t.id == thread_id) {
            t.native_session_started = true;
            t.last_user_message_id = Some(message_id.clone());
        }
        Some(message_id)
    }

    fn finish_turn(&mut self, thread_id: &str, status: &str) {
        let now = now_iso();
        if let Some(detail) = self.details.get_mut(thread_id) {
            let mut changed = false;
            for (idx, act) in detail.activities.iter_mut().enumerate() {
                if act.get("kind").and_then(Value::as_str) == Some("turn")
                    && act.get("status").and_then(Value::as_str) == Some("running")
                {
                    if let Some(obj) = act.as_object_mut() {
                        obj.insert("status".into(), Value::String(status.to_string()));
                        obj.insert("completedAt".into(), Value::String(now.clone()));
                        let title = match status {
                            "interrupted" => "Turn interrupted",
                            "failed" => "Turn failed",
                            _ => "Turn completed",
                        };
                        obj.insert("title".into(), Value::String(title.into()));
                        changed = true;
                    }
                    let _ = self.thread_store.upsert_activity(thread_id, idx as i64, act);
                }
            }
            if changed {
                detail.revision += 1;
                self.dirty_details.insert(thread_id.to_string());
            }
        }
        if let Some(thread) = self.threads.iter_mut().find(|t| t.id == thread_id) {
            thread.status = if status == "failed" { "error" } else { "idle" }.into();
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
        let position = if let Some(id) = activity.get("id").and_then(Value::as_str) {
            if let Some((idx, existing)) = detail
                .activities
                .iter_mut()
                .enumerate()
                .find(|(_, a)| a.get("id").and_then(Value::as_str) == Some(id))
            {
                *existing = activity;
                idx
            } else {
                detail.activities.push(activity);
                detail.activities.len() - 1
            }
        } else {
            detail.activities.push(activity);
            detail.activities.len() - 1
        };
        detail.revision += 1;
        // O(1) incremental upsert: never rewrite all past activity rows on every update.
        let _ = self
            .thread_store
            .upsert_activity(thread_id, position as i64, &detail.activities[position]);
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
        let host_version = active_provider
            .map(|p| p.version.as_str())
            .filter(|v| !v.is_empty())
            .unwrap_or(HOST_VERSION);

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
                "version": host_version,
            },
            "membership": { "status": "beta", "label": "", "expiresAt": null },
            "notice": self.notice,
            "pendingRequest": "",
            "queue": [],
            "speech": { "id": 0, "text": "" },
            "voice": { "action": "none", "error": null, "revision": 0, "status": "off" },
        })
    }

    fn save_workspace(&self) {
        // Persist `workspace.json` in TypeScript's exact `workspaceSchema` format:
        // `{ snapshot, projectAliases, creations, clearedThreadIds }`, preserving extra fields.
        let mut snapshot = self.snapshot_extra.clone();
        snapshot.insert("hostId".into(), Value::String(self.host_id.clone()));
        snapshot.insert("connected".into(), Value::Bool(false));
        snapshot.insert(
            "name".into(),
            Value::String(provider_label(&self.configuration.provider).to_string()),
        );
        snapshot.insert("version".into(), Value::String(HOST_VERSION.into()));
        snapshot.insert(
            "capabilities".into(),
            serde_json::to_value(AgentCapabilities::none()).unwrap_or_else(|_| json!({})),
        );
        snapshot.insert(
            "models".into(),
            serde_json::to_value(&self.models).unwrap_or_else(|_| json!([])),
        );
        snapshot.insert(
            "projects".into(),
            serde_json::to_value(&self.projects).unwrap_or_else(|_| json!([])),
        );
        let stored_threads: Vec<Value> = self
            .threads
            .iter()
            .map(|t| {
                let mut val = serde_json::to_value(t).unwrap_or_else(|_| json!({}));
                if let Some(obj) = val.as_object_mut() {
                    obj.insert("messages".into(), Value::Array(Vec::new()));
                    obj.remove("summary");
                }
                val
            })
            .collect();
        snapshot.insert("threads".into(), Value::Array(stored_threads));

        let mut file_obj = self.file_extra.clone();
        file_obj.insert("snapshot".into(), Value::Object(snapshot));
        file_obj.insert("projectAliases".into(), Value::Array(self.project_aliases.clone()));
        file_obj.insert("creations".into(), Value::Array(self.creations.clone()));
        file_obj.insert(
            "clearedThreadIds".into(),
            serde_json::to_value(&self.cleared_thread_ids).unwrap_or_else(|_| json!([])),
        );
        file_obj.insert(
            "configuration".into(),
            serde_json::to_value(&self.configuration).unwrap_or_else(|_| json!({})),
        );
        let _ = write_atomic_json(&self.data_directory.join("workspace.json"), &Value::Object(file_obj));

        // Persist `threads.json` in TypeScript `ThreadRegistry` format (`{ bindings: [{ threadId, provider, sessionId, projectId, createdAt }] }`),
        // preserving all existing bindings (including bindings for other/unloaded providers).
        let mut merged = self.thread_bindings.clone();
        for t in &self.threads {
            merged.entry(t.id.clone()).or_insert_with(|| ThreadBindingRecord {
                thread_id: t.id.clone(),
                provider: t.provider_id.clone(),
                session_id: t.id.clone(),
                project_id: t.project_id.clone(),
                created_at: if t.created_at.is_empty() {
                    now_iso()
                } else {
                    t.created_at.clone()
                },
            });
        }
        let mut registry_bindings: Vec<ThreadBindingRecord> = merged.into_values().collect();
        registry_bindings
            .sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.thread_id.cmp(&b.thread_id)));
        let registry = json!({ "bindings": registry_bindings });
        let _ = write_atomic_json(&self.data_directory.join("threads.json"), &registry);

        // Persist `agents.json` preserving every existing Node field so switching between
        // Node and Rust hosts never loses provider choices (`disconnectedProviders`) or
        // Node-only coordinator records (`savedSchema` in `src/main/agents/control.ts`).
        let mut agents_obj = self.agents_json_extra.clone();
        agents_obj.insert(
            "configuration".into(),
            self.configuration
                .to_node_agents_json(&self.agents_config_extra),
        );
        agents_obj
            .entry("activeThreadId".to_string())
            .or_insert(Value::Null);
        agents_obj
            .entry("activeProjectId".to_string())
            .or_insert(Value::Null);
        agents_obj
            .entry("draft".to_string())
            .or_insert_with(|| Value::String(String::new()));
        agents_obj
            .entry("draftThreadId".to_string())
            .or_insert(Value::Null);
        agents_obj
            .entry("composing".to_string())
            .or_insert(Value::Bool(false));
        agents_obj
            .entry("outbox".to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        let _ = write_atomic_json(&self.data_directory.join("agents.json"), &Value::Object(agents_obj));
    }
}

struct LoadedAgentsJson {
    extra: Map<String, Value>,
    config_extra: Map<String, Value>,
    configuration: Option<AgentConfiguration>,
}

const KNOWN_NODE_CONFIG_KEYS: &[&str] = &[
    "provider",
    "enabledProviders",
    "disconnectedProviders",
    "enabled",
    "projectsDirectory",
    "defaultModelId",
    "reasoning",
    "reasoningModel",
    "reasoningEffort",
    "checkClientUpdates",
    "museDisableSandbox",
    "claudeUltracodeEffort",
    "antigravitySignInMethod",
    "antigravityProject",
    "antigravityLocation",
    "antigravityBinaryPath",
    "newThreadModelId",
    "newThreadReasoningEffort",
    "newThreadSpeed",
    "newThreadRuntimeMode",
];

/// Loads `agents.json` (Node's `savedSchema`) when present, returning its preserved non-configuration
/// fields alongside its `AgentConfiguration` (and any unknown configuration fields preserved only
/// for `agents.json`, never leaked into shell snapshots). Fails closed on unreadable or malformed
/// existing files so a broken file never silently reconnects providers the user disconnected.
fn load_agents_json(dir: &Path) -> Result<Option<LoadedAgentsJson>, String> {
    let path = dir.join("agents.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Could not read saved agents.json: {err}")),
    };
    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|err| format!("Saved agents.json is not valid JSON: {err}"))?;
    let Some(mut root) = parsed.as_object().cloned() else {
        return Err("Saved agents.json must be a JSON object.".into());
    };
    let mut config_extra = Map::new();
    let configuration = match root.remove("configuration") {
        Some(v) => {
            if let Some(obj) = v.as_object() {
                for (k, val) in obj {
                    if !KNOWN_NODE_CONFIG_KEYS.contains(&k.as_str()) {
                        config_extra.insert(k.clone(), val.clone());
                    }
                }
            }
            Some(
                serde_json::from_value::<AgentConfiguration>(v)
                    .map_err(|err| format!("Saved agents.json has invalid configuration: {err}"))?,
            )
        }
        None => None,
    };
    Ok(Some(LoadedAgentsJson {
        extra: root,
        config_extra,
        configuration,
    }))
}

/// Loads `workspace.json` in TypeScript's `workspaceSchema` format (`{ snapshot, projectAliases, creations, clearedThreadIds }`)
/// together with provider configuration from `agents.json`.
/// Refuses corrupt or unreadable existing files instead of replacing saved state with defaults.
fn load_persisted_workspace(dir: &Path) -> Result<LoadedWorkspace, String> {
    let (agents_json_extra, agents_config_extra, agents_configuration) =
        match load_agents_json(dir)? {
            Some(loaded) => (loaded.extra, loaded.config_extra, loaded.configuration),
            None => (Map::new(), Map::new(), None),
        };

    let path = dir.join("workspace.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let had_saved_configuration = agents_configuration.is_some();
            return Ok(LoadedWorkspace {
                agents_json_extra,
                agents_config_extra,
                had_saved_configuration,
                configuration: agents_configuration.unwrap_or_default(),
                ..LoadedWorkspace::default()
            });
        }
        Err(err) => {
            return Err(format!("Could not read saved workspace.json: {err}"));
        }
    };
    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|err| format!("Saved workspace.json is not valid JSON: {err}"))?;
    let Some(mut root) = parsed.as_object().cloned() else {
        return Err("Saved workspace.json must be a JSON object.".into());
    };

    let Some(snapshot_val) = root.remove("snapshot") else {
        return Err("Saved workspace.json is missing required snapshot object.".into());
    };
    let Some(mut snapshot) = snapshot_val.as_object().cloned() else {
        return Err("Saved workspace.json snapshot must be a JSON object.".into());
    };

    let projects: Vec<AgentProject> = match snapshot.remove("projects") {
        Some(v) => serde_json::from_value(v)
            .map_err(|err| format!("Saved workspace.json has invalid projects: {err}"))?,
        None => Vec::new(),
    };
    let threads: Vec<AgentThread> = match snapshot.remove("threads") {
        Some(v) => serde_json::from_value(v)
            .map_err(|err| format!("Saved workspace.json has invalid threads: {err}"))?,
        None => Vec::new(),
    };
    let project_aliases = root
        .remove("projectAliases")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let creations = root
        .remove("creations")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let cleared_thread_ids = root
        .remove("clearedThreadIds")
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default();
    let workspace_configuration = root
        .remove("configuration")
        .and_then(|v| serde_json::from_value::<AgentConfiguration>(v).ok());
    let had_saved_configuration = agents_configuration.is_some() || workspace_configuration.is_some();
    let configuration = agents_configuration
        .or(workspace_configuration)
        .unwrap_or_default();

    Ok(LoadedWorkspace {
        projects,
        threads,
        project_aliases,
        creations,
        cleared_thread_ids,
        snapshot_extra: snapshot,
        file_extra: root,
        agents_json_extra,
        agents_config_extra,
        had_saved_configuration,
        configuration,
    })
}

fn load_thread_bindings(dir: &Path) -> HashMap<String, ThreadBindingRecord> {
    let path = dir.join("threads.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(val) = serde_json::from_str::<Value>(&raw) else {
        return HashMap::new();
    };
    let mut map = HashMap::new();
    if let Some(arr) = val.get("bindings").and_then(Value::as_array) {
        for item in arr {
            if let Ok(rec) = serde_json::from_value::<ThreadBindingRecord>(item.clone()) {
                map.entry(rec.thread_id.clone()).or_insert(rec);
            }
        }
    }
    map
}

fn allocate_independent_worktree(
    data_dir: &Path,
    project_path: &str,
    base_branch: Option<&str>,
) -> Result<AgentThreadWorktree, String> {
    let repo_root = run_git_sync(project_path, &["rev-parse", "--show-toplevel"])
        .map(|s| s.trim().to_string())
        .map_err(|_| "Separate worktrees require a Git repository.".to_string())?;
    let token = &Uuid::new_v4().simple().to_string()[..8];
    let branch = format!("sotto/{token}");
    let worktrees_root = data_dir.join("thread-worktrees");
    std::fs::create_dir_all(&worktrees_root)
        .map_err(|e| format!("Could not create thread-worktrees folder: {e}"))?;
    let wt_path = worktrees_root.join(token);
    let wt_str = wt_path.to_string_lossy().into_owned();

    let mut args = vec!["worktree", "add", "-b", &branch, &wt_str];
    if let Some(base) = base_branch.map(str::trim).filter(|b| !b.is_empty()) {
        if !crate::ops::is_valid_git_base_ref(base) {
            return Err("Invalid base branch name.".to_string());
        }
        args.push(base);
    }
    run_git_sync(&repo_root, &args)
        .map_err(|e| format!("Could not create separate Git worktree: {e}"))?;

    Ok(AgentThreadWorktree {
        mode: "independent".into(),
        status: "ready".into(),
        path: Some(wt_str),
        repository_root: Some(repo_root),
        branch: Some(branch),
        base_branch: base_branch.map(ToString::to_string),
        start_from_origin: None,
        existing_worktree_path: None,
        reused: Some(false),
        temporary_branch: Some(true),
        error: None,
        git: None,
    })
}

fn run_git_sync(folder: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(folder);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn probe_git_worktree(folder: &str) -> Value {
    let branch = run_git_sync(folder, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string());
    match branch {
        Some(b) if !b.is_empty() => {
            let dirty = run_git_sync(folder, &["status", "--porcelain"])
                .map(|s| !s.is_empty())
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

fn encode_stored_attachments(attachments: &[StagedAttachmentEntry]) -> Option<Value> {
    if attachments.is_empty() {
        None
    } else {
        Some(Value::Array(
            attachments
                .iter()
                .map(|a| serde_json::to_value(&a.handle).unwrap_or(Value::Null))
                .collect(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{
        AnswerRequestInput, BoxFuture, MockProviderAdapter, ProviderAdapter, SendMessageAck,
        SendMessageRequest,
    };
    use std::sync::Mutex;
    use tempfile::tempdir;

    #[tokio::test]
    async fn runs_full_project_thread_send_question_answer_and_interrupt_flow() {
        let dir = tempdir().unwrap();
        let mock = Arc::new(MockProviderAdapter::new("codex"));
        let mut providers: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
        providers.insert("codex".into(), mock.clone());

        let coord = CoordinatorHandle::spawn(
            dir.path().to_path_buf(),
            "00000000-0000-4000-8000-000000000001".into(),
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
        assert!(shell["host"]["version"].is_string());
        assert!(shell["notice"].is_string());
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
        assert_eq!(shell["host"]["threads"][0]["worktree"]["status"], "ready");

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

        // Verify TS-compatible `workspace.json` and `threads.json` on disk.
        let ws_raw: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("workspace.json")).unwrap(),
        )
        .unwrap();
        assert!(ws_raw["snapshot"]["threads"].is_array());
        assert!(ws_raw["projectAliases"].is_array());
        assert!(ws_raw["creations"].is_array());
        assert!(ws_raw["clearedThreadIds"].is_array());

        let tb_raw: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("threads.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(tb_raw["bindings"][0]["provider"], "codex");
        assert!(tb_raw["bindings"][0]["createdAt"].is_string());
    }

    #[test]
    fn refuses_corrupt_workspace_json_instead_of_overwriting() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("workspace.json"), "{ not valid json").unwrap();
        assert!(load_persisted_workspace(dir.path()).is_err());
    }

    struct FastStreamingProvider {
        events_tx: Mutex<Option<mpsc::UnboundedSender<ProviderEvent>>>,
    }

    impl FastStreamingProvider {
        fn new() -> Self {
            Self {
                events_tx: Mutex::new(None),
            }
        }
    }

    impl ProviderAdapter for FastStreamingProvider {
        fn id(&self) -> &str {
            "claude"
        }
        fn name(&self) -> &str {
            "Claude Code"
        }
        fn status(&self) -> AgentProviderStatus {
            AgentProviderStatus {
                id: "claude".into(),
                name: "Claude Code".into(),
                connection: "connected".into(),
                version: "fixture".into(),
                capabilities: AgentCapabilities::none(),
                error: None,
            }
        }
        fn models(&self) -> Vec<AgentModel> {
            vec![AgentModel {
                id: "native:claude:model:sonnet".into(),
                provider_id: "claude".into(),
                provider: "Claude Code".into(),
                name: "Sonnet".into(),
                ready: true,
                reasoning_efforts: None,
                default_reasoning_effort: None,
                runtime_modes: None,
                provider_modes: None,
                supports_images: Some(false),
            }]
        }
        fn connect(
            &self,
            events: mpsc::UnboundedSender<ProviderEvent>,
        ) -> BoxFuture<'_, Result<(), String>> {
            *self.events_tx.lock().unwrap() = Some(events);
            Box::pin(async { Ok(()) })
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
            Box::pin(async { Ok(()) })
        }
        fn send_message(&self, req: SendMessageRequest) -> BoxFuture<'_, Result<SendMessageAck, String>> {
            // Emit TurnStarted, assistant output, and TurnCompleted BEFORE returning SendMessageAck,
            // simulating synchronous or fast-streaming providers like Claude/ACP/Devin.
            let msg_id = req.message_id;
            if let Some(tx) = self.events_tx.lock().unwrap().as_ref() {
                let _ = tx.send(ProviderEvent::TurnStarted {
                    thread_id: req.thread_id.clone(),
                    turn_id: "turn-fast".into(),
                    after_message_id: Some(msg_id.clone()),
                    activity: json!({
                        "id": "act-fast",
                        "kind": "turn",
                        "sequence": 0,
                        "startedAt": now_iso(),
                        "status": "running",
                        "timingSource": "provider",
                        "title": "Working",
                        "turnId": "turn-fast",
                        "afterMessageId": msg_id,
                    }),
                });
                let _ = tx.send(ProviderEvent::MessageAdded {
                    thread_id: req.thread_id.clone(),
                    message: StoredMessage {
                        id: "assistant-1".into(),
                        role: "assistant".into(),
                        text: "Fast reply before ack".into(),
                        created_at: now_iso(),
                        command_id: None,
                        turn_message_id: Some(msg_id.clone()),
                        attachments: None,
                        watcher_own_change: None,
                        watcher_observed_changes: None,
                        provider_error: None,
                    },
                });
                let _ = tx.send(ProviderEvent::TurnCompleted {
                    thread_id: req.thread_id,
                    turn_id: "turn-fast".into(),
                    status: "completed".into(),
                });
            }
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                Ok(SendMessageAck {
                    message_id: msg_id,
                    turn_id: "turn-fast".into(),
                    status: "accepted".into(),
                    provider_latency_ms: 30,
                })
            })
        }
        fn interrupt(&self, _thread_id: String) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn answer_request(&self, _input: AnswerRequestInput) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn compact(&self, _thread_id: String) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn late_manual_send_ack_does_not_overwrite_finished_turn_or_reorder_messages() {
        let dir = tempdir().unwrap();
        let fast = Arc::new(FastStreamingProvider::new());
        let mut providers: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
        providers.insert("claude".into(), fast);

        let coord = CoordinatorHandle::spawn(
            dir.path().to_path_buf(),
            "00000000-0000-4000-8000-000000000002".into(),
            false,
            providers,
        )
        .unwrap();
        let client = ClientContext {
            client_id: "c1".into(),
            user: "Test".into(),
            may_answer: true,
        };

        let shell = coord
            .run_command(
                client.clone(),
                json!({
                    "type": "create-project",
                    "provider": "claude",
                    "title": "Fast project",
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
        let thread_id = "00000000-0000-4000-8000-00000000000b";
        coord
            .run_command(
                client.clone(),
                json!({
                    "type": "create-thread",
                    "threadId": thread_id,
                    "projectId": project_id,
                    "title": "Fast thread",
                    "modelId": "native:claude:model:sonnet",
                    "workingCopy": "shared"
                })
                .as_object()
                .unwrap()
                .clone(),
            )
            .await
            .unwrap();

        let shell = coord
            .run_command(
                client,
                json!({
                    "type": "manual-send",
                    "threadId": thread_id,
                    "text": "User prompt first"
                })
                .as_object()
                .unwrap()
                .clone(),
            )
            .await
            .unwrap();
        assert_eq!(shell["host"]["threads"][0]["status"], "idle");
        assert_eq!(shell["host"]["threads"][0]["lastTurn"]["status"], "completed");

        let detail = coord.detail(thread_id.into()).await.unwrap().unwrap();
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[0].role, "user");
        assert_eq!(detail.messages[0].text, "User prompt first");
        assert_eq!(detail.messages[1].role, "assistant");
        assert_eq!(detail.messages[1].text, "Fast reply before ack");
        assert_eq!(
            detail.messages[1].turn_message_id.as_deref(),
            Some(detail.messages[0].id.as_str())
        );
        assert_eq!(
            detail.activities[0]["afterMessageId"].as_str(),
            Some(detail.messages[0].id.as_str())
        );
        assert_eq!(
            shell["host"]["threads"][0]["lastTurn"]["messageId"].as_str(),
            Some(detail.messages[0].id.as_str())
        );

        coord.shutdown().await;
    }

    #[tokio::test]
    async fn persists_configuration_changes_and_rejects_invalid_base_branch() {
        let dir = tempdir().unwrap();
        let mut providers: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
        providers.insert("codex".into(), Arc::new(MockProviderAdapter::new("codex")));

        let coord = CoordinatorHandle::spawn(
            dir.path().to_path_buf(),
            "00000000-0000-4000-8000-000000000003".into(),
            false,
            providers,
        )
        .unwrap();
        let client = ClientContext {
            client_id: "c1".into(),
            user: "Test".into(),
            may_answer: true,
        };

        coord
            .run_command(
                client.clone(),
                json!({
                    "type": "configure",
                    "patch": {
                        "provider": "claude",
                        "newThreadRuntimeMode": "full-access"
                    }
                })
                .as_object()
                .unwrap()
                .clone(),
            )
            .await
            .unwrap();

        let shell = coord
            .run_command(
                client.clone(),
                json!({
                    "type": "create-project",
                    "provider": "codex",
                    "title": "Base ref project",
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

        let bad_branch = coord
            .run_command(
                client,
                json!({
                    "type": "create-thread",
                    "projectId": project_id,
                    "title": "Bad branch",
                    "workingCopy": "independent",
                    "baseBranch": "--detach"
                })
                .as_object()
                .unwrap()
                .clone(),
            )
            .await;
        assert!(bad_branch.is_err());

        coord.shutdown().await;

        let mut providers2: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
        providers2.insert("codex".into(), Arc::new(MockProviderAdapter::new("codex")));
        let coord2 = CoordinatorHandle::spawn(
            dir.path().to_path_buf(),
            "00000000-0000-4000-8000-000000000003".into(),
            false,
            providers2,
        )
        .unwrap();
        let restored = coord2.shell(true).await.unwrap();
        assert_eq!(restored["configuration"]["provider"], "claude");
        assert_eq!(
            restored["configuration"]["newThreadRuntimeMode"],
            "full-access"
        );
        coord2.shutdown().await;
    }

    #[tokio::test]
    async fn respects_disconnected_providers_from_agents_json_at_startup_and_persists_changes() {
        let dir = tempdir().unwrap();
        // Seed a Node-style `agents.json` where the user disconnected `claude` and has extra Node keys.
        std::fs::write(
            dir.path().join("agents.json"),
            serde_json::to_string_pretty(&json!({
                "configuration": {
                    "provider": "codex",
                    "disconnectedProviders": ["claude"],
                    "enabledProviders": ["codex"],
                    "customNodeField": "preserved"
                },
                "activeThreadId": null,
                "activeProjectId": null,
                "draft": "keep me",
                "draftThreadId": null,
                "composing": false,
                "outbox": []
            }))
            .unwrap(),
        )
        .unwrap();

        let mut providers: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
        providers.insert("codex".into(), Arc::new(MockProviderAdapter::new("codex")));
        providers.insert("claude".into(), Arc::new(MockProviderAdapter::new("claude")));

        let coord = CoordinatorHandle::spawn(
            dir.path().to_path_buf(),
            "00000000-0000-4000-8000-000000000004".into(),
            false,
            providers,
        )
        .unwrap();

        let shell = coord.shell(true).await.unwrap();
        let providers_arr = shell["host"]["providers"].as_array().unwrap();
        let codex = providers_arr.iter().find(|p| p["id"] == "codex").unwrap();
        let claude = providers_arr.iter().find(|p| p["id"] == "claude").unwrap();
        assert_eq!(codex["connection"], "connected");
        assert_eq!(claude["connection"], "disconnected");
        assert_eq!(shell["configuration"]["disconnectedProviders"], json!(["claude"]));

        // Disconnecting codex persists both providers in `disconnectedProviders` and keeps Node's `draft`.
        let client = ClientContext {
            client_id: "c1".into(),
            user: "Test".into(),
            may_answer: true,
        };
        let after_disconnect = coord
            .run_command(
                client.clone(),
                json!({ "type": "disconnect", "provider": "codex" })
                    .as_object()
                    .unwrap()
                    .clone(),
            )
            .await
            .unwrap();
        assert_eq!(
            after_disconnect["configuration"]["disconnectedProviders"],
            json!(["codex", "claude"])
        );

        let saved_agents: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("agents.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved_agents["draft"], "keep me");
        assert_eq!(saved_agents["configuration"]["customNodeField"], "preserved");
        assert_eq!(
            saved_agents["configuration"]["disconnectedProviders"],
            json!(["codex", "claude"])
        );
        let cfg_obj = saved_agents["configuration"].as_object().unwrap();
        for forbidden in [
            "followupLimit",
            "grokSpeechVoice",
            "membershipEndpoint",
            "orbColor",
            "speak",
            "speechProvider",
            "speechVoice",
            "wakeModelDirectory",
            "wakeRuntimeDirectory",
        ] {
            assert!(
                !cfg_obj.contains_key(forbidden),
                "agents.json configuration must not include legacy key {forbidden}"
            );
        }

        // Reconnecting claude removes only claude from `disconnectedProviders`.
        let after_connect = coord
            .run_command(
                client,
                json!({ "type": "connect", "provider": "claude" })
                    .as_object()
                    .unwrap()
                    .clone(),
            )
            .await
            .unwrap();
        assert_eq!(
            after_connect["configuration"]["disconnectedProviders"],
            json!(["codex"])
        );
        coord.shutdown().await;
    }

    #[tokio::test]
    async fn respects_legacy_empty_enabled_providers_from_agents_json() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("agents.json"),
            serde_json::to_string_pretty(&json!({
                "configuration": {
                    "provider": "codex",
                    "enabledProviders": []
                },
                "activeThreadId": null,
                "activeProjectId": null,
                "draft": "",
                "draftThreadId": null,
                "composing": false,
                "outbox": []
            }))
            .unwrap(),
        )
        .unwrap();

        let mut providers: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
        providers.insert("codex".into(), Arc::new(MockProviderAdapter::new("codex")));
        providers.insert("claude".into(), Arc::new(MockProviderAdapter::new("claude")));

        let coord = CoordinatorHandle::spawn(
            dir.path().to_path_buf(),
            "00000000-0000-4000-8000-000000000005".into(),
            false,
            providers,
        )
        .unwrap();

        let shell = coord.shell(true).await.unwrap();
        let providers_arr = shell["host"]["providers"].as_array().unwrap();
        assert_eq!(
            providers_arr.iter().find(|p| p["id"] == "codex").unwrap()["connection"],
            "disconnected"
        );
        assert_eq!(
            providers_arr.iter().find(|p| p["id"] == "claude").unwrap()["connection"],
            "disconnected"
        );
        assert_eq!(
            shell["configuration"]["disconnectedProviders"],
            json!(ALL_PROVIDER_IDS)
        );
        coord.shutdown().await;
    }

    #[tokio::test]
    async fn plain_connect_does_not_reenable_turned_off_default_and_disconnect_all_covers_all_node_providers() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("agents.json"),
            serde_json::to_string_pretty(&json!({
                "configuration": {
                    "provider": "codex",
                    "disconnectedProviders": ["codex", "future-provider"],
                    "enabledProviders": ["claude"],
                    "unknownConfigKey": "keep-in-file-only"
                },
                "activeThreadId": null,
                "activeProjectId": null,
                "draft": "",
                "draftThreadId": null,
                "composing": false,
                "outbox": []
            }))
            .unwrap(),
        )
        .unwrap();

        let mut providers: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
        providers.insert("codex".into(), Arc::new(MockProviderAdapter::new("codex")));
        providers.insert("claude".into(), Arc::new(MockProviderAdapter::new("claude")));

        let coord = CoordinatorHandle::spawn(
            dir.path().to_path_buf(),
            "00000000-0000-4000-8000-000000000006".into(),
            false,
            providers,
        )
        .unwrap();

        let client = ClientContext {
            client_id: "c1".into(),
            user: "Test".into(),
            may_answer: true,
        };
        // N1: unknown configuration keys stay in agents.json and never leak into shell snapshots.
        let initial_shell = coord.shell(true).await.unwrap();
        assert!(initial_shell["configuration"].get("unknownConfigKey").is_none());

        // L3: plain `{ type: "connect" }` without a provider must NOT re-enable turned-off `codex`.
        let after_plain_connect = coord
            .run_command(
                client.clone(),
                json!({ "type": "connect" }).as_object().unwrap().clone(),
            )
            .await
            .unwrap();
        let providers_arr = after_plain_connect["host"]["providers"].as_array().unwrap();
        assert_eq!(
            providers_arr.iter().find(|p| p["id"] == "codex").unwrap()["connection"],
            "disconnected"
        );
        assert_eq!(
            providers_arr.iter().find(|p| p["id"] == "claude").unwrap()["connection"],
            "connected"
        );
        assert_eq!(
            after_plain_connect["configuration"]["disconnectedProviders"],
            json!(["codex", "future-provider"])
        );

        // L2: disconnect-all turns off ALL_PROVIDER_IDS (including deepseek, hermes, pi) and preserves unknown off IDs.
        let after_disconnect_all = coord
            .run_command(
                client.clone(),
                json!({ "type": "disconnect" }).as_object().unwrap().clone(),
            )
            .await
            .unwrap();
        let mut expected_all: Vec<&str> = ALL_PROVIDER_IDS.to_vec();
        expected_all.push("future-provider");
        assert_eq!(
            after_disconnect_all["configuration"]["disconnectedProviders"],
            json!(expected_all)
        );

        // L4: invalid configure values are refused and never written to agents.json.
        for bad_patch in [
            json!({ "provider": "bogus" }),
            json!({ "newThreadSpeed": "slow" }),
            json!({ "reasoning": "x" }),
            json!({ "newThreadRuntimeMode": "yolo" }),
            json!({ "reasoningModel": "a".repeat(513) }),
        ] {
            let err = coord
                .run_command(
                    client.clone(),
                    json!({ "type": "configure", "patch": bad_patch })
                        .as_object()
                        .unwrap()
                        .clone(),
                )
                .await;
            assert!(err.is_err(), "expected configure to reject {bad_patch}");
        }
        let saved_agents: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("agents.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved_agents["configuration"]["provider"], "codex");
        assert_eq!(
            saved_agents["configuration"]["unknownConfigKey"],
            "keep-in-file-only"
        );
        coord.shutdown().await;
    }

    #[tokio::test]
    async fn zero_provider_run_does_not_trigger_legacy_all_off_on_next_start() {
        let dir = tempdir().unwrap();
        // L5: first run with no providers loaded (e.g., smoke run without SOTTO_HOST_ENABLE_PROVIDERS=1).
        let coord1 = CoordinatorHandle::spawn(
            dir.path().to_path_buf(),
            "00000000-0000-4000-8000-000000000007".into(),
            false,
            BTreeMap::new(),
        )
        .unwrap();
        coord1.shutdown().await;

        // Second run with providers enabled must connect normally, not treat the saved state as legacy all-off.
        let mut providers: BTreeMap<String, Arc<dyn ProviderAdapter>> = BTreeMap::new();
        providers.insert("codex".into(), Arc::new(MockProviderAdapter::new("codex")));
        let coord2 = CoordinatorHandle::spawn(
            dir.path().to_path_buf(),
            "00000000-0000-4000-8000-000000000007".into(),
            false,
            providers,
        )
        .unwrap();
        let shell = coord2.shell(true).await.unwrap();
        let providers_arr = shell["host"]["providers"].as_array().unwrap();
        assert_eq!(
            providers_arr.iter().find(|p| p["id"] == "codex").unwrap()["connection"],
            "connected"
        );
        assert!(shell["configuration"].get("disconnectedProviders").is_none());
        coord2.shutdown().await;
    }
}
