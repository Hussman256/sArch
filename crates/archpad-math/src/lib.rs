//! Integer math for the launchpad: bonding-curve trades, trade fees, the
//! limits derived from curve supply, and swaps in the graduated pool.
//!
//! Everything here is pure: no accounts, no syscalls, no floats, no `unsafe`,
//! no dependencies. The on-chain programs call these functions to decide every
//! amount that moves, and the TypeScript SDK mirrors them bit-for-bit (checked
//! against shared test vectors) so a quote shown in the UI is the amount the
//! program will settle.
//!
//! # Rounding
//!
//! Rounding direction is fixed and always favours the curve, never the trader:
//!
//! * tokens paid out by a buy round **down**
//! * quote paid out by a sell rounds **down**
//! * quote required to buy an exact token amount rounds **up**
//! * fees round **up**
//!
//! Under those rules the product `virtual_quote * virtual_token` never
//! decreases, which is what keeps the curve solvent: any sequence of sells can
//! always be paid out of the quote that buyers actually deposited.
#![no_std]
#![forbid(unsafe_code)]
#![deny(missing_docs)]

#[cfg(test)]
extern crate std;

mod curve;
mod error;
mod fees;
mod num;
mod pool;

pub use curve::{
    quote_buy, quote_in_for_tokens_out, quote_sell, BuyQuote, CurveParams, Reserves, SellQuote,
    PRICE_CONTINUITY_TOLERANCE_BPS,
};
pub use error::MathError;
pub use fees::{split_fee, FeeRates, Fees, MAX_TOTAL_FEE_BPS};
pub use num::{bps_ceil, bps_floor, mul_div_ceil, mul_div_floor, BPS_DENOMINATOR};
pub use pool::{
    pool_quote_buy, pool_quote_sell, split_pool_fee, PoolBuyQuote, PoolFeeRates, PoolFees,
    PoolReserves, PoolSellQuote, MAX_POOL_FEE_BPS,
};
