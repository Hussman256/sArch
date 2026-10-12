//! Launch program.
//!
//! Creates coins and runs their bonding curves. The guarantees a buyer relies
//! on are enforced here, in the same transaction as the thing they protect:
//!
//! * the mint's supply is fixed and it can never freeze an account: the whole
//!   supply is minted into the curve's vault at launch and the mint authority
//!   is given up before the instruction returns;
//! * the creator buys their own coin in the launch transaction, at the same
//!   price and fee as anyone else;
//! * during the launch window no wallet can buy more than its cap;
//! * every trade pays the same fee through one code path, with no exemptions;
//! * the buy that sells the last curve token moves the reserves into the
//!   coin's pool in that same transaction, so there is no moment at which
//!   someone holds them in between.
//!
//! The parameters a curve runs on are copied from the config when it is
//! created. Nothing the admin does afterwards changes them.

pub mod create;
pub mod processor;
pub mod trade;

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
