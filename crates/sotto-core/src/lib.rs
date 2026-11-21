pub mod identity;
pub mod lock;
pub mod pairing;
pub mod protocol;
pub mod stores;

pub use identity::{load_host_identity, HostIdentityError};
pub use lock::{
    acquire_host_lock, lease_holder_alive, process_alive, read_boot_id, release_host_lock,
    HostLease, HostLockError, HOST_LOCK_HELD_EXIT_CODE,
};
pub use pairing::{
    PairedClient, PairedClients, PairingCode, PairingError, PairingResult, SessionToken,
    PAIRING_CODE_LIFETIME_SECS, PAIRING_CODE_REJECTED, SESSION_LIFETIME_SECS,
};
pub use protocol::{
    HostAbout, HostDescriptor, HostErrorCode, HostErrorPayload, HostPushEnvelope,
    HostRequestEnvelope, HostResponseEnvelope, HOST_MAX_FRAME_BYTES, HOST_PROTOCOL_VERSION,
};
pub use stores::{
    MemoryStore, PolicyRecord, StoreError, StoredActivity, StoredMessage, StoredThreadEvent,
    SubagentStore, ThreadStore, UsageMeta, UsageStore,
};
