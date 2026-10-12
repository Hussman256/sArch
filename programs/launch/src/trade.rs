//! Buying from and selling to a curve, and graduating it.
//!
//! [`settle_buy`] is the only code that sells curve tokens. The creator's
//! launch buy goes through it too, so there is one price, one fee and one
//! wallet-cap check for everybody.

use arch_program::{
    account::AccountInfo,
    entrypoint::ProgramResult,
    program::{get_clock, invoke_signed},
    program_error::ProgramError,
    system_program::SYSTEM_PROGRAM_ID,
};
use archpad_interface::{
    error::math_err,
    ids,
    launch::{find_position_address, Curve, CurveStatus, Position, CURVE_SEED, POSITION_SEED},
    pool::{self, InitializePoolArgs},
    AccountTag, ArchpadError, Event,
};
use archpad_math::{quote_buy, quote_sell, BuyQuote};
use archpad_program_lib::{
    create_pda_account, emit_event, load, require, require_key, require_program, require_signer,
    store, transfer_tokens, transfer_tokens_signed,
};

/// The accounts a buy moves money between.
pub struct BuyAccounts<'a, 'info> {
    pub buyer: &'a AccountInfo<'info>,
    pub curve: &'a AccountInfo<'info>,
    pub token_vault: &'a AccountInfo<'info>,
    pub quote_vault: &'a AccountInfo<'info>,
    pub buyer_token_account: &'a AccountInfo<'info>,
    pub buyer_quote_account: &'a AccountInfo<'info>,
    pub platform_fee_vault: &'a AccountInfo<'info>,
    pub creator_fee_vault: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    /// This program's own account, which it calls to record the trade.
    pub launch_program: &'a AccountInfo<'info>,
}

/// Prices a buy, enforces the buyer's limit and the launch-window cap, moves
/// the money and updates `curve`. The caller stores `curve` and `position`.
///
/// `position` is consulted and updated only while the launch window is open.
pub fn settle_buy(
    accounts: &BuyAccounts,
    curve: &mut Curve,
    position: Option<&mut Position>,
    max_quote_in: u64,
    min_tokens_out: u64,
    now: i64,
) -> Result<BuyQuote, ProgramError> {
    let quote = quote_buy(&curve.reserves(), &curve.fee_rates(), max_quote_in).map_err(math_err)?;
    require(
        quote.tokens_out >= min_tokens_out,
        ArchpadError::SlippageExceeded,
    )?;

    if curve.in_early_window(now) {
        let position = position.ok_or(ArchpadError::AccountMismatch)?;
        let bought = position
            .window_bought
            .checked_add(quote.tokens_out)
            .ok_or(ArchpadError::MathOverflow)?;
        require(
            bought <= curve.early_wallet_cap,
            ArchpadError::WalletCapExceeded,
        )?;
        position.window_bought = bought;
    }

    transfer_tokens(
        accounts.token_program,
        accounts.buyer_quote_account,
        accounts.quote_vault,
        accounts.buyer,
        quote.quote_to_curve,
    )?;
    transfer_tokens(
        accounts.token_program,
        accounts.buyer_quote_account,
        accounts.platform_fee_vault,
        accounts.buyer,
        quote.fees.platform,
    )?;
    transfer_tokens(
        accounts.token_program,
        accounts.buyer_quote_account,
        accounts.creator_fee_vault,
        accounts.buyer,
        quote.fees.creator,
    )?;
    // Copied out so the seeds do not hold a borrow of `curve` while it is updated.
    let (mint, bump) = (curve.mint, [curve.bump]);
    let curve_seeds: &[&[u8]] = &[CURVE_SEED, mint.as_ref(), &bump];
    transfer_tokens_signed(
        accounts.token_program,
        accounts.token_vault,
        accounts.buyer_token_account,
        accounts.curve,
        quote.tokens_out,
        &[curve_seeds],
    )?;

    curve.set_reserves(&quote.reserves_after);
    emit_event(
        &Event::Trade {
            mint,
            trader: *accounts.buyer.key,
            is_buy: true,
            quote_amount: quote.quote_to_curve,
            token_amount: quote.tokens_out,
            platform_fee: quote.fees.platform,
            creator_fee: quote.fees.creator,
            virtual_quote: curve.virtual_quote,
            virtual_token: curve.virtual_token,
            real_quote: curve.real_quote,
            real_token: curve.real_token,
            timestamp: now,
        },
        accounts.launch_program,
        accounts.curve,
        curve_seeds,
    )?;
    Ok(quote)
}

/// Loads a trading curve and checks the vaults passed alongside it are the
/// ones it recorded at launch.
fn load_trading_curve(
    curve_account: &AccountInfo,
    token_vault: &AccountInfo,
    quote_vault: &AccountInfo,
    platform_fee_vault: &AccountInfo,
    creator_fee_vault: &AccountInfo,
) -> Result<Curve, ProgramError> {
    let curve: Curve = load(curve_account, &ids::launch::ID, AccountTag::Curve)?;
    require(curve.is_trading(), ArchpadError::CurveGraduated)?;
    require_key(token_vault, &curve.token_vault)?;
    require_key(quote_vault, &curve.quote_vault)?;
    require_key(platform_fee_vault, &curve.platform_fee_vault)?;
    require_key(creator_fee_vault, &curve.creator_fee_vault)?;
    Ok(curve)
}

/// Loads the buyer's position, creating it on their first buy of the window.
fn load_or_create_position<'info>(
    position_account: &AccountInfo<'info>,
    buyer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    curve: &Curve,
) -> Result<Position, ProgramError> {
    if *position_account.owner == ids::launch::ID {
        let position: Position = load(position_account, &ids::launch::ID, AccountTag::Position)?;
        // A position records its coin and wallet, so one wallet's allowance
        // cannot be spent by another or carried to a different coin.
        require(
            position.mint == curve.mint && position.wallet == *buyer.key,
            ArchpadError::AccountMismatch,
        )?;
        return Ok(position);
    }

    let (address, bump) = find_position_address(&curve.mint, buyer.key);
    require_key(position_account, &address)?;
    create_pda_account(
        buyer,
        position_account,
        system_program,
        Position::LEN,
        &ids::launch::ID,
        &[
            POSITION_SEED,
            curve.mint.as_ref(),
            buyer.key.as_ref(),
            &[bump],
        ],
    )?;
    Ok(Position::new(bump, curve.mint, *buyer.key))
}

/// Handles [`archpad_interface::launch::LaunchInstruction::Buy`].
pub fn buy(accounts: &[AccountInfo], max_quote_in: u64, min_tokens_out: u64) -> ProgramResult {
    let [buyer, curve_account, token_vault, quote_vault, buyer_token_account, buyer_quote_account, position_account, platform_fee_vault, creator_fee_vault, token_program, system_program, launch_program, graduation_accounts @ ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    require_signer(buyer)?;
    require_program(system_program, &SYSTEM_PROGRAM_ID)?;
    require_program(launch_program, &ids::launch::ID)?;
    let mut curve = load_trading_curve(
        curve_account,
        token_vault,
        quote_vault,
        platform_fee_vault,
        creator_fee_vault,
    )?;
    let now = get_clock().unix_timestamp;

    // The position only matters while the cap applies. Outside the window it
    // is neither read nor created, so late buyers pay no rent for one.
    let mut position = if curve.in_early_window(now) {
        Some(load_or_create_position(
            position_account,
            buyer,
            system_program,
            &curve,
        )?)
    } else {
        None
    };

    let quote = settle_buy(
        &BuyAccounts {
            buyer,
            curve: curve_account,
            token_vault,
            quote_vault,
            buyer_token_account,
            buyer_quote_account,
            platform_fee_vault,
            creator_fee_vault,
            token_program,
            launch_program,
        },
        &mut curve,
        position.as_mut(),
        max_quote_in,
        min_tokens_out,
        now,
    )?;

    if quote.completes_curve {
        graduate(
            &mut curve,
            buyer,
            curve_account,
            token_vault,
            quote_vault,
            token_program,
            system_program,
            launch_program,
            graduation_accounts,
            now,
        )?;
    }

    if let Some(position) = &position {
        store(position_account, position)?;
    }
    store(curve_account, &curve)
}

/// Moves a sold-out curve's reserves into the coin's pool.
///
/// Runs inside the buy that sold the last token. If anything here fails, that
/// buy fails with it and the curve is exactly as it was: there is no state in
/// which the curve is closed but the pool is not open.
#[allow(clippy::too_many_arguments)]
fn graduate<'info>(
    curve: &mut Curve,
    payer: &AccountInfo<'info>,
    curve_account: &AccountInfo<'info>,
    token_vault: &AccountInfo<'info>,
    quote_vault: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    launch_program: &AccountInfo<'info>,
    graduation_accounts: &[AccountInfo<'info>],
    now: i64,
) -> ProgramResult {
    let [pool_program, pool_account, pool_token_vault, pool_quote_vault, mint, quote_mint, ..] =
        graduation_accounts
    else {
        return Err(ArchpadError::GraduationAccountsRequired.into());
    };
    require_program(pool_program, &ids::pool::ID)?;
    require_key(mint, &curve.mint)?;
    require_key(quote_mint, &curve.quote_mint)?;

    // Everything the curve holds goes: all the quote buyers paid in, and the
    // supply held back for the pool. No fee is taken.
    let token_amount = curve.pool_supply();
    let quote_amount = curve.real_quote;

    // Copied out so the seeds do not hold a borrow of `curve` while it is updated.
    let (mint_key, bump) = (curve.mint, [curve.bump]);
    let curve_seeds: &[&[u8]] = &[CURVE_SEED, mint_key.as_ref(), &bump];
    invoke_signed(
        &pool::initialize(
            payer.key,
            &curve.mint,
            &curve.quote_mint,
            InitializePoolArgs {
                token_amount,
                quote_amount,
                creator: curve.creator,
                platform_fee_vault: curve.platform_fee_vault,
                creator_fee_vault: curve.creator_fee_vault,
                lp_fee_bps: curve.pool_lp_fee_bps,
                platform_fee_bps: curve.pool_platform_fee_bps,
                creator_fee_bps: curve.pool_creator_fee_bps,
            },
        ),
        &[
            payer.clone(),
            curve_account.clone(),
            pool_account.clone(),
            pool_token_vault.clone(),
            pool_quote_vault.clone(),
            token_vault.clone(),
            quote_vault.clone(),
            mint.clone(),
            quote_mint.clone(),
            token_program.clone(),
            system_program.clone(),
            pool_program.clone(),
        ],
        &[curve_seeds],
    )?;

    curve.status = CurveStatus::Graduated as u8;
    curve.graduated_at = now;
    emit_event(
        &Event::Graduated {
            mint: mint_key,
            pool: *pool_account.key,
            quote_amount,
            token_amount,
            timestamp: now,
        },
        launch_program,
        curve_account,
        curve_seeds,
    )
}

/// Handles [`archpad_interface::launch::LaunchInstruction::Sell`].
pub fn sell(accounts: &[AccountInfo], tokens_in: u64, min_quote_out: u64) -> ProgramResult {
    let [seller, curve_account, token_vault, quote_vault, seller_token_account, seller_quote_account, platform_fee_vault, creator_fee_vault, token_program, launch_program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    require_signer(seller)?;
    require_program(launch_program, &ids::launch::ID)?;
    let mut curve = load_trading_curve(
        curve_account,
        token_vault,
        quote_vault,
        platform_fee_vault,
        creator_fee_vault,
    )?;

    let quote = quote_sell(&curve.reserves(), &curve.fee_rates(), tokens_in).map_err(math_err)?;
    require(
        quote.quote_out >= min_quote_out,
        ArchpadError::SlippageExceeded,
    )?;

    // Copied out so the seeds do not hold a borrow of `curve` while it is updated.
    let (mint, bump) = (curve.mint, [curve.bump]);
    let curve_seeds: &[&[u8]] = &[CURVE_SEED, mint.as_ref(), &bump];
    transfer_tokens(
        token_program,
        seller_token_account,
        token_vault,
        seller,
        tokens_in,
    )?;
    transfer_tokens_signed(
        token_program,
        quote_vault,
        seller_quote_account,
        curve_account,
        quote.quote_out,
        &[curve_seeds],
    )?;
    transfer_tokens_signed(
        token_program,
        quote_vault,
        platform_fee_vault,
        curve_account,
        quote.fees.platform,
        &[curve_seeds],
    )?;
    transfer_tokens_signed(
        token_program,
        quote_vault,
        creator_fee_vault,
        curve_account,
        quote.fees.creator,
        &[curve_seeds],
    )?;

    curve.set_reserves(&quote.reserves_after);
    store(curve_account, &curve)?;
    emit_event(
        &Event::Trade {
            mint,
            trader: *seller.key,
            is_buy: false,
            quote_amount: quote.quote_from_curve,
            token_amount: tokens_in,
            platform_fee: quote.fees.platform,
            creator_fee: quote.fees.creator,
            virtual_quote: curve.virtual_quote,
            virtual_token: curve.virtual_token,
            real_quote: curve.real_quote,
            real_token: curve.real_token,
            timestamp: get_clock().unix_timestamp,
        },
        launch_program,
        curve_account,
        curve_seeds,
    )
}
