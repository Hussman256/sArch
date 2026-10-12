use crate::{mul_div_ceil, mul_div_floor, split_fee, FeeRates, Fees, MathError, BPS_DENOMINATOR};

/// How far the price a graduated pool opens at may sit from the price the curve
/// closes at, in basis points (1%).
///
/// A larger gap would be an arbitrage against whoever bought last on the curve,
/// so [`CurveParams::validate`] rejects shapes outside it.
pub const PRICE_CONTINUITY_TOLERANCE_BPS: u64 = 100;

/// The fixed shape of a bonding curve. Set when a coin launches and never
/// changed afterwards.
///
/// Token amounts are in the coin's base units, quote amounts in the quote
/// asset's base units (for example satoshis).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CurveParams {
    /// Every token that will ever exist.
    pub total_supply: u64,
    /// Tokens sold through the curve. The remainder seeds the pool at graduation.
    pub curve_supply: u64,
    /// Starting virtual token reserves. Must exceed `curve_supply`.
    pub virtual_token_reserves: u64,
    /// Starting virtual quote reserves. Sets the opening price.
    pub virtual_quote_reserves: u64,
}

impl CurveParams {
    /// Tokens held back from the curve to seed the pool at graduation.
    pub fn pool_supply(&self) -> Result<u64, MathError> {
        self.total_supply
            .checked_sub(self.curve_supply)
            .ok_or(MathError::InvalidParams)
    }

    /// Quote the curve must take in to sell its whole `curve_supply`: the
    /// graduation target.
    pub fn graduation_quote(&self) -> Result<u64, MathError> {
        let tokens_left = self
            .virtual_token_reserves
            .checked_sub(self.curve_supply)
            .filter(|left| *left > 0)
            .ok_or(MathError::InvalidParams)?;
        mul_div_ceil(self.virtual_quote_reserves, self.curve_supply, tokens_left)
    }

    /// Checks the shape is usable and that the pool will open at the price the
    /// curve closes at, within [`PRICE_CONTINUITY_TOLERANCE_BPS`].
    pub fn validate(&self) -> Result<(), MathError> {
        if self.curve_supply == 0
            || self.virtual_quote_reserves == 0
            || self.curve_supply >= self.total_supply
            || self.virtual_token_reserves <= self.curve_supply
        {
            return Err(MathError::InvalidParams);
        }
        let pool_supply = self.total_supply - self.curve_supply;
        let target = self.graduation_quote()?;
        let end_virtual_quote = self
            .virtual_quote_reserves
            .checked_add(target)
            .ok_or(MathError::Overflow)?;
        let end_virtual_token = self.virtual_token_reserves - self.curve_supply;

        // Pool opening price   = target / pool_supply
        // Curve closing price  = end_virtual_quote / end_virtual_token
        // Compared cross-multiplied so nothing is divided.
        let pool_side = u128::from(target) * u128::from(end_virtual_token);
        let curve_side = u128::from(end_virtual_quote) * u128::from(pool_supply);
        let allowed =
            curve_side / u128::from(BPS_DENOMINATOR) * u128::from(PRICE_CONTINUITY_TOLERANCE_BPS);
        if pool_side.abs_diff(curve_side) > allowed {
            return Err(MathError::InvalidParams);
        }
        Ok(())
    }

    /// Derives the virtual reserves for a curve that raises `graduation_quote`
    /// by selling `curve_supply`, and whose pool opens at the curve's closing
    /// price.
    ///
    /// The curve must sell more than half the supply, otherwise no such shape
    /// exists.
    pub fn from_target(
        total_supply: u64,
        curve_supply: u64,
        graduation_quote: u64,
    ) -> Result<Self, MathError> {
        let pool_supply = total_supply
            .checked_sub(curve_supply)
            .ok_or(MathError::InvalidParams)?;
        let spread = curve_supply
            .checked_sub(pool_supply)
            .filter(|spread| *spread > 0)
            .ok_or(MathError::InvalidParams)?;

        // Price continuity pins virtual_token = curve_supply^2 / (curve_supply - pool_supply).
        let squared = u128::from(curve_supply) * u128::from(curve_supply);
        let spread = u128::from(spread);
        let virtual_token = squared / spread + u128::from(squared % spread != 0);
        let virtual_token_reserves =
            u64::try_from(virtual_token).map_err(|_| MathError::Overflow)?;

        let virtual_quote_reserves = mul_div_floor(
            graduation_quote,
            virtual_token_reserves - curve_supply,
            curve_supply,
        )?;

        let params = Self {
            total_supply,
            curve_supply,
            virtual_token_reserves,
            virtual_quote_reserves,
        };
        params.validate()?;
        Ok(params)
    }

    /// Reserves of a freshly launched curve.
    pub const fn initial_reserves(&self) -> Reserves {
        Reserves {
            virtual_quote: self.virtual_quote_reserves,
            virtual_token: self.virtual_token_reserves,
            real_quote: 0,
            real_token: self.curve_supply,
        }
    }
}

/// The live state of a curve.
///
/// Prices come from the virtual reserves. The real reserves track what the
/// curve actually holds: quote deposited by buyers and tokens still for sale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reserves {
    /// Virtual quote reserves: the starting value plus `real_quote`.
    pub virtual_quote: u64,
    /// Virtual token reserves.
    pub virtual_token: u64,
    /// Quote deposited by buyers and not yet paid back to sellers.
    pub real_quote: u64,
    /// Curve tokens not yet sold.
    pub real_token: u64,
}

impl Reserves {
    /// True once every curve token is sold.
    pub const fn is_complete(&self) -> bool {
        self.real_token == 0
    }

    /// `virtual_quote * virtual_token`. Never decreases across trades.
    pub const fn invariant(&self) -> u128 {
        self.virtual_quote as u128 * self.virtual_token as u128
    }
}

/// What a buy will do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuyQuote {
    /// Quote that enters the curve.
    pub quote_to_curve: u64,
    /// Fee charged on top of `quote_to_curve`.
    pub fees: Fees,
    /// Total taken from the buyer: `quote_to_curve` plus fees. Never more than
    /// the buyer's stated maximum.
    pub quote_charged: u64,
    /// Tokens the buyer receives.
    pub tokens_out: u64,
    /// Reserves once the buy settles.
    pub reserves_after: Reserves,
    /// True when this buy takes the last curve tokens.
    pub completes_curve: bool,
}

/// What a sell will do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SellQuote {
    /// Quote that leaves the curve.
    pub quote_from_curve: u64,
    /// Fee taken out of `quote_from_curve`.
    pub fees: Fees,
    /// Quote the seller receives: `quote_from_curve` minus fees.
    pub quote_out: u64,
    /// Reserves once the sell settles.
    pub reserves_after: Reserves,
}

/// Prices a buy that spends at most `max_quote_in`, fee included.
///
/// A buy larger than the curve can fill is cut down to the remaining tokens
/// and charged only for those, so the last buy lands exactly on the graduation
/// boundary instead of overshooting it.
pub fn quote_buy(
    reserves: &Reserves,
    rates: &FeeRates,
    max_quote_in: u64,
) -> Result<BuyQuote, MathError> {
    rates.validate()?;
    if max_quote_in == 0 {
        return Err(MathError::ZeroAmount);
    }
    if reserves.is_complete() {
        return Err(MathError::CurveComplete);
    }

    // Largest curve amount `n` with `n + fee(n) <= max_quote_in`.
    let total_bps = u64::from(rates.total_bps());
    let mut quote_to_curve =
        mul_div_floor(max_quote_in, BPS_DENOMINATOR, BPS_DENOMINATOR + total_bps)?;
    if quote_to_curve == 0 {
        return Err(MathError::DustTrade);
    }

    let virtual_quote_after = reserves
        .virtual_quote
        .checked_add(quote_to_curve)
        .ok_or(MathError::Overflow)?;
    let mut tokens_out =
        mul_div_floor(reserves.virtual_token, quote_to_curve, virtual_quote_after)?;

    let completes_curve = tokens_out >= reserves.real_token;
    if completes_curve {
        tokens_out = reserves.real_token;
        let virtual_token_after = reserves
            .virtual_token
            .checked_sub(tokens_out)
            .filter(|left| *left > 0)
            .ok_or(MathError::InvalidParams)?;
        // Smallest curve amount that buys exactly the remaining tokens. It
        // cannot exceed the amount computed above, so the budget still holds.
        quote_to_curve = mul_div_ceil(reserves.virtual_quote, tokens_out, virtual_token_after)?;
    }
    if tokens_out == 0 {
        return Err(MathError::DustTrade);
    }

    let fees = split_fee(quote_to_curve, rates)?;
    let quote_charged = quote_to_curve
        .checked_add(fees.total()?)
        .ok_or(MathError::Overflow)?;
    if quote_charged > max_quote_in {
        return Err(MathError::InvalidParams);
    }

    let reserves_after = Reserves {
        virtual_quote: reserves
            .virtual_quote
            .checked_add(quote_to_curve)
            .ok_or(MathError::Overflow)?,
        virtual_token: reserves
            .virtual_token
            .checked_sub(tokens_out)
            .ok_or(MathError::InvalidParams)?,
        real_quote: reserves
            .real_quote
            .checked_add(quote_to_curve)
            .ok_or(MathError::Overflow)?,
        real_token: reserves.real_token - tokens_out,
    };

    Ok(BuyQuote {
        quote_to_curve,
        fees,
        quote_charged,
        tokens_out,
        reserves_after,
        completes_curve,
    })
}

/// Prices a sell of exactly `tokens_in`.
pub fn quote_sell(
    reserves: &Reserves,
    rates: &FeeRates,
    tokens_in: u64,
) -> Result<SellQuote, MathError> {
    rates.validate()?;
    if tokens_in == 0 {
        return Err(MathError::ZeroAmount);
    }
    if reserves.is_complete() {
        return Err(MathError::CurveComplete);
    }

    let virtual_token_after = reserves
        .virtual_token
        .checked_add(tokens_in)
        .ok_or(MathError::Overflow)?;
    let quote_from_curve = mul_div_floor(reserves.virtual_quote, tokens_in, virtual_token_after)?;
    if quote_from_curve > reserves.real_quote {
        return Err(MathError::InsufficientReserves);
    }

    let fees = split_fee(quote_from_curve, rates)?;
    let quote_out = quote_from_curve
        .checked_sub(fees.total()?)
        .ok_or(MathError::Overflow)?;
    if quote_out == 0 {
        return Err(MathError::DustTrade);
    }

    let reserves_after = Reserves {
        virtual_quote: reserves.virtual_quote - quote_from_curve,
        virtual_token: virtual_token_after,
        real_quote: reserves.real_quote - quote_from_curve,
        real_token: reserves
            .real_token
            .checked_add(tokens_in)
            .ok_or(MathError::Overflow)?,
    };

    Ok(SellQuote {
        quote_from_curve,
        fees,
        quote_out,
        reserves_after,
    })
}

/// A `max_quote_in` that is enough for [`quote_buy`] to return at least
/// `tokens_out`.
pub fn quote_in_for_tokens_out(
    reserves: &Reserves,
    rates: &FeeRates,
    tokens_out: u64,
) -> Result<u64, MathError> {
    rates.validate()?;
    if tokens_out == 0 {
        return Err(MathError::ZeroAmount);
    }
    if reserves.is_complete() {
        return Err(MathError::CurveComplete);
    }
    if tokens_out > reserves.real_token {
        return Err(MathError::InsufficientReserves);
    }
    let virtual_token_after = reserves
        .virtual_token
        .checked_sub(tokens_out)
        .filter(|left| *left > 0)
        .ok_or(MathError::InvalidParams)?;
    let quote_to_curve = mul_div_ceil(reserves.virtual_quote, tokens_out, virtual_token_after)?;
    let fees = split_fee(quote_to_curve, rates)?;
    quote_to_curve
        .checked_add(fees.total()?)
        .ok_or(MathError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pump.fun's published curve: 1bn supply at 6 decimals, priced in lamports.
    /// Used as a reference shape because its numbers are public.
    const PUMP: CurveParams = CurveParams {
        total_supply: 1_000_000_000_000_000,
        curve_supply: 793_100_000_000_000,
        virtual_token_reserves: 1_073_000_000_000_000,
        virtual_quote_reserves: 30_000_000_000,
    };
    const NO_FEE: FeeRates = FeeRates {
        platform_bps: 0,
        creator_bps: 0,
    };
    const PRD_FEE: FeeRates = FeeRates {
        platform_bps: 100,
        creator_bps: 125,
    };

    #[test]
    fn reference_shape_is_valid_and_hits_its_known_target() {
        assert_eq!(PUMP.validate(), Ok(()));
        assert_eq!(PUMP.pool_supply(), Ok(206_900_000_000_000));
        // ~85.005 SOL raised when the curve sells out.
        assert_eq!(PUMP.graduation_quote(), Ok(85_005_359_057));
    }

    #[test]
    fn first_buy_matches_the_constant_product_formula() {
        // 1 SOL into 30 virtual SOL: 1_073e12 * 1 / 31, rounded down.
        let buy = quote_buy(&PUMP.initial_reserves(), &NO_FEE, 1_000_000_000).unwrap();
        assert_eq!(buy.tokens_out, 34_612_903_225_806);
        assert_eq!(buy.quote_to_curve, 1_000_000_000);
        assert_eq!(buy.quote_charged, 1_000_000_000);
        assert!(!buy.completes_curve);
    }

    #[test]
    fn fee_is_charged_on_top_and_stays_inside_the_budget() {
        let budget = 1_000_000_000;
        let buy = quote_buy(&PUMP.initial_reserves(), &PRD_FEE, budget).unwrap();
        // floor(1e9 * 10000 / 10225) enters the curve.
        assert_eq!(buy.quote_to_curve, 977_995_110);
        assert_eq!(buy.fees, split_fee(977_995_110, &PRD_FEE).unwrap());
        assert_eq!(buy.fees.total(), Ok(22_004_890));
        assert_eq!(buy.quote_charged, 1_000_000_000);
        assert!(buy.quote_charged <= budget);
    }

    #[test]
    fn oversized_buy_is_cut_to_the_graduation_boundary() {
        let reserves = PUMP.initial_reserves();
        let buy = quote_buy(&reserves, &PRD_FEE, u64::MAX / 2).unwrap();
        assert!(buy.completes_curve);
        assert_eq!(buy.tokens_out, PUMP.curve_supply);
        assert_eq!(buy.quote_to_curve, PUMP.graduation_quote().unwrap());
        assert_eq!(buy.reserves_after.real_token, 0);
        assert_eq!(buy.reserves_after.real_quote, 85_005_359_057);
        // Charged for what it bought, not for the whole budget.
        assert_eq!(
            buy.quote_charged,
            85_005_359_057 + buy.fees.total().unwrap()
        );
    }

    #[test]
    fn exact_boundary_buy_completes_without_overpaying() {
        let reserves = PUMP.initial_reserves();
        let needed = quote_in_for_tokens_out(&reserves, &PRD_FEE, PUMP.curve_supply).unwrap();
        let buy = quote_buy(&reserves, &PRD_FEE, needed).unwrap();
        assert!(buy.completes_curve);
        assert_eq!(buy.quote_charged, needed);
        // One unit short leaves the curve open.
        let short = quote_buy(&reserves, &PRD_FEE, needed - 1).unwrap();
        assert!(!short.completes_curve);
        assert!(short.tokens_out < PUMP.curve_supply);
    }

    #[test]
    fn completed_curve_refuses_to_trade() {
        let done = quote_buy(&PUMP.initial_reserves(), &PRD_FEE, u64::MAX / 2)
            .unwrap()
            .reserves_after;
        assert!(done.is_complete());
        assert_eq!(
            quote_buy(&done, &PRD_FEE, 1_000_000),
            Err(MathError::CurveComplete)
        );
        assert_eq!(
            quote_sell(&done, &PRD_FEE, 1_000_000),
            Err(MathError::CurveComplete)
        );
        assert_eq!(
            quote_in_for_tokens_out(&done, &PRD_FEE, 1),
            Err(MathError::CurveComplete)
        );
    }

    #[test]
    fn round_trip_returns_less_than_it_cost() {
        let reserves = PUMP.initial_reserves();
        let buy = quote_buy(&reserves, &PRD_FEE, 5_000_000_000).unwrap();
        let sell = quote_sell(&buy.reserves_after, &PRD_FEE, buy.tokens_out).unwrap();
        assert!(sell.quote_out < buy.quote_charged);
        // The curve itself gives back no more than it took in.
        assert!(sell.quote_from_curve <= buy.quote_to_curve);
        assert_eq!(sell.reserves_after.real_token, reserves.real_token);
        assert!(sell.reserves_after.invariant() >= reserves.invariant());
    }

    #[test]
    fn sell_cannot_drain_more_than_buyers_deposited() {
        // Nothing has been bought, so nothing can be sold back.
        let reserves = PUMP.initial_reserves();
        assert_eq!(
            quote_sell(&reserves, &PRD_FEE, 1_000_000_000_000),
            Err(MathError::InsufficientReserves)
        );
    }

    #[test]
    fn dust_and_zero_are_rejected() {
        let reserves = PUMP.initial_reserves();
        assert_eq!(
            quote_buy(&reserves, &PRD_FEE, 0),
            Err(MathError::ZeroAmount)
        );
        // One unit cannot cover a curve amount plus its fee.
        assert_eq!(quote_buy(&reserves, &PRD_FEE, 1), Err(MathError::DustTrade));
        assert_eq!(
            quote_sell(&reserves, &PRD_FEE, 0),
            Err(MathError::ZeroAmount)
        );

        let after = quote_buy(&reserves, &PRD_FEE, 1_000_000_000)
            .unwrap()
            .reserves_after;
        // A single base unit of the token is worth less than one lamport.
        assert_eq!(quote_sell(&after, &PRD_FEE, 1), Err(MathError::DustTrade));
    }

    #[test]
    fn inverse_quote_buys_at_least_the_requested_tokens() {
        let reserves = PUMP.initial_reserves();
        let want = 3_965_500_000_000; // 0.5% of curve supply
        let budget = quote_in_for_tokens_out(&reserves, &PRD_FEE, want).unwrap();
        let buy = quote_buy(&reserves, &PRD_FEE, budget).unwrap();
        assert!(buy.tokens_out >= want);
        assert_eq!(
            quote_in_for_tokens_out(&reserves, &PRD_FEE, PUMP.curve_supply + 1),
            Err(MathError::InsufficientReserves)
        );
    }

    #[test]
    fn from_target_reproduces_the_reference_shape() {
        let derived =
            CurveParams::from_target(PUMP.total_supply, PUMP.curve_supply, 85_000_000_000).unwrap();
        // Within a fraction of a percent of the hand-picked published constants.
        let token_gap = derived
            .virtual_token_reserves
            .abs_diff(PUMP.virtual_token_reserves);
        assert!(token_gap < PUMP.virtual_token_reserves / 10_000);
        let quote_gap = derived
            .virtual_quote_reserves
            .abs_diff(PUMP.virtual_quote_reserves);
        assert!(quote_gap < PUMP.virtual_quote_reserves / 1_000);
        // Virtual quote is a whole number of units, so the realised target can
        // land a few units off the requested one.
        let target = derived.graduation_quote().unwrap();
        assert!(target.abs_diff(85_000_000_000) <= 3);
    }

    #[test]
    fn from_target_needs_the_curve_to_sell_a_majority() {
        assert_eq!(
            CurveParams::from_target(1_000, 500, 1_000_000),
            Err(MathError::InvalidParams)
        );
        assert_eq!(
            CurveParams::from_target(1_000, 1_001, 1_000_000),
            Err(MathError::InvalidParams)
        );
    }

    #[test]
    fn validate_rejects_broken_shapes() {
        let ok = PUMP;
        for broken in [
            CurveParams {
                curve_supply: 0,
                ..ok
            },
            CurveParams {
                virtual_quote_reserves: 0,
                ..ok
            },
            CurveParams {
                curve_supply: ok.total_supply,
                ..ok
            },
            CurveParams {
                virtual_token_reserves: ok.curve_supply,
                ..ok
            },
        ] {
            assert_eq!(broken.validate(), Err(MathError::InvalidParams));
        }
    }

    #[test]
    fn validate_rejects_a_pool_that_would_open_off_the_curve_price() {
        // Same curve, but hold back twice as many tokens for the pool: it would
        // open at roughly half the curve's closing price.
        let cheap_pool = CurveParams {
            total_supply: PUMP.curve_supply + 2 * 206_900_000_000_000,
            ..PUMP
        };
        assert_eq!(cheap_pool.validate(), Err(MathError::InvalidParams));
    }

    #[test]
    fn fee_rates_above_the_ceiling_never_price_a_trade() {
        let greedy = FeeRates {
            platform_bps: 5_000,
            creator_bps: 5_000,
        };
        let reserves = PUMP.initial_reserves();
        assert_eq!(
            quote_buy(&reserves, &greedy, 1_000_000),
            Err(MathError::InvalidParams)
        );
        assert_eq!(
            quote_sell(&reserves, &greedy, 1_000_000),
            Err(MathError::InvalidParams)
        );
    }
}
