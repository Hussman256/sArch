//! Launching a coin.

use apl_token::{instruction::AuthorityType, state::Mint};
use apl_token_metadata::instruction::MetadataInstruction;
use arch_program::{
    account::{AccountInfo, AccountMeta},
    entrypoint::ProgramResult,
    instruction::Instruction,
    program::{get_clock, invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    system_program::SYSTEM_PROGRAM_ID,
};
use archpad_interface::{
    config::{find_config_address, GlobalConfig, LaunchParams, QuoteAsset},
    error::math_err,
    fees::{find_platform_vault_address, FeesInstruction},
    ids,
    launch::{
        find_curve_address, find_mint_address, find_position_address, find_quote_vault_address,
        find_token_vault_address, CreateCoinArgs, Curve, CurveStatus, Position, CURVE_SEED,
        MINT_SEED, POSITION_SEED, QUOTE_VAULT_SEED, TOKEN_VAULT_SEED,
    },
    AccountTag, ArchpadError, Event,
};
use archpad_math::{bps_ceil, bps_floor};
use archpad_program_lib::{
    create_pda_account, create_pda_token_account, emit_event, load, require, require_key,
    require_program, require_signer, store,
};

use crate::trade::{settle_buy, BuyAccounts};

/// Reads what a launch needs from the config and checks launches are allowed.
///
/// Kept out of line so the config account's full contents sit in this
/// function's stack frame, not in the launch's.
#[inline(never)]
fn read_launch_config(
    config_account: &AccountInfo,
    quote_mint: &AccountInfo,
) -> Result<(LaunchParams, QuoteAsset), ProgramError> {
    require_key(config_account, &find_config_address().0)?;
    let config: GlobalConfig = load(config_account, &ids::config::ID, AccountTag::GlobalConfig)?;

    require(!config.launches_paused, ArchpadError::LaunchesPaused)?;
    let index = config
        .active
        .quote_index(quote_mint.key)
        .ok_or(ArchpadError::UnknownQuoteAsset)?;
    require(
        !config.is_quote_paused(index),
        ArchpadError::QuoteAssetPaused,
    )?;
    Ok((config.active.launch, config.active.quotes[index]))
}

/// Handles [`archpad_interface::launch::LaunchInstruction::CreateCoin`].
pub fn create_coin(accounts: &[AccountInfo], args: CreateCoinArgs) -> ProgramResult {
    let [creator, config_account, quote_mint, mint, curve_account, token_vault, quote_vault, metadata, creator_token_account, creator_quote_account, position_account, platform_fee_vault, creator_fee_vault, fee_vault_authority, token_program, system_program, associated_token_program, metadata_program, fees_program, launch_program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    require_signer(creator)?;
    args.validate()?;
    require_program(token_program, &apl_token::id())?;
    require_program(system_program, &SYSTEM_PROGRAM_ID)?;
    require_program(
        associated_token_program,
        &apl_associated_token_account::id(),
    )?;
    require_program(metadata_program, &apl_token_metadata::id())?;
    require_program(fees_program, &ids::fees::ID)?;
    require_program(launch_program, &ids::launch::ID)?;

    let (launch, quote_asset) = read_launch_config(config_account, quote_mint)?;
    // The config program validated all of this when it was staged. Checking
    // again here means a curve can never start from a shape or fee the math
    // would reject, whatever the config account holds.
    let params = launch.curve_params(&quote_asset);
    params.validate().map_err(math_err)?;
    launch.fee_rates().validate().map_err(math_err)?;
    launch.pool_fee_rates().validate().map_err(math_err)?;

    // Every address is derived, and derived from the creator and their salt,
    // so a launch cannot be pointed at accounts someone else prepared.
    let salt = args.salt.to_le_bytes();
    let (mint_address, mint_bump) = find_mint_address(creator.key, args.salt);
    require_key(mint, &mint_address)?;
    let (curve_address, curve_bump) = find_curve_address(&mint_address);
    require_key(curve_account, &curve_address)?;
    let (token_vault_address, token_vault_bump) = find_token_vault_address(&mint_address);
    require_key(token_vault, &token_vault_address)?;
    let (quote_vault_address, quote_vault_bump) = find_quote_vault_address(&mint_address);
    require_key(quote_vault, &quote_vault_address)?;
    let (position_address, position_bump) = find_position_address(&mint_address, creator.key);
    require_key(position_account, &position_address)?;
    require_key(
        platform_fee_vault,
        &find_platform_vault_address(quote_mint.key).0,
    )?;

    let curve_seeds: &[&[u8]] = &[CURVE_SEED, mint_address.as_ref(), &[curve_bump]];
    let now = get_clock().unix_timestamp;

    // The mint. No freeze authority, ever; the curve is mint authority only
    // until the supply has been minted, a few lines down.
    create_pda_account(
        creator,
        mint,
        system_program,
        Mint::LEN,
        &apl_token::id(),
        &[MINT_SEED, creator.key.as_ref(), &salt, &[mint_bump]],
    )?;
    invoke(
        &apl_token::instruction::initialize_mint2(
            &apl_token::id(),
            mint.key,
            &curve_address,
            None,
            launch.token_decimals,
        )?,
        &[mint.clone(), token_program.clone()],
    )?;

    create_pda_account(
        creator,
        curve_account,
        system_program,
        Curve::LEN,
        &ids::launch::ID,
        curve_seeds,
    )?;
    create_pda_token_account(
        creator,
        token_vault,
        mint,
        &curve_address,
        system_program,
        token_program,
        &[TOKEN_VAULT_SEED, mint_address.as_ref(), &[token_vault_bump]],
    )?;
    create_pda_token_account(
        creator,
        quote_vault,
        quote_mint,
        &curve_address,
        system_program,
        token_program,
        &[QUOTE_VAULT_SEED, mint_address.as_ref(), &[quote_vault_bump]],
    )?;

    // Metadata needs the mint authority's signature, so it is written while
    // the curve still has it. It is created immutable: nobody can rename the
    // coin or swap its image later.
    invoke_signed(
        &Instruction {
            program_id: apl_token_metadata::id(),
            accounts: vec![
                AccountMeta::new(*creator.key, true),
                AccountMeta::new_readonly(*system_program.key, false),
                AccountMeta::new_readonly(*mint.key, false),
                AccountMeta::new(*metadata.key, false),
                AccountMeta::new_readonly(curve_address, true),
            ],
            data: MetadataInstruction::CreateMetadata {
                name: args.name,
                symbol: args.symbol,
                image: args.image,
                description: args.description,
                immutable: true,
            }
            .pack(),
        },
        &[
            creator.clone(),
            system_program.clone(),
            mint.clone(),
            metadata.clone(),
            curve_account.clone(),
            metadata_program.clone(),
        ],
        &[curve_seeds],
    )?;

    // Mint the whole supply into the curve's vault, then give up the mint
    // authority for good. From here the supply is fixed.
    invoke_signed(
        &apl_token::instruction::mint_to(
            &apl_token::id(),
            mint.key,
            token_vault.key,
            &curve_address,
            &[],
            params.total_supply,
        )?,
        &[
            mint.clone(),
            token_vault.clone(),
            curve_account.clone(),
            token_program.clone(),
        ],
        &[curve_seeds],
    )?;
    invoke_signed(
        &apl_token::instruction::set_authority(
            &apl_token::id(),
            mint.key,
            None,
            AuthorityType::MintTokens,
            &curve_address,
            &[],
        )?,
        &[mint.clone(), curve_account.clone(), token_program.clone()],
        &[curve_seeds],
    )?;

    // The creator's fee vault, created by the fee vault program on the curve's
    // signature. That program checks the vault's address.
    invoke_signed(
        &Instruction {
            program_id: ids::fees::ID,
            accounts: vec![
                AccountMeta::new(*creator.key, true),
                AccountMeta::new_readonly(curve_address, true),
                AccountMeta::new(*creator_fee_vault.key, false),
                AccountMeta::new_readonly(*mint.key, false),
                AccountMeta::new_readonly(*quote_mint.key, false),
                AccountMeta::new_readonly(*fee_vault_authority.key, false),
                AccountMeta::new_readonly(*token_program.key, false),
                AccountMeta::new_readonly(*system_program.key, false),
            ],
            data: FeesInstruction::InitCreatorVault.pack(),
        },
        &[
            creator.clone(),
            curve_account.clone(),
            creator_fee_vault.clone(),
            mint.clone(),
            quote_mint.clone(),
            fee_vault_authority.clone(),
            token_program.clone(),
            system_program.clone(),
            fees_program.clone(),
        ],
        &[curve_seeds],
    )?;

    // Somewhere for the creator's tokens to land. The associated token account
    // program checks the address is the creator's.
    invoke(
        &apl_associated_token_account::create_associated_token_account(
            creator.key,
            creator_token_account.key,
            creator.key,
            mint.key,
            &apl_token::id(),
            &SYSTEM_PROGRAM_ID,
        ),
        &[
            creator.clone(),
            creator_token_account.clone(),
            mint.clone(),
            system_program.clone(),
            token_program.clone(),
            associated_token_program.clone(),
        ],
    )?;

    create_pda_account(
        creator,
        position_account,
        system_program,
        Position::LEN,
        &ids::launch::ID,
        &[
            POSITION_SEED,
            mint_address.as_ref(),
            creator.key.as_ref(),
            &[position_bump],
        ],
    )?;

    let reserves = params.initial_reserves();
    let mut curve = Curve {
        tag: AccountTag::Curve as u8,
        version: Curve::VERSION,
        bump: curve_bump,
        status: CurveStatus::Trading as u8,
        token_decimals: launch.token_decimals,
        mint: mint_address,
        quote_mint: *quote_mint.key,
        creator: *creator.key,
        token_vault: token_vault_address,
        quote_vault: quote_vault_address,
        platform_fee_vault: *platform_fee_vault.key,
        creator_fee_vault: *creator_fee_vault.key,
        virtual_quote: reserves.virtual_quote,
        virtual_token: reserves.virtual_token,
        real_quote: reserves.real_quote,
        real_token: reserves.real_token,
        total_supply: params.total_supply,
        curve_supply: params.curve_supply,
        initial_virtual_quote: params.virtual_quote_reserves,
        initial_virtual_token: params.virtual_token_reserves,
        platform_fee_bps: launch.platform_fee_bps,
        creator_fee_bps: launch.creator_fee_bps,
        pool_lp_fee_bps: launch.pool_lp_fee_bps,
        pool_platform_fee_bps: launch.pool_platform_fee_bps,
        pool_creator_fee_bps: launch.pool_creator_fee_bps,
        launched_at: now,
        early_window_end: now
            .checked_add(i64::from(launch.early_window_secs))
            .ok_or(ArchpadError::MathOverflow)?,
        early_wallet_cap: bps_floor(params.curve_supply, launch.early_wallet_cap_bps)
            .map_err(math_err)?,
        graduated_at: 0,
        metadata_hash: args.metadata_hash,
    };
    let mut position = Position::new(position_bump, mint_address, *creator.key);

    // Announced before the creator's buy so the log reads in the order things
    // happened: the coin exists, then it trades.
    emit_event(
        &Event::CoinCreated {
            mint: mint_address,
            creator: *creator.key,
            quote_mint: *quote_mint.key,
            timestamp: now,
        },
        launch_program,
        curve_account,
        curve_seeds,
    )?;

    // The creator's mandatory buy. It goes through the same function as every
    // other buy: same price, same fee, counted against the same wallet cap.
    let quote = settle_buy(
        &BuyAccounts {
            buyer: creator,
            curve: curve_account,
            token_vault,
            quote_vault,
            buyer_token_account: creator_token_account,
            buyer_quote_account: creator_quote_account,
            platform_fee_vault,
            creator_fee_vault,
            token_program,
            launch_program,
        },
        &mut curve,
        Some(&mut position),
        args.creator_buy_max_quote,
        args.creator_buy_min_tokens,
        now,
    )?;
    let required = bps_ceil(params.curve_supply, launch.min_creator_buy_bps).map_err(math_err)?;
    require(
        quote.tokens_out >= required,
        ArchpadError::CreatorBuyTooSmall,
    )?;
    // A launch has no pool accounts, so it cannot also be the buy that
    // completes the curve.
    require(
        !quote.completes_curve,
        ArchpadError::GraduationAccountsRequired,
    )?;

    store(curve_account, &curve)?;
    store(position_account, &position)?;
    Ok(())
}
