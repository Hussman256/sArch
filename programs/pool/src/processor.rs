//! Instruction handling for the pool program.

use arch_program::{
    account::AccountInfo, entrypoint::ProgramResult, program::get_clock,
    program_error::ProgramError, pubkey::Pubkey,
};
use archpad_interface::{
    error::math_err,
    ids,
    launch::find_curve_address,
    pool::{
        find_pool_address, find_pool_quote_vault_address, find_pool_token_vault_address,
        InitializePoolArgs, Pool, PoolInstruction, POOL_QUOTE_VAULT_SEED, POOL_SEED,
        POOL_TOKEN_VAULT_SEED,
    },
    AccountTag, ArchpadError, Event,
};
use archpad_math::{pool_quote_buy, pool_quote_sell, PoolFeeRates};
use archpad_program_lib::{
    create_pda_account, create_pda_token_account, emit_event, load, process_event, require,
    require_key, require_program, require_signer, require_signer_key, store, transfer_tokens,
    transfer_tokens_signed,
};

/// Entry point for every pool instruction.
pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    require(
        *program_id == ids::pool::ID,
        ProgramError::IncorrectProgramId,
    )?;
    if let Some(result) = process_event(program_id, accounts, data) {
        return result;
    }

    match PoolInstruction::unpack(data)? {
        PoolInstruction::Initialize(args) => initialize(accounts, args),
        PoolInstruction::Swap {
            buy,
            amount_in,
            min_amount_out,
        } => swap(accounts, buy, amount_in, min_amount_out),
    }
}

fn initialize(accounts: &[AccountInfo], args: InitializePoolArgs) -> ProgramResult {
    let [payer, curve, pool_account, pool_token_vault, pool_quote_vault, curve_token_vault, curve_quote_vault, mint, quote_mint, token_program, system_program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    require_signer(payer)?;
    // Only the launch program can sign as a coin's curve, and it does so once,
    // when the curve sells out. That is what makes this the coin's one pool,
    // opened at the price the curve closed at.
    let (curve_address, _) = find_curve_address(mint.key);
    require_signer_key(curve, &curve_address)?;

    let (pool_address, pool_bump) = find_pool_address(mint.key);
    require_key(pool_account, &pool_address)?;
    let (token_vault_address, token_vault_bump) = find_pool_token_vault_address(mint.key);
    require_key(pool_token_vault, &token_vault_address)?;
    let (quote_vault_address, quote_vault_bump) = find_pool_quote_vault_address(mint.key);
    require_key(pool_quote_vault, &quote_vault_address)?;

    PoolFeeRates {
        lp_bps: args.lp_fee_bps,
        platform_bps: args.platform_fee_bps,
        creator_bps: args.creator_fee_bps,
    }
    .validate()
    .map_err(math_err)?;
    require(
        args.token_amount > 0 && args.quote_amount > 0,
        ArchpadError::InvalidParams,
    )?;

    create_pda_account(
        payer,
        pool_account,
        system_program,
        Pool::LEN,
        &ids::pool::ID,
        &[POOL_SEED, mint.key.as_ref(), &[pool_bump]],
    )?;
    create_pda_token_account(
        payer,
        pool_token_vault,
        mint,
        &pool_address,
        system_program,
        token_program,
        &[
            POOL_TOKEN_VAULT_SEED,
            mint.key.as_ref(),
            &[token_vault_bump],
        ],
    )?;
    create_pda_token_account(
        payer,
        pool_quote_vault,
        quote_mint,
        &pool_address,
        system_program,
        token_program,
        &[
            POOL_QUOTE_VAULT_SEED,
            mint.key.as_ref(),
            &[quote_vault_bump],
        ],
    )?;

    // Pull the reserves across. The curve signed this instruction, and its
    // signature carries into the transfers out of its own vaults. Pulling,
    // rather than trusting the caller to push, means the reserves recorded
    // below are exactly what arrived.
    transfer_tokens(
        token_program,
        curve_token_vault,
        pool_token_vault,
        curve,
        args.token_amount,
    )?;
    transfer_tokens(
        token_program,
        curve_quote_vault,
        pool_quote_vault,
        curve,
        args.quote_amount,
    )?;

    store(
        pool_account,
        &Pool {
            tag: AccountTag::Pool as u8,
            version: Pool::VERSION,
            bump: pool_bump,
            mint: *mint.key,
            quote_mint: *quote_mint.key,
            creator: args.creator,
            token_vault: token_vault_address,
            quote_vault: quote_vault_address,
            platform_fee_vault: args.platform_fee_vault,
            creator_fee_vault: args.creator_fee_vault,
            quote_reserve: args.quote_amount,
            token_reserve: args.token_amount,
            lp_fee_bps: args.lp_fee_bps,
            platform_fee_bps: args.platform_fee_bps,
            creator_fee_bps: args.creator_fee_bps,
            created_at: get_clock().unix_timestamp,
        },
    )
}

fn swap(accounts: &[AccountInfo], buy: bool, amount_in: u64, min_amount_out: u64) -> ProgramResult {
    let [trader, pool_account, pool_token_vault, pool_quote_vault, trader_token_account, trader_quote_account, platform_fee_vault, creator_fee_vault, token_program, pool_program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    require_signer(trader)?;
    require_program(pool_program, &ids::pool::ID)?;
    let mut pool: Pool = load(pool_account, &ids::pool::ID, AccountTag::Pool)?;
    require_key(pool_token_vault, &pool.token_vault)?;
    require_key(pool_quote_vault, &pool.quote_vault)?;
    require_key(platform_fee_vault, &pool.platform_fee_vault)?;
    require_key(creator_fee_vault, &pool.creator_fee_vault)?;

    let rates = pool.fee_rates();
    // Copied out so the seeds do not hold a borrow of `pool` while it is updated.
    let (mint, bump) = (pool.mint, [pool.bump]);
    let pool_seeds: &[&[u8]] = &[POOL_SEED, mint.as_ref(), &bump];

    let event = if buy {
        let quote = pool_quote_buy(&pool.reserves(), &rates, amount_in).map_err(math_err)?;
        require(
            quote.tokens_out >= min_amount_out,
            ArchpadError::SlippageExceeded,
        )?;

        // The price-moving amount and the LP share both stay in the pool.
        let to_pool = quote
            .quote_to_pool
            .checked_add(quote.fees.lp)
            .ok_or(ArchpadError::MathOverflow)?;
        transfer_tokens(
            token_program,
            trader_quote_account,
            pool_quote_vault,
            trader,
            to_pool,
        )?;
        transfer_tokens(
            token_program,
            trader_quote_account,
            platform_fee_vault,
            trader,
            quote.fees.paid_out.platform,
        )?;
        transfer_tokens(
            token_program,
            trader_quote_account,
            creator_fee_vault,
            trader,
            quote.fees.paid_out.creator,
        )?;
        transfer_tokens_signed(
            token_program,
            pool_token_vault,
            trader_token_account,
            pool_account,
            quote.tokens_out,
            &[pool_seeds],
        )?;

        pool.set_reserves(&quote.reserves_after);
        Event::PoolSwap {
            mint: pool.mint,
            trader: *trader.key,
            is_buy: true,
            quote_amount: quote.quote_to_pool,
            token_amount: quote.tokens_out,
            lp_fee: quote.fees.lp,
            platform_fee: quote.fees.paid_out.platform,
            creator_fee: quote.fees.paid_out.creator,
            quote_reserve: pool.quote_reserve,
            token_reserve: pool.token_reserve,
            timestamp: get_clock().unix_timestamp,
        }
    } else {
        let quote = pool_quote_sell(&pool.reserves(), &rates, amount_in).map_err(math_err)?;
        require(
            quote.quote_out >= min_amount_out,
            ArchpadError::SlippageExceeded,
        )?;

        transfer_tokens(
            token_program,
            trader_token_account,
            pool_token_vault,
            trader,
            amount_in,
        )?;
        transfer_tokens_signed(
            token_program,
            pool_quote_vault,
            trader_quote_account,
            pool_account,
            quote.quote_out,
            &[pool_seeds],
        )?;
        transfer_tokens_signed(
            token_program,
            pool_quote_vault,
            platform_fee_vault,
            pool_account,
            quote.fees.paid_out.platform,
            &[pool_seeds],
        )?;
        transfer_tokens_signed(
            token_program,
            pool_quote_vault,
            creator_fee_vault,
            pool_account,
            quote.fees.paid_out.creator,
            &[pool_seeds],
        )?;

        pool.set_reserves(&quote.reserves_after);
        Event::PoolSwap {
            mint: pool.mint,
            trader: *trader.key,
            is_buy: false,
            quote_amount: quote.quote_from_pool,
            token_amount: amount_in,
            lp_fee: quote.fees.lp,
            platform_fee: quote.fees.paid_out.platform,
            creator_fee: quote.fees.paid_out.creator,
            quote_reserve: pool.quote_reserve,
            token_reserve: pool.token_reserve,
            timestamp: get_clock().unix_timestamp,
        }
    };

    store(pool_account, &pool)?;
    emit_event(&event, pool_program, pool_account, pool_seeds)
}
