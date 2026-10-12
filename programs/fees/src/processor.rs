//! Instruction handling for the fee vault program.

use arch_program::{
    account::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::get_clock,
    program_error::ProgramError,
    pubkey::Pubkey,
};
use archpad_interface::{
    config::{find_config_address, GlobalConfig},
    fees::{
        find_creator_vault_address, find_platform_vault_address, find_vault_authority_address,
        FeesInstruction, CREATOR_VAULT_SEED, PLATFORM_VAULT_SEED, VAULT_AUTHORITY_SEED,
    },
    ids,
    launch::{find_curve_address, Curve},
    AccountTag, ArchpadError, Event,
};
use archpad_program_lib::{
    create_pda_token_account, emit_event, load, load_token_account, process_event, require,
    require_key, require_program, require_signer, require_signer_key, transfer_tokens_signed,
    unpack_token_account,
};

/// Entry point for every fee vault instruction.
pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    require(
        *program_id == ids::fees::ID,
        ProgramError::IncorrectProgramId,
    )?;
    if let Some(result) = process_event(program_id, accounts, data) {
        return result;
    }

    match FeesInstruction::unpack(data)? {
        FeesInstruction::InitPlatformVault => init_platform_vault(accounts),
        FeesInstruction::InitCreatorVault => init_creator_vault(accounts),
        FeesInstruction::ClaimCreatorFees => claim_creator_fees(accounts),
        FeesInstruction::WithdrawPlatformFees => withdraw_platform_fees(accounts),
    }
}

fn init_platform_vault(accounts: &[AccountInfo]) -> ProgramResult {
    let accounts = &mut accounts.iter();
    let payer = next_account_info(accounts)?;
    let vault = next_account_info(accounts)?;
    let quote_mint = next_account_info(accounts)?;
    let vault_authority = next_account_info(accounts)?;
    let token_program = next_account_info(accounts)?;
    let system_program = next_account_info(accounts)?;

    require_signer(payer)?;
    let (authority, _) = find_vault_authority_address();
    require_key(vault_authority, &authority)?;
    let (address, bump) = find_platform_vault_address(quote_mint.key);
    require_key(vault, &address)?;

    create_pda_token_account(
        payer,
        vault,
        quote_mint,
        &authority,
        system_program,
        token_program,
        &[PLATFORM_VAULT_SEED, quote_mint.key.as_ref(), &[bump]],
    )
}

fn init_creator_vault(accounts: &[AccountInfo]) -> ProgramResult {
    let accounts = &mut accounts.iter();
    let payer = next_account_info(accounts)?;
    let curve = next_account_info(accounts)?;
    let vault = next_account_info(accounts)?;
    let mint = next_account_info(accounts)?;
    let quote_mint = next_account_info(accounts)?;
    let vault_authority = next_account_info(accounts)?;
    let token_program = next_account_info(accounts)?;
    let system_program = next_account_info(accounts)?;

    require_signer(payer)?;
    // Only the launch program can sign as a coin's curve. Requiring that
    // signature means a creator vault exists only for a coin being launched,
    // and always in the quote asset the launch chose.
    let (curve_address, _) = find_curve_address(mint.key);
    require_signer_key(curve, &curve_address)?;

    let (authority, _) = find_vault_authority_address();
    require_key(vault_authority, &authority)?;
    let (address, bump) = find_creator_vault_address(mint.key);
    require_key(vault, &address)?;

    create_pda_token_account(
        payer,
        vault,
        quote_mint,
        &authority,
        system_program,
        token_program,
        &[CREATOR_VAULT_SEED, mint.key.as_ref(), &[bump]],
    )
}

fn claim_creator_fees(accounts: &[AccountInfo]) -> ProgramResult {
    let accounts = &mut accounts.iter();
    let creator = next_account_info(accounts)?;
    let curve_account = next_account_info(accounts)?;
    let vault = next_account_info(accounts)?;
    let destination = next_account_info(accounts)?;
    let vault_authority = next_account_info(accounts)?;
    let token_program = next_account_info(accounts)?;
    let fees_program = next_account_info(accounts)?;
    require_program(fees_program, &ids::fees::ID)?;

    // The curve says who the creator is. It is owned by the launch program,
    // which writes that field once, at launch.
    let curve: Curve = load(curve_account, &ids::launch::ID, AccountTag::Curve)?;
    require_signer_key(creator, &curve.creator)?;
    require_key(vault, &find_creator_vault_address(&curve.mint).0)?;
    let (authority, authority_bump) = find_vault_authority_address();
    require_key(vault_authority, &authority)?;

    let amount = load_token_account(vault, &curve.quote_mint)?.amount;
    require(amount > 0, ArchpadError::NothingToClaim)?;

    let authority_seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &[authority_bump]];
    transfer_tokens_signed(
        token_program,
        vault,
        destination,
        vault_authority,
        amount,
        &[authority_seeds],
    )?;

    emit_event(
        &Event::CreatorFeesClaimed {
            mint: curve.mint,
            creator: curve.creator,
            amount,
            timestamp: get_clock().unix_timestamp,
        },
        fees_program,
        vault_authority,
        authority_seeds,
    )
}

fn withdraw_platform_fees(accounts: &[AccountInfo]) -> ProgramResult {
    let accounts = &mut accounts.iter();
    let config_account = next_account_info(accounts)?;
    let vault = next_account_info(accounts)?;
    let treasury_token_account = next_account_info(accounts)?;
    let vault_authority = next_account_info(accounts)?;
    let token_program = next_account_info(accounts)?;
    let fees_program = next_account_info(accounts)?;
    require_program(fees_program, &ids::fees::ID)?;

    require_key(config_account, &find_config_address().0)?;
    let config: GlobalConfig = load(config_account, &ids::config::ID, AccountTag::GlobalConfig)?;

    // The vault names its own mint; its address must be the platform vault
    // for that mint.
    let vault_tokens = unpack_token_account(vault)?;
    let quote_mint = vault_tokens.mint;
    require_key(vault, &find_platform_vault_address(&quote_mint).0)?;
    let (authority, authority_bump) = find_vault_authority_address();
    require_key(vault_authority, &authority)?;

    // Anyone may trigger this, so the destination is not theirs to choose: it
    // has to be a token account owned by the treasury.
    let destination = load_token_account(treasury_token_account, &quote_mint)?;
    require(
        destination.owner == config.active.treasury,
        ArchpadError::AccountMismatch,
    )?;

    let amount = vault_tokens.amount;
    require(amount > 0, ArchpadError::NothingToClaim)?;

    let authority_seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &[authority_bump]];
    transfer_tokens_signed(
        token_program,
        vault,
        treasury_token_account,
        vault_authority,
        amount,
        &[authority_seeds],
    )?;

    emit_event(
        &Event::PlatformFeesWithdrawn {
            quote_mint,
            amount,
            timestamp: get_clock().unix_timestamp,
        },
        fees_program,
        vault_authority,
        authority_seeds,
    )
}
