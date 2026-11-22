pub mod coordinator;
pub mod credentials;
pub mod desktop_clients;
pub mod identity;
pub mod lock;
pub mod pairing;
pub mod protocol;
pub mod provider;
pub mod providers;
pub mod remote_commands;
pub mod stores;
pub mod workspace;

pub use coordinator::{ClientContext, CoordinatorBroadcast, CoordinatorError, CoordinatorHandle};
pub use credentials::{CredentialError, HostCredentialEncryption, HostCredentials};
pub use desktop_clients::{DesktopClients, DESKTOP_CLIENTS_FILE};
pub use identity::{load_host_identity, HostIdentityError};
pub use lock::{
    acquire_host_lock, lease_holder_alive, process_alive, read_boot_id, release_host_lock,
    HostLease, HostLockError, HOST_LOCK_HELD_EXIT_CODE,
};
pub use pairing::{
    PairedClient, PairedClients, PairingCode, PairingError, PairingResult, SessionToken,
    PAIRING_CODE_REJECTED,
};
pub use protocol::{
    HostDescriptor, HostErrorCode, HostErrorPayload, HostPushEnvelope, HostRequestEnvelope,
    HostResponseEnvelope, HOST_MAX_FRAME_BYTES, HOST_PROTOCOL_VERSION,
};
pub use provider::{
    AnswerRequestInput, BoxFuture, HeldProviderAdapter, MockProviderAdapter, ProviderAdapter,
    ProviderEvent, SendMessageAck, SendMessageRequest,
};
pub use providers::{
    claude_project_dir, fork_claude_session, read_claude_session_transcript, ClaudeAdapter,
    ClaudeAdapterConfig, ClaudeTranscriptMessage, CodexAdapter, CodexAdapterConfig,
};
pub use remote_commands::{
    allowed_command_fields, validate_remote_command, CommandRefusal, REMOTE_CONFIGURATION_FIELDS,
};
pub use stores::{
    open_sqlite, remote_answer_scope, MemoryStore, PolicyRecord, StoreError, StoredActivity,
    StoredMessage, StoredThreadEvent, SubagentStore, ThreadEvent, ThreadEventAttribution,
    ThreadStore, UsageMeta, UsageStore,
};
pub use workspace::{
    diff_thread_detail, now_iso, parse_public_provider_entity_id, provider_label,
    public_provider_entity_id, summarize_activity_for_wire, summarize_thread, write_atomic_json,
    AgentCapabilities, AgentConfiguration, AgentDelivery, AgentModel, AgentProject,
    AgentProviderStatus, AgentThread, AgentThreadDetail, AgentThreadSummary,
    AgentThreadSummaryMessage, AgentThreadWorktree, AgentTurnRecord, ClientUpdateRow,
    DeliveredDraft, StagedAttachmentEntry, StagedAttachmentHandle, StagedAttachments,
    ACTIVE_PROVIDERS,
};
