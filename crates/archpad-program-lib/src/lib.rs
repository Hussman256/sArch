//! Helpers shared by the launchpad's on-chain programs.
//!
//! Every program validates the accounts it is handed the same way, so the
//! checks live here once: who signed, who owns an account, what kind of state
//! it holds, and whether it sits at the address it should.

use apl_token::state::Account as TokenAccount;
use arch_program::{
    account::AccountInfo,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::minimum_rent,
    system_instruction,
    system_program::SYSTEM_PROGRAM_ID,
};
use archpad_interface::{event::EVENT_IX_TAG, AccountTag, ArchpadError, Event};
use borsh::{BorshDeserialize, BorshSerialize};

/// Returns `error` unless `condition` holds.
pub fn require(condition: bool, error: impl Into<ProgramError>) -> ProgramResult {
    if condition {
        Ok(())
    } else {
        Err(error.into())
    }
}

/// The account must have signed the transaction.
pub fn require_signer(account: &AccountInfo) -> ProgramResult {
    require(account.is_signer, ArchpadError::Unauthorized)
}

/// The account must be the given key and must have signed.
pub fn require_signer_key(account: &AccountInfo, expected: &Pubkey) -> ProgramResult {
    require(
        account.is_signer && account.key == expected,
        ArchpadError::Unauthorized,
    )
}

/// The account must sit at the given address.
pub fn require_key(account: &AccountInfo, expected: &Pubkey) -> ProgramResult {
    require(account.key == expected, ArchpadError::AccountMismatch)
}

/// The account must be the named program.
pub fn require_program(account: &AccountInfo, program_id: &Pubkey) -> ProgramResult {
    require(account.key == program_id, ProgramError::IncorrectProgramId)
}

/// The account must be writable.
pub fn require_writable(account: &AccountInfo) -> ProgramResult {
    require(account.is_writable, ArchpadError::AccountMismatch)
}

/// The account must not exist yet: still owned by the system program and empty.
pub fn require_uninitialized(account: &AccountInfo) -> ProgramResult {
    require(
        *account.owner == SYSTEM_PROGRAM_ID && account.data_is_empty(),
        ArchpadError::AlreadyInitialized,
    )
}

/// Reads program state out of an account, after checking the account is owned
/// by `owner` and tagged as the expected kind.
pub fn load<T: BorshDeserialize>(
    account: &AccountInfo,
    owner: &Pubkey,
    tag: AccountTag,
) -> Result<T, ProgramError> {
    if account.owner != owner {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let data = account.try_borrow_data()?;
    if data.first() != Some(&(tag as u8)) {
        return Err(ArchpadError::WrongAccountType.into());
    }
    // Read from the front and ignore any trailing padding.
    T::deserialize(&mut &data[..]).map_err(|_| ProgramError::InvalidAccountData)
}

/// Writes program state into an account's data.
pub fn store<T: BorshSerialize>(account: &AccountInfo, value: &T) -> ProgramResult {
    let mut data = account.try_borrow_mut_data()?;
    value
        .serialize(&mut &mut data[..])
        .map_err(|_| ProgramError::AccountDataTooSmall)
}

/// Creates a program-owned account at a derived address.
///
/// Anyone can send lamports to an address before it is created. A plain
/// `create_account` then fails, which would let a stranger block a launch for
/// the price of dust. So an address that already holds lamports is topped up,
/// allocated and assigned instead.
pub fn create_pda_account<'a>(
    payer: &AccountInfo<'a>,
    new_account: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    space: usize,
    owner: &Pubkey,
    signer_seeds: &[&[u8]],
) -> ProgramResult {
    require_program(system_program, &SYSTEM_PROGRAM_ID)?;
    require_uninitialized(new_account)?;

    if new_account.lamports() == 0 {
        return invoke_signed(
            &system_instruction::create_account(
                payer.key,
                new_account.key,
                minimum_rent(space),
                space as u64,
                owner,
            ),
            &[payer.clone(), new_account.clone(), system_program.clone()],
            &[signer_seeds],
        );
    }

    let shortfall = minimum_rent(space).saturating_sub(new_account.lamports());
    if shortfall > 0 {
        invoke(
            &system_instruction::transfer(payer.key, new_account.key, shortfall),
            &[payer.clone(), new_account.clone(), system_program.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(new_account.key, space as u64),
        &[new_account.clone(), system_program.clone()],
        &[signer_seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(new_account.key, owner),
        &[new_account.clone(), system_program.clone()],
        &[signer_seeds],
    )
}

/// Creates a token account at a derived address, holding `mint` for `owner`.
#[allow(clippy::too_many_arguments)]
pub fn create_pda_token_account<'a>(
    payer: &AccountInfo<'a>,
    new_account: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    owner: &Pubkey,
    system_program: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    signer_seeds: &[&[u8]],
) -> ProgramResult {
    require_program(token_program, &apl_token::id())?;
    create_pda_account(
        payer,
        new_account,
        system_program,
        TokenAccount::LEN,
        &apl_token::id(),
        signer_seeds,
    )?;
    invoke(
        &apl_token::instruction::initialize_account3(
            &apl_token::id(),
            new_account.key,
            mint.key,
            owner,
        )?,
        &[new_account.clone(), mint.clone(), token_program.clone()],
    )
}

/// Reads a token account, checking the token program owns it.
pub fn unpack_token_account(account: &AccountInfo) -> Result<TokenAccount, ProgramError> {
    if *account.owner != apl_token::id() {
        return Err(ProgramError::InvalidAccountOwner);
    }
    TokenAccount::unpack(&account.try_borrow_data()?)
}

/// Reads a token account, checking the token program owns it and that it holds
/// the expected mint.
pub fn load_token_account(
    account: &AccountInfo,
    expected_mint: &Pubkey,
) -> Result<TokenAccount, ProgramError> {
    let token_account = unpack_token_account(account)?;
    if token_account.mint != *expected_mint {
        return Err(ArchpadError::AccountMismatch.into());
    }
    Ok(token_account)
}

/// Moves tokens on the authority of a transaction signer.
pub fn transfer_tokens<'a>(
    token_program: &AccountInfo<'a>,
    source: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
) -> ProgramResult {
    transfer_tokens_signed(token_program, source, destination, authority, amount, &[])
}

/// Moves tokens on the authority of a program-derived address.
///
/// A transfer of zero is skipped: it would cost a cross-program call to do
/// nothing.
pub fn transfer_tokens_signed<'a>(
    token_program: &AccountInfo<'a>,
    source: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    require_program(token_program, &apl_token::id())?;
    if amount == 0 {
        return Ok(());
    }
    invoke_signed(
        &apl_token::instruction::transfer(
            &apl_token::id(),
            source.key,
            destination.key,
            authority.key,
            &[],
            amount,
        )?,
        &[
            source.clone(),
            destination.clone(),
            authority.clone(),
            token_program.clone(),
        ],
        signer_seeds,
    )
}

/// Records an event for the indexer by having `program` call itself.
///
/// `authority` is the address [`Event::source`] names for this kind of event,
/// and `signer_seeds` are its seeds. See [`archpad_interface::event`] for why
/// events are calls and not log lines.
pub fn emit_event<'a>(
    event: &Event,
    program: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    signer_seeds: &[&[u8]],
) -> ProgramResult {
    invoke_signed(
        &event.instruction(program.key, authority.key),
        &[authority.clone(), program.clone()],
        &[signer_seeds],
    )
}

/// If `data` is an event instruction, handles it and returns the result.
/// Returns `None` for any other instruction, which the caller then decodes
/// as usual.
///
/// The instruction changes nothing. Its whole job is to succeed only when the
/// event really comes from `program_id`: the first account must be the address
/// that kind of event is signed by, and it must have signed. Nobody outside
/// the program can make that signature, so nobody can record an event the
/// program did not produce.
pub fn process_event(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> Option<ProgramResult> {
    let (&tag, body) = data.split_first()?;
    if tag != EVENT_IX_TAG {
        return None;
    }
    Some(check_event(program_id, accounts, body))
}

fn check_event(program_id: &Pubkey, accounts: &[AccountInfo], body: &[u8]) -> ProgramResult {
    let event = Event::unpack(body).ok_or(ArchpadError::InvalidInstruction)?;
    let (program, authority) = event.source();
    require(program == *program_id, ArchpadError::InvalidInstruction)?;
    let signer = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    require_signer_key(signer, &authority)
}
