//! Instruction handling: account checks, then the rules in [`crate::state`].
//!
//! A config is several hundred bytes and the VM gives each function a 4 KB
//! stack frame, so the handlers are kept out of line and the large values
//! live on the heap.

use arch_program::{
    account::AccountInfo, entrypoint::ProgramResult, program::get_clock,
    program_error::ProgramError, pubkey::Pubkey,
};
use archpad_interface::{
    config::{
        find_config_address, find_proposal_address, AdminAction, ConfigData, ConfigInstruction,
        GlobalConfig, ProposalHeader, CONFIG_SEED, PROPOSAL_SEED,
    },
    ids, AccountTag,
};
use archpad_program_lib::{
    create_pda_account, load, require, require_key, require_signer, require_signer_key,
    require_writable, store,
};
use borsh::{BorshDeserialize, BorshSerialize};

use crate::state;

/// Entry point for every config instruction.
pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // The program trusts addresses derived from its published ID, so refuse to
    // run as a copy deployed anywhere else.
    require(
        *program_id == ids::config::ID,
        ProgramError::IncorrectProgramId,
    )?;

    match ConfigInstruction::unpack(data)? {
        ConfigInstruction::Initialize { config } => initialize(accounts, &config),
        ConfigInstruction::Propose { action } => propose(accounts, &action),
        ConfigInstruction::Approve => vote(accounts, true),
        ConfigInstruction::Revoke => vote(accounts, false),
        ConfigInstruction::Execute => execute(accounts),
    }
}

/// Reads the config account onto the heap.
///
/// Only this program can create an account tagged as the config, and it does
/// so at one address, so the owner and tag checks identify it.
#[inline(never)]
fn load_config(account: &AccountInfo) -> Result<Box<GlobalConfig>, ProgramError> {
    Ok(Box::new(load(
        account,
        &ids::config::ID,
        AccountTag::GlobalConfig,
    )?))
}

/// Reads the action out of a proposal account, onto the heap.
#[inline(never)]
fn load_action(account: &AccountInfo) -> Result<Box<AdminAction>, ProgramError> {
    let data = account.try_borrow_data()?;
    let mut body = data
        .get(ProposalHeader::LEN..)
        .ok_or(ProgramError::InvalidAccountData)?;
    AdminAction::deserialize(&mut body)
        .map(Box::new)
        .map_err(|_| ProgramError::InvalidAccountData)
}

#[inline(never)]
fn initialize(accounts: &[AccountInfo], config: &ConfigData) -> ProgramResult {
    let [initial_authority, config_account, system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Only the deployer's key may initialise. Without this, whoever saw the
    // deployment first could name themselves the admins.
    require_signer_key(initial_authority, &ids::INITIAL_AUTHORITY)?;

    let (address, bump) = find_config_address();
    require_key(config_account, &address)?;
    config.validate()?;

    create_pda_account(
        initial_authority,
        config_account,
        system_program,
        GlobalConfig::LEN,
        &ids::config::ID,
        &[CONFIG_SEED, &[bump]],
    )?;
    store(config_account, &Box::new(GlobalConfig::new(bump, *config)))
}

#[inline(never)]
fn propose(accounts: &[AccountInfo], action: &AdminAction) -> ProgramResult {
    let [admin, config_account, proposal_account, system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    require_signer(admin)?;
    require_writable(config_account)?;
    let mut config = load_config(config_account)?;

    // The next proposal number fixes the address, so a proposal cannot be
    // planted at a number of the proposer's choosing.
    let (address, bump) = find_proposal_address(config.proposal_count);
    require_key(proposal_account, &address)?;

    let header = state::propose(
        &mut config,
        admin.key,
        action,
        bump,
        get_clock().unix_timestamp,
    )?;
    create_pda_account(
        admin,
        proposal_account,
        system_program,
        ProposalHeader::LEN + action.encoded_len(),
        &ids::config::ID,
        &[PROPOSAL_SEED, &header.id.to_le_bytes(), &[bump]],
    )?;

    // Header, then action, written straight into the account.
    {
        let mut data = proposal_account.try_borrow_mut_data()?;
        let mut cursor = &mut data[..];
        header
            .serialize(&mut cursor)
            .and_then(|()| action.serialize(&mut cursor))
            .map_err(|_| ProgramError::AccountDataTooSmall)?;
    }
    store(config_account, &config)
}

#[inline(never)]
fn vote(accounts: &[AccountInfo], approving: bool) -> ProgramResult {
    let [admin, config_account, proposal_account] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    require_signer(admin)?;
    let config = load_config(config_account)?;
    // Only the header is read and written back. It is the front of the
    // account, so the action behind it is left exactly as it was proposed.
    let mut header: ProposalHeader =
        load(proposal_account, &ids::config::ID, AccountTag::Proposal)?;

    if approving {
        state::approve(&config, &mut header, admin.key, get_clock().unix_timestamp)?;
    } else {
        state::revoke(&config, &mut header, admin.key)?;
    }
    store(proposal_account, &header)
}

#[inline(never)]
fn execute(accounts: &[AccountInfo]) -> ProgramResult {
    let [config_account, proposal_account] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // No signer is checked: the approvals recorded in the proposal are what
    // authorise the action, and they were each signed for when they were given.
    require_writable(config_account)?;
    let mut config = load_config(config_account)?;
    let mut header: ProposalHeader =
        load(proposal_account, &ids::config::ID, AccountTag::Proposal)?;
    let action = load_action(proposal_account)?;

    state::execute(
        &mut config,
        &mut header,
        &action,
        get_clock().unix_timestamp,
    )?;
    store(proposal_account, &header)?;
    store(config_account, &config)
}
