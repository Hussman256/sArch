//! The contract between the launchpad's on-chain programs and everything that
//! talks to them: account layouts, instructions and their builders, derived
//! addresses, events and error codes.
//!
//! The programs depend on this crate, and so do Rust clients and tests. The
//! TypeScript SDK mirrors the same layouts by hand.

pub mod config;
pub mod error;
pub mod event;
pub mod fees;
pub mod ids;
pub mod launch;
pub mod pool;

pub use error::ArchpadError;
pub use event::Event;

/// First byte of every account the programs own. It stops one kind of account
/// being passed where another is expected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum AccountTag {
    /// Freshly allocated, not yet written.
    Uninitialized = 0,
    /// [`config::GlobalConfig`].
    GlobalConfig = 1,
    /// [`launch::Curve`].
    Curve = 2,
    /// [`launch::Position`].
    Position = 3,
    /// [`pool::Pool`].
    Pool = 4,
    /// [`config::Proposal`].
    Proposal = 5,
}
