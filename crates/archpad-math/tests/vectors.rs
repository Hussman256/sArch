//! Golden vectors shared with the TypeScript SDK.
//!
//! `tests/vectors/curve.json` is generated here and checked in. This test
//! fails if the file no longer matches what the Rust code produces; the SDK's
//! test suite replays the same file against its own implementation. Together
//! they pin the two implementations to identical results.
//!
//! Regenerate after an intentional change with:
//!
//! ```text
//! UPDATE_VECTORS=1 cargo test -p archpad-math --test vectors
//! ```

use archpad_math::{
    pool_quote_buy, pool_quote_sell, quote_buy, quote_in_for_tokens_out, quote_sell, split_fee,
    CurveParams, FeeRates, MathError, PoolFeeRates, PoolReserves, Reserves,
};
use std::fmt::Write as _;

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/curve.json");

/// SplitMix64: tiny, deterministic, and good enough to spread test inputs.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `1..=max`.
    fn upto(&mut self, max: u64) -> u64 {
        1 + self.next() % max.max(1)
    }
}

fn shapes() -> Vec<CurveParams> {
    vec![
        // Reference shape with public numbers (pump.fun, lamports).
        CurveParams {
            total_supply: 1_000_000_000_000_000,
            curve_supply: 793_100_000_000_000,
            virtual_token_reserves: 1_073_000_000_000_000,
            virtual_quote_reserves: 30_000_000_000,
        },
        // Satoshi-denominated: raises 0.2 BTC.
        CurveParams::from_target(1_000_000_000_000_000, 793_100_000_000_000, 20_000_000).unwrap(),
        // 6-decimal dollar stablecoin: raises $20,000.
        CurveParams::from_target(1_000_000_000_000_000, 793_100_000_000_000, 20_000_000_000)
            .unwrap(),
        // 9-decimal token against a 9-decimal quote, 80% on the curve.
        CurveParams::from_target(
            1_000_000_000_000_000_000,
            800_000_000_000_000_000,
            500_000_000_000,
        )
        .unwrap(),
    ]
}

fn fee_rates() -> Vec<FeeRates> {
    vec![
        FeeRates {
            platform_bps: 100,
            creator_bps: 125,
        },
        FeeRates {
            platform_bps: 0,
            creator_bps: 0,
        },
        FeeRates {
            platform_bps: 30,
            creator_bps: 0,
        },
        FeeRates {
            platform_bps: 500,
            creator_bps: 500,
        },
        // Above the ceiling: every function must refuse it.
        FeeRates {
            platform_bps: 600,
            creator_bps: 500,
        },
    ]
}

fn err_name(err: MathError) -> &'static str {
    match err {
        MathError::Overflow => "Overflow",
        MathError::ZeroAmount => "ZeroAmount",
        MathError::DustTrade => "DustTrade",
        MathError::CurveComplete => "CurveComplete",
        MathError::InsufficientReserves => "InsufficientReserves",
        MathError::InvalidParams => "InvalidParams",
    }
}

fn reserves_json(r: &Reserves) -> String {
    format!(
        r#"{{"virtualQuote":"{}","virtualToken":"{}","realQuote":"{}","realToken":"{}"}}"#,
        r.virtual_quote, r.virtual_token, r.real_quote, r.real_token
    )
}

fn rates_json(r: &FeeRates) -> String {
    format!(
        r#"{{"platformBps":{},"creatorBps":{}}}"#,
        r.platform_bps, r.creator_bps
    )
}

fn buy_case(reserves: &Reserves, rates: &FeeRates, max_quote_in: u64) -> String {
    let result = match quote_buy(reserves, rates, max_quote_in) {
        Ok(q) => format!(
            r#"{{"ok":{{"quoteToCurve":"{}","platformFee":"{}","creatorFee":"{}","quoteCharged":"{}","tokensOut":"{}","completesCurve":{},"reservesAfter":{}}}}}"#,
            q.quote_to_curve,
            q.fees.platform,
            q.fees.creator,
            q.quote_charged,
            q.tokens_out,
            q.completes_curve,
            reserves_json(&q.reserves_after)
        ),
        Err(e) => format!(r#"{{"err":"{}"}}"#, err_name(e)),
    };
    format!(
        r#"{{"reserves":{},"rates":{},"maxQuoteIn":"{}","result":{}}}"#,
        reserves_json(reserves),
        rates_json(rates),
        max_quote_in,
        result
    )
}

fn sell_case(reserves: &Reserves, rates: &FeeRates, tokens_in: u64) -> String {
    let result = match quote_sell(reserves, rates, tokens_in) {
        Ok(q) => format!(
            r#"{{"ok":{{"quoteFromCurve":"{}","platformFee":"{}","creatorFee":"{}","quoteOut":"{}","reservesAfter":{}}}}}"#,
            q.quote_from_curve,
            q.fees.platform,
            q.fees.creator,
            q.quote_out,
            reserves_json(&q.reserves_after)
        ),
        Err(e) => format!(r#"{{"err":"{}"}}"#, err_name(e)),
    };
    format!(
        r#"{{"reserves":{},"rates":{},"tokensIn":"{}","result":{}}}"#,
        reserves_json(reserves),
        rates_json(rates),
        tokens_in,
        result
    )
}

fn inverse_case(reserves: &Reserves, rates: &FeeRates, tokens_out: u64) -> String {
    let result = match quote_in_for_tokens_out(reserves, rates, tokens_out) {
        Ok(v) => format!(r#"{{"ok":"{}"}}"#, v),
        Err(e) => format!(r#"{{"err":"{}"}}"#, err_name(e)),
    };
    format!(
        r#"{{"reserves":{},"rates":{},"tokensOut":"{}","result":{}}}"#,
        reserves_json(reserves),
        rates_json(rates),
        tokens_out,
        result
    )
}

fn fee_case(amount: u64, rates: &FeeRates) -> String {
    let result = match split_fee(amount, rates) {
        Ok(f) => format!(
            r#"{{"ok":{{"platform":"{}","creator":"{}"}}}}"#,
            f.platform, f.creator
        ),
        Err(e) => format!(r#"{{"err":"{}"}}"#, err_name(e)),
    };
    format!(
        r#"{{"amount":"{}","rates":{},"result":{}}}"#,
        amount,
        rates_json(rates),
        result
    )
}

fn params_case(total_supply: u64, curve_supply: u64, graduation_quote: u64) -> String {
    let result = match CurveParams::from_target(total_supply, curve_supply, graduation_quote) {
        Ok(p) => format!(
            r#"{{"ok":{{"virtualTokenReserves":"{}","virtualQuoteReserves":"{}","poolSupply":"{}","graduationQuote":"{}"}}}}"#,
            p.virtual_token_reserves,
            p.virtual_quote_reserves,
            p.pool_supply().unwrap(),
            p.graduation_quote().unwrap()
        ),
        Err(e) => format!(r#"{{"err":"{}"}}"#, err_name(e)),
    };
    format!(
        r#"{{"totalSupply":"{}","curveSupply":"{}","targetQuote":"{}","result":{}}}"#,
        total_supply, curve_supply, graduation_quote, result
    )
}

fn pool_fee_rates() -> Vec<PoolFeeRates> {
    vec![
        PoolFeeRates {
            lp_bps: 20,
            platform_bps: 5,
            creator_bps: 5,
        },
        PoolFeeRates {
            lp_bps: 0,
            platform_bps: 0,
            creator_bps: 0,
        },
        PoolFeeRates {
            lp_bps: 100,
            platform_bps: 100,
            creator_bps: 100,
        },
        PoolFeeRates {
            lp_bps: 7,
            platform_bps: 3,
            creator_bps: 1,
        },
        // Above the ceiling: every function must refuse it.
        PoolFeeRates {
            lp_bps: 200,
            platform_bps: 100,
            creator_bps: 1,
        },
    ]
}

fn pool_reserves_json(r: &PoolReserves) -> String {
    format!(r#"{{"quote":"{}","token":"{}"}}"#, r.quote, r.token)
}

fn pool_rates_json(r: &PoolFeeRates) -> String {
    format!(
        r#"{{"lpBps":{},"platformBps":{},"creatorBps":{}}}"#,
        r.lp_bps, r.platform_bps, r.creator_bps
    )
}

fn pool_buy_case(reserves: &PoolReserves, rates: &PoolFeeRates, max_quote_in: u64) -> String {
    let result = match pool_quote_buy(reserves, rates, max_quote_in) {
        Ok(q) => format!(
            r#"{{"ok":{{"quoteToPool":"{}","lpFee":"{}","platformFee":"{}","creatorFee":"{}","quoteCharged":"{}","tokensOut":"{}","reservesAfter":{}}}}}"#,
            q.quote_to_pool,
            q.fees.lp,
            q.fees.paid_out.platform,
            q.fees.paid_out.creator,
            q.quote_charged,
            q.tokens_out,
            pool_reserves_json(&q.reserves_after)
        ),
        Err(e) => format!(r#"{{"err":"{}"}}"#, err_name(e)),
    };
    format!(
        r#"{{"reserves":{},"rates":{},"maxQuoteIn":"{}","result":{}}}"#,
        pool_reserves_json(reserves),
        pool_rates_json(rates),
        max_quote_in,
        result
    )
}

fn pool_sell_case(reserves: &PoolReserves, rates: &PoolFeeRates, tokens_in: u64) -> String {
    let result = match pool_quote_sell(reserves, rates, tokens_in) {
        Ok(q) => format!(
            r#"{{"ok":{{"quoteFromPool":"{}","lpFee":"{}","platformFee":"{}","creatorFee":"{}","quoteOut":"{}","reservesAfter":{}}}}}"#,
            q.quote_from_pool,
            q.fees.lp,
            q.fees.paid_out.platform,
            q.fees.paid_out.creator,
            q.quote_out,
            pool_reserves_json(&q.reserves_after)
        ),
        Err(e) => format!(r#"{{"err":"{}"}}"#, err_name(e)),
    };
    format!(
        r#"{{"reserves":{},"rates":{},"tokensIn":"{}","result":{}}}"#,
        pool_reserves_json(reserves),
        pool_rates_json(rates),
        tokens_in,
        result
    )
}

fn section(out: &mut String, name: &str, cases: &[String], last: bool) {
    writeln!(out, "  \"{name}\": [").unwrap();
    for (i, case) in cases.iter().enumerate() {
        let comma = if i + 1 == cases.len() { "" } else { "," };
        writeln!(out, "    {case}{comma}").unwrap();
    }
    writeln!(out, "  ]{}", if last { "" } else { "," }).unwrap();
}

fn generate() -> String {
    let mut rng = Rng(0xA2C4_9AD0_0BEE_F5ED);
    let (mut buys, mut sells, mut inverses, mut fees, mut params) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());

    for shape in shapes() {
        let target = shape.graduation_quote().unwrap();
        for rates in fee_rates() {
            let fresh = shape.initial_reserves();

            // Fixed edges on a fresh curve.
            for amount in [
                0,
                1,
                2,
                44,
                45,
                1_000,
                target,
                target + target / 10,
                u64::MAX / 4,
            ] {
                buys.push(buy_case(&fresh, &rates, amount));
            }
            for amount in [0, 1, shape.curve_supply / 200, shape.curve_supply] {
                sells.push(sell_case(&fresh, &rates, amount));
                inverses.push(inverse_case(&fresh, &rates, amount));
            }
            inverses.push(inverse_case(&fresh, &rates, shape.curve_supply + 1));

            // Walk the curve with random trades, recording a case at each stop.
            let mut reserves = fresh;
            for _ in 0..12 {
                if reserves.is_complete() {
                    break;
                }
                let spend = rng.upto(target / 6);
                buys.push(buy_case(&reserves, &rates, spend));

                let circulating = shape.curve_supply - reserves.real_token;
                let dump = rng.upto(circulating.max(1));
                sells.push(sell_case(&reserves, &rates, dump));
                sells.push(sell_case(&reserves, &rates, circulating));
                sells.push(sell_case(&reserves, &rates, circulating.saturating_add(1)));

                let want = rng.upto(reserves.real_token);
                inverses.push(inverse_case(&reserves, &rates, want));

                // The boundary: exactly enough to finish, and one unit short.
                if let Ok(exact) = quote_in_for_tokens_out(&reserves, &rates, reserves.real_token) {
                    buys.push(buy_case(&reserves, &rates, exact));
                    buys.push(buy_case(&reserves, &rates, exact - 1));
                    buys.push(buy_case(
                        &reserves,
                        &rates,
                        exact.saturating_add(rng.upto(target)),
                    ));
                }

                // Advance: mostly buys, sometimes a partial sell.
                if rng.next() % 4 == 0 && circulating > 0 {
                    if let Ok(q) = quote_sell(&reserves, &rates, rng.upto(circulating)) {
                        reserves = q.reserves_after;
                    }
                } else if let Ok(q) = quote_buy(&reserves, &rates, spend) {
                    reserves = q.reserves_after;
                }
            }

            // A completed curve.
            if let Ok(done) = quote_buy(&fresh, &rates, u64::MAX / 4) {
                buys.push(buy_case(&done.reserves_after, &rates, 1_000_000));
                sells.push(sell_case(&done.reserves_after, &rates, 1_000_000));
                inverses.push(inverse_case(&done.reserves_after, &rates, 1));
            }

            for amount in [0, 1, 44, 45, 99, 100, 4_444, 10_000, 123_456_789, u64::MAX] {
                fees.push(fee_case(amount, &rates));
            }
            for _ in 0..6 {
                fees.push(fee_case(rng.next() >> (rng.next() % 48), &rates));
            }
        }
    }

    for (total, curve, target) in [
        (
            1_000_000_000_000_000u64,
            793_100_000_000_000u64,
            85_000_000_000u64,
        ),
        (1_000_000_000_000_000, 793_100_000_000_000, 20_000_000),
        (1_000_000_000_000_000, 793_100_000_000_000, 20_000_000_000),
        (
            1_000_000_000_000_000_000,
            800_000_000_000_000_000,
            500_000_000_000,
        ),
        (1_000_000_000_000_000, 500_000_000_000_000, 20_000_000),
        (1_000_000_000_000_000, 500_000_000_000_001, 20_000_000),
        (1_000_000_000_000_000, 1_000_000_000_000_001, 20_000_000),
        (1_000_000_000_000_000, 793_100_000_000_000, 0),
        (1_000_000_000_000_000, 793_100_000_000_000, 1),
        (1_000, 600, 1_000_000),
    ] {
        params.push(params_case(total, curve, target));
    }
    for _ in 0..12 {
        let total = rng.upto(1_000_000_000_000_000_000);
        let curve = (u128::from(total) * u128::from(5_001 + rng.next() % 4_998) / 10_000) as u64;
        params.push(params_case(total, curve, rng.upto(1_000_000_000_000_000)));
    }

    // Pools as they stand right after each shape graduates, then walked with
    // random swaps in both directions.
    let (mut pool_buys, mut pool_sells) = (Vec::new(), Vec::new());
    for shape in shapes() {
        let start = PoolReserves {
            quote: shape.graduation_quote().unwrap(),
            token: shape.pool_supply().unwrap(),
        };
        for rates in pool_fee_rates() {
            for amount in [0, 1, 2, 1_000, start.quote, u64::MAX / 4] {
                pool_buys.push(pool_buy_case(&start, &rates, amount));
            }
            for amount in [0, 1, start.token / 1_000, start.token, u64::MAX / 4] {
                pool_sells.push(pool_sell_case(&start, &rates, amount));
            }
            let mut reserves = start;
            for _ in 0..10 {
                let spend = rng.upto(reserves.quote / 3);
                let dump = rng.upto(reserves.token / 3);
                pool_buys.push(pool_buy_case(&reserves, &rates, spend));
                pool_sells.push(pool_sell_case(&reserves, &rates, dump));
                if rng.next() % 2 == 0 {
                    if let Ok(q) = pool_quote_buy(&reserves, &rates, spend) {
                        reserves = q.reserves_after;
                    }
                } else if let Ok(q) = pool_quote_sell(&reserves, &rates, dump) {
                    reserves = q.reserves_after;
                }
            }
        }
        let empty = PoolReserves { quote: 0, token: 0 };
        pool_buys.push(pool_buy_case(&empty, &pool_fee_rates()[0], 1_000));
        pool_sells.push(pool_sell_case(&empty, &pool_fee_rates()[0], 1_000));
    }

    let mut out = String::from("{\n");
    section(&mut out, "buy", &buys, false);
    section(&mut out, "sell", &sells, false);
    section(&mut out, "inverse", &inverses, false);
    section(&mut out, "fee", &fees, false);
    section(&mut out, "params", &params, false);
    section(&mut out, "poolBuy", &pool_buys, false);
    section(&mut out, "poolSell", &pool_sells, true);
    out.push_str("}\n");
    out
}

#[test]
fn vectors_are_current() {
    let generated = generate();
    if std::env::var_os("UPDATE_VECTORS").is_some() {
        let path = std::path::Path::new(PATH);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, &generated).unwrap();
    }
    let on_disk = std::fs::read_to_string(PATH)
        .expect("vector file missing: run with UPDATE_VECTORS=1 to create it")
        .replace("\r\n", "\n");
    assert!(
        on_disk == generated,
        "tests/vectors/curve.json is out of date: rerun with UPDATE_VECTORS=1 and review the diff"
    );
}

#[test]
fn vectors_cover_successes_and_every_refusal() {
    let generated = generate();
    for needle in [
        r#""ok":"#,
        r#""completesCurve":true"#,
        r#""completesCurve":false"#,
        r#""err":"ZeroAmount""#,
        r#""err":"DustTrade""#,
        r#""err":"CurveComplete""#,
        r#""err":"InsufficientReserves""#,
        r#""err":"InvalidParams""#,
    ] {
        assert!(generated.contains(needle), "no vector exercises {needle}");
    }
}
