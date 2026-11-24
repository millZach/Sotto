pub mod checkpoints;
pub mod coordinator;
pub mod council;
pub mod credentials;
pub mod desktop_clients;
pub mod desktop_hosts;
pub mod git_review;
pub mod host_facts;
pub mod host_router;
pub mod identity;
pub mod lock;
pub mod ops;
pub mod phone_access;
pub mod plugins;
pub mod usage_ops;
pub mod pairing;
pub mod protocol;
pub mod provider;
pub mod providers;
pub mod remote_commands;
pub mod stores;
pub mod workspace;

pub use checkpoints::{
    blob_hash, checkout_identity, inspect_checkpoint_blobs, read_checkpoints_readonly,
    read_verified_blob, CheckpointBlobPair, CheckpointChangeEntry, CheckpointError,
    CheckpointManager, CheckpointPatch, CheckpointRecord, CheckpointSnapshot, CheckpointStatus,
    CheckpointStore, CheckpointThreadInfo, SnapshotFile,
};
pub use coordinator::{ClientContext, CoordinatorBroadcast, CoordinatorError, CoordinatorHandle};
pub use council::{
    active_panelists, add_round, advance_round, answered_letters, council_counts, counts_for_round,
    criteria_of, crux_runners, current_round, current_turn, draft_verdict, fairness_done,
    host_entity_key, is_complete, is_council_remote_provider, is_final, is_late, is_panelist,
    kinds_of, leave_out, next_clock_change, parse_host_entity_key, project_council_view,
    read_councils_readonly, reframe, reframable, replace_seat, research_of, retry_turn,
    review_assignments, row_actions, saved_record, turn_state, validate_council_record,
    CouncilAngle, CouncilAnswer, CouncilAnswerChallenge, CouncilAnswerFinding, CouncilAskedBy,
    CouncilAskedByView, CouncilAskedDelivery, CouncilAskedDeliveryState, CouncilCitation,
    CouncilCitationCheck, CouncilCitationOf, CouncilCommand, CouncilCommandContext,
    CouncilCommandOutcome, CouncilCommandResult, CouncilCounts, CouncilCriterion,
    CouncilCriterionSource, CouncilCrux, CouncilCruxMeaning, CouncilCruxOutcome, CouncilCruxResult,
    CouncilCruxView, CouncilDelivery, CouncilEstimate, CouncilEvidence, CouncilEvidenceSourceKind,
    CouncilEvidenceView, CouncilFavouriteCount, CouncilFindingCount, CouncilFindingKind,
    CouncilFraming, CouncilFramingResearch, CouncilFramingResearchView, CouncilFramingView,
    CouncilHistoryMeta, CouncilHistoryView, CouncilKind, CouncilLegacySnapshot, CouncilLoadedFile,
    CouncilManager, CouncilMode, CouncilModelInfo, CouncilObjection, CouncilObjectionAnswer,
    CouncilObjectionView, CouncilObjectionViewAnswer, CouncilOriginThreadInfo, CouncilOriginView,
    CouncilRankingCount, CouncilRecord, CouncilReview, CouncilReviewAdded, CouncilReviewFinding,
    CouncilReviewScore, CouncilReviewVerdict, CouncilRole, CouncilRound, CouncilRoundEvidence,
    CouncilRoundView, CouncilRow, CouncilRowAction, CouncilRowResult, CouncilRowSource,
    CouncilSeat, CouncilSeatChoice, CouncilSeatView, CouncilSnapshotView, CouncilStage,
    CouncilStoppedBecause, CouncilStore, CouncilSupportCount, CouncilThreadState,
    CouncilThreadViewContext, CouncilTurn, CouncilTurnOutcome, CouncilTurnResult, CouncilTurnStage,
    CouncilVerdictView, CouncilView, CouncilViewStatus, CountedReview, ReframeChange,
    ReplacementSeatSpec, StageClock, COUNCIL_CHAIR, COUNCIL_FAIRNESS_WAIT_MS, COUNCIL_LETTERS,
    COUNCIL_PANELISTS_DEFAULT, COUNCIL_PANELISTS_MAX, COUNCIL_PANELISTS_MIN, COUNCIL_RECORDS_MAX,
    COUNCIL_VIEWS_MAX,
};
pub use credentials::{CredentialError, HostCredentialEncryption, HostCredentials};
pub use desktop_clients::{DesktopClients, DESKTOP_CLIENTS_FILE};
pub use desktop_hosts::{
    read_desktop_hosts_readonly, remote_host_credential_slot, settled_with_parent,
    CascadedSettleEntry, CascadedSettlesStore, DesktopHostsManager, FilesBindingEntry,
    FilesBindingsDelta, FilesBindingsTracker, HostConnectionPreference, HostStatusView,
    HostThreadFoldersEntry, HostsStateView, RetainedDraft, RetainedDraftStore,
    RetainedSendAttempt, SavedHost, SavedHostsStore, SshTerminalHostEntry, TailnetEntry,
    TailnetStore, CASCADED_SETTLES_FILE, DEFAULT_HOST_DATA_DIRECTORY, DEFAULT_HOST_INSTALL_PATH,
    REMOTE_HOSTS_FILE, RETAINED_DRAFTS_FILE, SETTLE_CASCADE_SKEW_MS, TAILNET_STORE_FILE,
};
pub use host_router::{
    DesktopHostRouter, HostConnectionSummary, RemoteHostClient, RemoteHostEvent, RemoteHostInfo,
};
pub use identity::{load_host_identity, HostIdentityError};
pub use lock::{
    acquire_host_lock, lease_holder_alive, process_alive, read_boot_id, release_host_lock,
    HostLease, HostLockError, HOST_LOCK_HELD_EXIT_CODE,
};
pub use pairing::{
    PairedClient, PairedClients, PairingCode, PairingError, PairingResult, SessionToken,
    PAIRING_CODE_REJECTED,
};
pub use phone_access::{
    extract_tailscale_consent_url, is_tailscale_access_denied, is_tailscale_serve_not_enabled,
    parse_serve_status, parse_tailscale_status, probe_tailscale_status, read_phone_access_readonly,
    serve_port_owner, serve_target, LocalAppsFile, LocalAppsManager, LocalAppsState,
    LoopbackPhoneListener, PairedPhoneView, PhoneAccessBrief, PhoneAccessCommandOutcome,
    PhoneAccessManager, PhoneAccessRecord, PhoneAccessSettings, PhonesCommand, PhonesState,
    ServeCheck, ServeConfig, ServePortOwner, ServeResult, ServeStatusError, SystemTailscaleCli,
    TailscaleBackend, TailscaleCheck, TailscalePeer, TailscaleStatus, LOCAL_APPS_CLIENT_NAME,
    PHONE_ACCESS_SERVE_PORTS,
};
pub use plugins::{
    current_local_month, is_account_plugin, is_bridge_plugin, is_mail_plugin, is_spending_plugin,
    mail_grants_shown, parse_github_sign_in_json, parse_github_sign_in_words, plugin_account_slot,
    plugin_secret_as_kept, read_github_sign_in, read_plugins_readonly, CopyChoicesFile,
    CopyComputerView, GitHubSignIn, HeardReport, HeardSpendingStore, LocalPluginsManager,
    MailGrant, MailGrantsStore, MeshyJob, ModelRecord, ModelRecordsStore, ModelSource,
    PluginAccount, PluginAccountResult, PluginAccountUpdate, PluginAccountsStore, PluginBridge,
    PluginChangeAnswer, PluginChangeCard, PluginChangeRequests, PluginCopiesView,
    PluginCopyChoicesStore, PluginCopyEntryView, PluginSpending, PluginUse, PluginUseReport,
    PluginUseStore, SoundRecord, SoundRecordsStore, SpendingReport, ThreadMailGrant,
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
    claude_project_dir, fork_claude_session, read_claude_session_transcript, AcpAdapter,
    AcpAdapterConfig, AcpFlavor, ClaudeAdapter, ClaudeAdapterConfig, ClaudeTranscriptMessage,
    CodexAdapter, CodexAdapterConfig, MuseAdapter, MuseAdapterConfig, OpenCodeAdapter,
    OpenCodeAdapterConfig,
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
