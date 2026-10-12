//! Fee vault program.
//!
//! Holds the fees trades pay, in token accounts only this program can sign
//! for. There are two ways money leaves: a coin's creator claims that coin's
//! vault, or anyone sends a platform vault's balance to the treasury named in
//! the config. No key, the admin's included, can redirect either.

pub mod processor;

// Compiled only for the on-chain target; see the config program for why.
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
