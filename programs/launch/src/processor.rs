//! Instruction dispatch for the launch program.

use arch_program::{
    account::AccountInfo, entrypoint::ProgramResult, program_error::ProgramError, pubkey::Pubkey,
};
use archpad_interface::{ids, launch::LaunchInstruction};
use archpad_program_lib::{process_event, require};

use crate::{create, trade};

/// Entry point for every launch instruction.
pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // Every address this program signs for is derived from its published ID,
    // so refuse to run as a copy deployed anywhere else.
    require(
        *program_id == ids::launch::ID,
        ProgramError::IncorrectProgramId,
    )?;

    if let Some(result) = process_event(program_id, accounts, data) {
        return result;
    }

    match LaunchInstruction::unpack(data)? {
        LaunchInstruction::CreateCoin(args) => create::create_coin(accounts, args),
        LaunchInstruction::Buy {
            max_quote_in,
            min_tokens_out,
        } => trade::buy(accounts, max_quote_in, min_tokens_out),
        LaunchInstruction::Sell {
            tokens_in,
            min_quote_out,
        } => trade::sell(accounts, tokens_in, min_quote_out),
    }
}
