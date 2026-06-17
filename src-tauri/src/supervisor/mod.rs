//! Supervisor — the local core that pilots `claude` binaries via the stream-json
//! protocol. This is the heart of the product (see `docs/claude-code-protocol.md`).
//!
//! Layering:
//!   - [`protocol`] — wire types for the JSON-lines messages (shared foundation).
//!   - [`transport`] — spawn a `claude` process and read/write the JSON-lines
//!     stream (subtask 1).
//!   - [`control`] — the control channel: `control_request`/`control_response`,
//!     permissions, modes, interrupt (subtask 2).
//!   - [`model`] — normalized, UI-facing events.
//!   - [`assembler`] — turn the raw stream into normalized events (subtask 3).
//!   - [`history`] — rebuild a past conversation from Claude's on-disk
//!     transcript on resume (the CLI does not re-stream history).
//!   - [`session`] — the actor that wires transport + control + assembler + an
//!     event sink, exposed to the IPC layer (subtask 3).

pub mod assembler;
pub mod control;
pub mod history;
pub mod model;
pub mod protocol;
pub mod session;
pub mod transport;

pub use control::{PermissionDecision, PermissionMode};
pub use model::{
    ConversationItem, NormalizedBlock, PermissionRequestPayload, SessionEmitter, SessionEvent,
    SessionStatePayload,
};
pub use protocol::CliMessage;
pub use session::{spawn_session, SessionError, SessionHandle};
pub use transport::{SpawnConfig, Transport, TransportError};
