//! Pool program.
//!
//! The pool a coin trades in after its curve sells out. The launch program
//! creates it, once, as part of the buy that completes the curve. After that
//! the only instruction is `Swap`.
//!
//! There is deliberately no instruction to add or remove liquidity. The
//! reserves that graduation moves in can only change through swaps, and a swap
//! can never take a side of the pool to zero.

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
