//! Config program.
//!
//! Owns the one account that holds the launchpad's tunables, and the rules for
//! changing it. A set of admin keys governs it, and a threshold of them must
//! approve before anything happens: one proposes, others approve in their own
//! transactions, and once enough have, anyone can execute. Replacing the
//! config also waits out a timelock; pausing new launches does not.
//!
//! That is everything the admins can do. There is no instruction here, or in
//! any of the other programs, that lets them move funds or touch a coin, a
//! curve or a pool that already exists.

pub mod processor;
pub mod state;

// The entrypoint installs the VM's fixed-address heap allocator, so it is
// compiled only for the on-chain target. Host builds (tests, clients) link the
// processor as an ordinary library.
#[cfg(all(target_os = "solana", not(feature = "no-entrypoint")))]
mod entrypoint {
    use arch_program::{
        account::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
    };

    entrypoint!(process_instruction);

    fn process_instruction(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        instruction_data: &[u8],
    ) -> ProgramResult {
        crate::processor::process(program_id, accounts, instruction_data)
    }
}
