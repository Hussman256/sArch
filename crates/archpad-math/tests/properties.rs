//! Property tests: the guarantees the programs rely on, checked across random
//! curve shapes, fee rates and trade sequences.

use archpad_math::{
    pool_quote_buy, pool_quote_sell, quote_buy, quote_in_for_tokens_out, quote_sell, split_fee,
    split_pool_fee, CurveParams, FeeRates, MathError, PoolFeeRates, PoolReserves, Reserves,
    BPS_DENOMINATOR, MAX_POOL_FEE_BPS, MAX_TOTAL_FEE_BPS,
};
use proptest::prelude::*;

/// Curve shapes spanning the cases we expect to configure: 6 to 9 token
/// decimals, quote assets from satoshi-scale to 9-decimal-scale targets, and
/// curves selling 55% to 95% of supply.
fn params() -> impl Strategy<Value = CurveParams> {
    (
        1_000_000_000_000u64..=1_000_000_000_000_000_000,
        5_500u64..=9_500,
        1_000_000u64..=1_000_000_000_000_000,
    )
        .prop_filter_map("shape must validate", |(total, curve_bps, target)| {
            let curve = (u128::from(total) * u128::from(curve_bps) / 10_000) as u64;
            CurveParams::from_target(total, curve, target).ok()
        })
}

fn rates() -> impl Strategy<Value = FeeRates> {
    (0u16..=MAX_TOTAL_FEE_BPS).prop_flat_map(|total| {
        (0u16..=total).prop_map(move |platform| FeeRates {
            platform_bps: platform,
            creator_bps: total - platform,
        })
    })
}

/// One step of a trade sequence. Fractions are in parts per million so they
/// scale to whatever shape was generated.
#[derive(Clone, Debug)]
enum Step {
    /// Spend this fraction of the graduation target.
    Buy(u32),
    /// Sell this fraction of the tokens currently in circulation.
    Sell(u32),
}

fn steps() -> impl Strategy<Value = Vec<Step>> {
    prop::collection::vec(
        prop_oneof![
            (1u32..=400_000).prop_map(Step::Buy),
            (1u32..=1_000_000).prop_map(Step::Sell),
        ],
        1..40,
    )
}

fn ppm(amount: u64, parts: u32) -> u64 {
    (u128::from(amount) * u128::from(parts) / 1_000_000) as u64
}

/// The relations that must hold between a curve's reserves at all times.
fn assert_consistent(params: &CurveParams, reserves: &Reserves) {
    // Virtual and real reserves move in lockstep.
    assert_eq!(
        reserves.virtual_quote - reserves.real_quote,
        params.virtual_quote_reserves
    );
    assert_eq!(
        reserves.virtual_token - reserves.real_token,
        params.virtual_token_reserves - params.curve_supply
    );
    assert!(reserves.real_token <= params.curve_supply);
    assert!(reserves.invariant() >= params.initial_reserves().invariant());
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Whatever traders do, the curve can always buy back every token in
    /// circulation out of the quote it actually holds.
    #[test]
    fn curve_stays_solvent(params in params(), rates in rates(), steps in steps()) {
        let target = params.graduation_quote().unwrap();
        let mut reserves = params.initial_reserves();

        for step in steps {
            if reserves.is_complete() {
                break;
            }
            let before = reserves;
            match step {
                Step::Buy(parts) => {
                    let Ok(buy) = quote_buy(&reserves, &rates, ppm(target, parts).max(1)) else {
                        continue;
                    };
                    reserves = buy.reserves_after;
                }
                Step::Sell(parts) => {
                    let circulating = params.curve_supply - reserves.real_token;
                    let Ok(sell) = quote_sell(&reserves, &rates, ppm(circulating, parts)) else {
                        continue;
                    };
                    reserves = sell.reserves_after;
                }
            }
            assert_consistent(&params, &reserves);
            prop_assert!(reserves.invariant() >= before.invariant());

            // Everyone exits at once: the payout is covered.
            let circulating = params.curve_supply - reserves.real_token;
            if circulating > 0 && !reserves.is_complete() {
                let owed = (u128::from(reserves.virtual_quote) * u128::from(circulating)
                    / (u128::from(reserves.virtual_token) + u128::from(circulating))) as u64;
                prop_assert!(owed <= reserves.real_quote);
            }
        }
    }

    /// A buy never takes more than the stated maximum, charges exactly the
    /// configured fee on what enters the curve, and never sells tokens the
    /// curve does not have.
    #[test]
    fn buy_respects_budget_fee_and_supply(
        params in params(),
        rates in rates(),
        warmup in 0u32..=900_000,
        parts in 1u32..=2_000_000,
    ) {
        let target = params.graduation_quote().unwrap();
        let mut reserves = params.initial_reserves();
        if let Ok(buy) = quote_buy(&reserves, &rates, ppm(target, warmup).max(1)) {
            reserves = buy.reserves_after;
        }
        prop_assume!(!reserves.is_complete());

        let budget = ppm(target, parts).max(1);
        if let Ok(buy) = quote_buy(&reserves, &rates, budget) {
            prop_assert!(buy.quote_charged <= budget);
            prop_assert_eq!(buy.fees, split_fee(buy.quote_to_curve, &rates).unwrap());
            prop_assert_eq!(buy.quote_charged, buy.quote_to_curve + buy.fees.total().unwrap());
            prop_assert!(buy.tokens_out > 0);
            prop_assert!(buy.tokens_out <= reserves.real_token);
            prop_assert_eq!(buy.completes_curve, buy.reserves_after.real_token == 0);
            prop_assert_eq!(buy.reserves_after.real_quote, reserves.real_quote + buy.quote_to_curve);
            assert_consistent(&params, &buy.reserves_after);
        }
    }

    /// The fee is the configured rate, rounded up by less than one unit, and
    /// its two shares add up to it.
    #[test]
    fn fee_is_the_configured_rate(amount in any::<u64>(), rates in rates()) {
        let fees = split_fee(amount, &rates).unwrap();
        let total = u128::from(fees.total().unwrap());
        let exact = u128::from(amount) * u128::from(rates.total_bps());
        let denom = u128::from(BPS_DENOMINATOR);
        prop_assert!(total * denom >= exact);
        prop_assert!(total * denom < exact + denom);
        // The platform never receives more than its exact share of the total.
        prop_assert!(
            u128::from(fees.platform) * u128::from(rates.total_bps().max(1))
                <= total * u128::from(rates.platform_bps)
        );
    }

    /// Buying then immediately selling never returns more than was paid, and
    /// the curve never hands back more quote than it took in.
    #[test]
    fn round_trip_never_profits(
        params in params(),
        rates in rates(),
        warmup in 0u32..=900_000,
        parts in 1u32..=1_000_000,
    ) {
        let target = params.graduation_quote().unwrap();
        let mut reserves = params.initial_reserves();
        if let Ok(buy) = quote_buy(&reserves, &rates, ppm(target, warmup).max(1)) {
            reserves = buy.reserves_after;
        }
        prop_assume!(!reserves.is_complete());

        let Ok(buy) = quote_buy(&reserves, &rates, ppm(target, parts).max(1)) else {
            return Ok(());
        };
        prop_assume!(!buy.completes_curve);
        let Ok(sell) = quote_sell(&buy.reserves_after, &rates, buy.tokens_out) else {
            return Ok(());
        };
        prop_assert!(sell.quote_from_curve <= buy.quote_to_curve);
        prop_assert!(sell.quote_out <= buy.quote_charged);
        prop_assert_eq!(sell.reserves_after.real_token, reserves.real_token);
        prop_assert!(sell.reserves_after.real_quote >= reserves.real_quote);
    }

    /// Splitting an order into two cannot buy more tokens than placing it whole,
    /// so there is no rounding edge to farm with many small trades.
    #[test]
    fn splitting_a_buy_never_helps(
        params in params(),
        rates in rates(),
        first in 1u32..=400_000,
        second in 1u32..=400_000,
    ) {
        let target = params.graduation_quote().unwrap();
        let reserves = params.initial_reserves();
        let (a, b) = (ppm(target, first).max(1), ppm(target, second).max(1));

        let Ok(whole) = quote_buy(&reserves, &rates, a + b) else { return Ok(()); };
        let Ok(part_one) = quote_buy(&reserves, &rates, a) else { return Ok(()); };
        prop_assume!(!part_one.completes_curve);
        let Ok(part_two) = quote_buy(&part_one.reserves_after, &rates, b) else { return Ok(()); };

        prop_assert!(part_one.tokens_out + part_two.tokens_out <= whole.tokens_out);
    }

    /// Likewise for sells: two partial sells never pay more than one.
    #[test]
    fn splitting_a_sell_never_helps(
        params in params(),
        rates in rates(),
        bought in 10_000u32..=900_000,
        cut in 1u32..=999_999,
    ) {
        let target = params.graduation_quote().unwrap();
        let Ok(buy) = quote_buy(&params.initial_reserves(), &rates, ppm(target, bought).max(1)) else {
            return Ok(());
        };
        prop_assume!(!buy.completes_curve);
        let reserves = buy.reserves_after;
        let first = ppm(buy.tokens_out, cut);
        let second = buy.tokens_out - first;
        prop_assume!(first > 0 && second > 0);

        let Ok(whole) = quote_sell(&reserves, &rates, buy.tokens_out) else { return Ok(()); };
        let Ok(part_one) = quote_sell(&reserves, &rates, first) else { return Ok(()); };
        let Ok(part_two) = quote_sell(&part_one.reserves_after, &rates, second) else { return Ok(()); };

        prop_assert!(part_one.quote_out + part_two.quote_out <= whole.quote_out);
    }

    /// A bigger budget never buys fewer tokens.
    #[test]
    fn buy_is_monotonic(
        params in params(),
        rates in rates(),
        small in 1u32..=1_500_000,
        extra in 0u32..=1_500_000,
    ) {
        let target = params.graduation_quote().unwrap();
        let reserves = params.initial_reserves();
        let low = ppm(target, small).max(1);
        let high = low + ppm(target, extra);
        let (Ok(low), Ok(high)) = (
            quote_buy(&reserves, &rates, low),
            quote_buy(&reserves, &rates, high),
        ) else {
            return Ok(());
        };
        prop_assert!(low.tokens_out <= high.tokens_out);
        prop_assert!(low.quote_charged <= high.quote_charged);
    }

    /// The inverse quote is always enough to buy the tokens it was asked for,
    /// which is what the launch transaction relies on for the creator's buy.
    #[test]
    fn inverse_quote_is_sufficient(
        params in params(),
        rates in rates(),
        warmup in 0u32..=900_000,
        parts in 1u32..=1_000_000,
    ) {
        let target = params.graduation_quote().unwrap();
        let mut reserves = params.initial_reserves();
        if let Ok(buy) = quote_buy(&reserves, &rates, ppm(target, warmup).max(1)) {
            reserves = buy.reserves_after;
        }
        prop_assume!(!reserves.is_complete());

        let want = ppm(reserves.real_token, parts).max(1);
        let budget = quote_in_for_tokens_out(&reserves, &rates, want).unwrap();
        let buy = quote_buy(&reserves, &rates, budget).unwrap();
        prop_assert!(buy.tokens_out >= want);
        prop_assert!(buy.quote_charged <= budget);
    }

    /// Any budget large enough finishes the curve exactly: no tokens left, the
    /// buyer charged only for the tokens that existed.
    #[test]
    fn final_buy_lands_on_the_boundary(
        params in params(),
        rates in rates(),
        warmup in 0u32..=990_000,
        excess in 0u64..=1_000_000_000_000,
    ) {
        let target = params.graduation_quote().unwrap();
        let mut reserves = params.initial_reserves();
        if let Ok(buy) = quote_buy(&reserves, &rates, ppm(target, warmup).max(1)) {
            reserves = buy.reserves_after;
        }
        prop_assume!(!reserves.is_complete());

        let exact = quote_in_for_tokens_out(&reserves, &rates, reserves.real_token).unwrap();
        let buy = quote_buy(&reserves, &rates, exact.saturating_add(excess)).unwrap();
        prop_assert!(buy.completes_curve);
        prop_assert_eq!(buy.tokens_out, reserves.real_token);
        prop_assert_eq!(buy.quote_charged, exact);
        prop_assert!(buy.reserves_after.is_complete());
        assert_consistent(&params, &buy.reserves_after);

        // The pool opens within tolerance of the price the curve closed at.
        let pool_supply = params.pool_supply().unwrap();
        let pool_side = u128::from(buy.reserves_after.real_quote)
            * u128::from(buy.reserves_after.virtual_token);
        let curve_side = u128::from(buy.reserves_after.virtual_quote) * u128::from(pool_supply);
        prop_assert!(pool_side.abs_diff(curve_side) <= curve_side / 50);

        prop_assert_eq!(
            quote_buy(&buy.reserves_after, &rates, 1_000_000),
            Err(MathError::CurveComplete)
        );
    }
}

fn pool_rates() -> impl Strategy<Value = PoolFeeRates> {
    (0u16..=MAX_POOL_FEE_BPS).prop_flat_map(|total| {
        (0u16..=total).prop_flat_map(move |lp| {
            (0u16..=total - lp).prop_map(move |platform| PoolFeeRates {
                lp_bps: lp,
                platform_bps: platform,
                creator_bps: total - lp - platform,
            })
        })
    })
}

fn pool_reserves() -> impl Strategy<Value = PoolReserves> {
    (
        1_000u64..=1_000_000_000_000_000,
        1_000u64..=1_000_000_000_000_000_000,
    )
        .prop_map(|(quote, token)| PoolReserves { quote, token })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// The pool can never be emptied on either side, never pays out more than
    /// it holds, and its invariant never falls, whatever sequence of swaps runs.
    #[test]
    fn pool_cannot_be_drained(
        start in pool_reserves(),
        rates in pool_rates(),
        swaps in prop::collection::vec((any::<bool>(), 1u32..=2_000_000), 1..40),
    ) {
        let mut reserves = start;
        for (is_buy, parts) in swaps {
            let before = reserves;
            if is_buy {
                let Ok(buy) = pool_quote_buy(&reserves, &rates, ppm(reserves.quote, parts).max(1)) else {
                    continue;
                };
                prop_assert!(buy.tokens_out < before.token);
                reserves = buy.reserves_after;
            } else {
                let Ok(sell) = pool_quote_sell(&reserves, &rates, ppm(reserves.token, parts).max(1)) else {
                    continue;
                };
                prop_assert!(sell.quote_from_pool < before.quote);
                reserves = sell.reserves_after;
            }
            prop_assert!(reserves.quote >= 1 && reserves.token >= 1);
            prop_assert!(reserves.invariant() >= before.invariant());
        }
        prop_assert!(reserves.invariant() >= start.invariant());
    }

    /// Every unit of quote a pool swap touches is accounted for: what the
    /// trader pays or receives, what the pool keeps and what is paid out as
    /// fees add up exactly.
    #[test]
    fn pool_swap_conserves_quote(
        reserves in pool_reserves(),
        rates in pool_rates(),
        parts in 1u32..=2_000_000,
    ) {
        let budget = ppm(reserves.quote, parts).max(1);
        if let Ok(buy) = pool_quote_buy(&reserves, &rates, budget) {
            prop_assert!(buy.quote_charged <= budget);
            prop_assert_eq!(buy.fees, split_pool_fee(buy.quote_to_pool, &rates).unwrap());
            let paid_out = buy.fees.paid_out.total().unwrap();
            prop_assert_eq!(reserves.quote + buy.quote_charged, buy.reserves_after.quote + paid_out);
            prop_assert_eq!(reserves.token, buy.reserves_after.token + buy.tokens_out);
        }
        let tokens = ppm(reserves.token, parts).max(1);
        if let Ok(sell) = pool_quote_sell(&reserves, &rates, tokens) {
            prop_assert_eq!(sell.fees, split_pool_fee(sell.quote_from_pool, &rates).unwrap());
            let paid_out = sell.fees.paid_out.total().unwrap();
            prop_assert_eq!(reserves.quote, sell.reserves_after.quote + sell.quote_out + paid_out);
            prop_assert_eq!(reserves.token + tokens, sell.reserves_after.token);
        }
    }

    /// Buying then immediately selling in the pool never returns more than was paid.
    #[test]
    fn pool_round_trip_never_profits(
        reserves in pool_reserves(),
        rates in pool_rates(),
        parts in 1u32..=1_000_000,
    ) {
        let Ok(buy) = pool_quote_buy(&reserves, &rates, ppm(reserves.quote, parts).max(1)) else {
            return Ok(());
        };
        let Ok(sell) = pool_quote_sell(&buy.reserves_after, &rates, buy.tokens_out) else {
            return Ok(());
        };
        prop_assert!(sell.quote_out <= buy.quote_charged);
        prop_assert!(sell.quote_from_pool <= buy.quote_to_pool + buy.fees.lp);
    }

    /// The pool fee is the configured rate, rounded up by less than one unit,
    /// and its three shares add up to it.
    #[test]
    fn pool_fee_is_the_configured_rate(amount in any::<u64>(), rates in pool_rates()) {
        let fees = split_pool_fee(amount, &rates).unwrap();
        let total = u128::from(fees.total().unwrap());
        let exact = u128::from(amount) * u128::from(rates.total_bps());
        let denom = u128::from(BPS_DENOMINATOR);
        prop_assert!(total * denom >= exact);
        prop_assert!(total * denom < exact + denom);
        prop_assert_eq!(
            fees.lp + fees.paid_out.platform + fees.paid_out.creator,
            fees.total().unwrap()
        );
    }
}
