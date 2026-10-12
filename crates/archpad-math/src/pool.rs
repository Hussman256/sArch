//! Swap math for the pool a curve graduates into.
//!
//! A plain constant-product pool over real reserves. Liquidity is never added
//! or removed after graduation, so there is no share accounting: the only
//! moving parts are the swap and its fee.
//!
//! Fees work exactly as they do on the curve. They are computed on the quote
//! amount that moves the price, in the quote asset, for buys and sells alike.
//! The LP share stays in the pool and deepens it; the platform and creator
//! shares are paid out.

use crate::{mul_div_ceil, mul_div_floor, Fees, MathError, BPS_DENOMINATOR};

/// Hard ceiling on the pool's total swap fee, in basis points (3%).
pub const MAX_POOL_FEE_BPS: u16 = 300;

/// The three shares of the pool's swap fee, in basis points of the quote amount.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolFeeRates {
    /// Share that stays in the pool.
    pub lp_bps: u16,
    /// Share paid to the platform.
    pub platform_bps: u16,
    /// Share paid to the coin's creator.
    pub creator_bps: u16,
}

impl PoolFeeRates {
    /// All three shares added together.
    pub const fn total_bps(&self) -> u32 {
        self.lp_bps as u32 + self.platform_bps as u32 + self.creator_bps as u32
    }

    /// Rejects rates whose total exceeds [`MAX_POOL_FEE_BPS`].
    pub fn validate(&self) -> Result<(), MathError> {
        if self.total_bps() > u32::from(MAX_POOL_FEE_BPS) {
            return Err(MathError::InvalidParams);
        }
        Ok(())
    }
}

/// What the pool holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolReserves {
    /// Quote asset in the pool.
    pub quote: u64,
    /// Tokens in the pool.
    pub token: u64,
}

impl PoolReserves {
    /// `quote * token`. Never decreases across swaps.
    pub const fn invariant(&self) -> u128 {
        self.quote as u128 * self.token as u128
    }
}

/// A pool swap fee, split three ways.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PoolFees {
    /// Stays in the pool.
    pub lp: u64,
    /// Paid out to the platform and the creator.
    pub paid_out: Fees,
}

impl PoolFees {
    /// All three shares added together.
    pub fn total(&self) -> Result<u64, MathError> {
        self.lp
            .checked_add(self.paid_out.total()?)
            .ok_or(MathError::Overflow)
    }
}

/// Fee on the quote amount that moves the pool price. The total rounds up; the
/// LP and platform shares take the floor of their part and the creator takes
/// the rest.
pub fn split_pool_fee(quote_amount: u64, rates: &PoolFeeRates) -> Result<PoolFees, MathError> {
    rates.validate()?;
    let total_bps = u64::from(rates.total_bps());
    if total_bps == 0 {
        return Ok(PoolFees::default());
    }
    let total = mul_div_ceil(quote_amount, total_bps, BPS_DENOMINATOR)?;
    let lp = mul_div_floor(total, u64::from(rates.lp_bps), total_bps)?;
    let platform = mul_div_floor(total, u64::from(rates.platform_bps), total_bps)?;
    Ok(PoolFees {
        lp,
        paid_out: Fees {
            platform,
            creator: total - lp - platform,
        },
    })
}

/// What a pool buy (quote in, tokens out) will do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolBuyQuote {
    /// Quote that moves the price.
    pub quote_to_pool: u64,
    /// Fee charged on top of `quote_to_pool`.
    pub fees: PoolFees,
    /// Total taken from the buyer. Never more than the stated maximum.
    pub quote_charged: u64,
    /// Tokens the buyer receives.
    pub tokens_out: u64,
    /// Reserves once the swap settles, LP fee included.
    pub reserves_after: PoolReserves,
}

/// What a pool sell (tokens in, quote out) will do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolSellQuote {
    /// Quote the swap frees from the pool, before fees.
    pub quote_from_pool: u64,
    /// Fee taken out of `quote_from_pool`.
    pub fees: PoolFees,
    /// Quote the seller receives.
    pub quote_out: u64,
    /// Reserves once the swap settles, LP fee included.
    pub reserves_after: PoolReserves,
}

/// Prices a pool buy that spends at most `max_quote_in`, fee included.
pub fn pool_quote_buy(
    reserves: &PoolReserves,
    rates: &PoolFeeRates,
    max_quote_in: u64,
) -> Result<PoolBuyQuote, MathError> {
    rates.validate()?;
    if max_quote_in == 0 {
        return Err(MathError::ZeroAmount);
    }
    if reserves.quote == 0 || reserves.token == 0 {
        return Err(MathError::InsufficientReserves);
    }

    let total_bps = u64::from(rates.total_bps());
    let quote_to_pool = mul_div_floor(max_quote_in, BPS_DENOMINATOR, BPS_DENOMINATOR + total_bps)?;
    if quote_to_pool == 0 {
        return Err(MathError::DustTrade);
    }
    let quote_after_swap = reserves
        .quote
        .checked_add(quote_to_pool)
        .ok_or(MathError::Overflow)?;
    // Strictly less than the token reserve, so the pool can never be emptied.
    let tokens_out = mul_div_floor(reserves.token, quote_to_pool, quote_after_swap)?;
    if tokens_out == 0 {
        return Err(MathError::DustTrade);
    }

    let fees = split_pool_fee(quote_to_pool, rates)?;
    let quote_charged = quote_to_pool
        .checked_add(fees.total()?)
        .ok_or(MathError::Overflow)?;
    if quote_charged > max_quote_in {
        return Err(MathError::InvalidParams);
    }

    Ok(PoolBuyQuote {
        quote_to_pool,
        fees,
        quote_charged,
        tokens_out,
        reserves_after: PoolReserves {
            quote: quote_after_swap
                .checked_add(fees.lp)
                .ok_or(MathError::Overflow)?,
            token: reserves.token - tokens_out,
        },
    })
}

/// Prices a pool sell of exactly `tokens_in`.
pub fn pool_quote_sell(
    reserves: &PoolReserves,
    rates: &PoolFeeRates,
    tokens_in: u64,
) -> Result<PoolSellQuote, MathError> {
    rates.validate()?;
    if tokens_in == 0 {
        return Err(MathError::ZeroAmount);
    }
    if reserves.quote == 0 || reserves.token == 0 {
        return Err(MathError::InsufficientReserves);
    }

    let token_after = reserves
        .token
        .checked_add(tokens_in)
        .ok_or(MathError::Overflow)?;
    // Strictly less than the quote reserve, so the pool can never be emptied.
    let quote_from_pool = mul_div_floor(reserves.quote, tokens_in, token_after)?;

    let fees = split_pool_fee(quote_from_pool, rates)?;
    let quote_out = quote_from_pool
        .checked_sub(fees.total()?)
        .ok_or(MathError::Overflow)?;
    if quote_out == 0 {
        return Err(MathError::DustTrade);
    }

    Ok(PoolSellQuote {
        quote_from_pool,
        fees,
        quote_out,
        reserves_after: PoolReserves {
            quote: reserves.quote - quote_from_pool + fees.lp,
            token: token_after,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pool as it stands right after a reference curve graduates.
    const FRESH: PoolReserves = PoolReserves {
        quote: 85_005_359_057,
        token: 206_900_000_000_000,
    };
    const RATES: PoolFeeRates = PoolFeeRates {
        lp_bps: 20,
        platform_bps: 5,
        creator_bps: 5,
    };
    const FREE: PoolFeeRates = PoolFeeRates {
        lp_bps: 0,
        platform_bps: 0,
        creator_bps: 0,
    };

    #[test]
    fn buy_follows_the_constant_product_formula() {
        let buy = pool_quote_buy(&FRESH, &FREE, 1_000_000_000).unwrap();
        // 206.9e12 * 1e9 / (85.005359057e9 + 1e9), rounded down.
        assert_eq!(buy.tokens_out, 2_405_664_045_456);
        assert_eq!(buy.quote_charged, 1_000_000_000);
        assert_eq!(buy.reserves_after.quote, 86_005_359_057);
        assert!(buy.reserves_after.invariant() >= FRESH.invariant());
    }

    #[test]
    fn fee_is_charged_on_top_and_split_three_ways() {
        let buy = pool_quote_buy(&FRESH, &RATES, 1_003_000_000).unwrap();
        assert_eq!(buy.quote_to_pool, 1_000_000_000);
        assert_eq!(buy.fees.lp, 2_000_000);
        assert_eq!(
            buy.fees.paid_out,
            Fees {
                platform: 500_000,
                creator: 500_000
            }
        );
        assert_eq!(buy.quote_charged, 1_003_000_000);
        // The LP share is kept by the pool on top of the swap amount.
        assert_eq!(
            buy.reserves_after.quote,
            FRESH.quote + 1_000_000_000 + 2_000_000
        );
    }

    #[test]
    fn sell_pays_out_net_of_fees_and_keeps_the_lp_share() {
        let sell = pool_quote_sell(&FRESH, &RATES, 2_000_000_000_000).unwrap();
        let fees = split_pool_fee(sell.quote_from_pool, &RATES).unwrap();
        assert_eq!(sell.fees, fees);
        assert_eq!(sell.quote_out, sell.quote_from_pool - fees.total().unwrap());
        assert_eq!(
            sell.reserves_after.quote,
            FRESH.quote - sell.quote_from_pool + fees.lp
        );
        assert_eq!(sell.reserves_after.token, FRESH.token + 2_000_000_000_000);
        assert!(sell.reserves_after.invariant() >= FRESH.invariant());
    }

    #[test]
    fn round_trip_loses_the_fees() {
        let buy = pool_quote_buy(&FRESH, &RATES, 5_000_000_000).unwrap();
        let sell = pool_quote_sell(&buy.reserves_after, &RATES, buy.tokens_out).unwrap();
        assert!(sell.quote_out < buy.quote_charged);
        assert!(sell.reserves_after.invariant() > FRESH.invariant());
    }

    #[test]
    fn neither_side_can_be_drained() {
        let buy = pool_quote_buy(&FRESH, &FREE, u64::MAX / 2).unwrap();
        assert!(buy.tokens_out < FRESH.token);
        assert!(buy.reserves_after.token >= 1);

        let sell = pool_quote_sell(&FRESH, &FREE, u64::MAX / 2).unwrap();
        assert!(sell.quote_from_pool < FRESH.quote);
        assert!(sell.reserves_after.quote >= 1);
    }

    #[test]
    fn dust_zero_and_empty_pools_are_refused() {
        assert_eq!(
            pool_quote_buy(&FRESH, &RATES, 0),
            Err(MathError::ZeroAmount)
        );
        assert_eq!(
            pool_quote_sell(&FRESH, &RATES, 0),
            Err(MathError::ZeroAmount)
        );
        // One base unit of the token is worth less than one unit of quote.
        assert_eq!(
            pool_quote_sell(&FRESH, &RATES, 1),
            Err(MathError::DustTrade)
        );

        let empty = PoolReserves { quote: 0, token: 0 };
        assert_eq!(
            pool_quote_buy(&empty, &RATES, 1_000),
            Err(MathError::InsufficientReserves)
        );
        assert_eq!(
            pool_quote_sell(&empty, &RATES, 1_000),
            Err(MathError::InsufficientReserves)
        );
    }

    #[test]
    fn fee_rates_are_capped() {
        let at_ceiling = PoolFeeRates {
            lp_bps: 100,
            platform_bps: 100,
            creator_bps: 100,
        };
        assert!(at_ceiling.validate().is_ok());
        let over = PoolFeeRates {
            lp_bps: 100,
            platform_bps: 100,
            creator_bps: 101,
        };
        assert_eq!(over.validate(), Err(MathError::InvalidParams));
        assert_eq!(
            pool_quote_buy(&FRESH, &over, 1_000_000),
            Err(MathError::InvalidParams)
        );
        assert_eq!(
            pool_quote_sell(&FRESH, &over, 1_000_000),
            Err(MathError::InvalidParams)
        );
    }

    #[test]
    fn fee_dust_goes_to_the_creator() {
        // 1 unit: total fee rounds up to 1; LP and platform floors are 0.
        let fees = split_pool_fee(1, &RATES).unwrap();
        assert_eq!(fees.lp, 0);
        assert_eq!(
            fees.paid_out,
            Fees {
                platform: 0,
                creator: 1
            }
        );
        assert_eq!(split_pool_fee(0, &RATES), Ok(PoolFees::default()));
    }
}
