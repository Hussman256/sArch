use crate::{mul_div_ceil, mul_div_floor, MathError, BPS_DENOMINATOR};

/// Hard ceiling on the total trade fee, in basis points (10%).
///
/// Config can move the fee, but never above this. It bounds what a compromised
/// admin key could do to coins launched while it held control.
pub const MAX_TOTAL_FEE_BPS: u16 = 1_000;

/// The two shares of the trade fee, in basis points of the trade's quote amount.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeRates {
    /// Share kept by the platform.
    pub platform_bps: u16,
    /// Share paid to the coin's creator.
    pub creator_bps: u16,
}

impl FeeRates {
    /// Platform and creator shares added together.
    pub const fn total_bps(&self) -> u32 {
        self.platform_bps as u32 + self.creator_bps as u32
    }

    /// Rejects rates whose total exceeds [`MAX_TOTAL_FEE_BPS`].
    pub fn validate(&self) -> Result<(), MathError> {
        if self.total_bps() > u32::from(MAX_TOTAL_FEE_BPS) {
            return Err(MathError::InvalidParams);
        }
        Ok(())
    }
}

/// A trade fee, already split between its two recipients.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Fees {
    /// Quote units owed to the platform.
    pub platform: u64,
    /// Quote units owed to the coin's creator.
    pub creator: u64,
}

impl Fees {
    /// Platform and creator amounts added together.
    pub fn total(&self) -> Result<u64, MathError> {
        self.platform
            .checked_add(self.creator)
            .ok_or(MathError::Overflow)
    }
}

/// Fee on `curve_quote_amount`, the quote that enters the curve on a buy or
/// leaves it on a sell.
///
/// This is the only place a fee is computed, for buys and sells alike. The
/// total rounds up; the platform takes the floor of its share of that total and
/// the creator takes the rest, so rounding dust goes to the creator.
pub fn split_fee(curve_quote_amount: u64, rates: &FeeRates) -> Result<Fees, MathError> {
    rates.validate()?;
    let total_bps = u64::from(rates.total_bps());
    if total_bps == 0 {
        return Ok(Fees::default());
    }
    let total = mul_div_ceil(curve_quote_amount, total_bps, BPS_DENOMINATOR)?;
    let platform = mul_div_floor(total, u64::from(rates.platform_bps), total_bps)?;
    Ok(Fees {
        platform,
        creator: total - platform,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRD_RATES: FeeRates = FeeRates {
        platform_bps: 100,
        creator_bps: 125,
    };

    #[test]
    fn prd_split_on_a_round_amount() {
        // $1M of curve volume: $22,500 total, $10,000 platform, $12,500 creator.
        let fees = split_fee(1_000_000_000_000, &PRD_RATES).unwrap();
        assert_eq!(fees.platform, 10_000_000_000);
        assert_eq!(fees.creator, 12_500_000_000);
        assert_eq!(fees.total(), Ok(22_500_000_000));
    }

    #[test]
    fn total_rounds_up_and_dust_goes_to_the_creator() {
        // 100 * 2.25% = 2.25 -> 3 in total. Platform floor(3 * 100/225) = 1.
        let fees = split_fee(100, &PRD_RATES).unwrap();
        assert_eq!(
            fees,
            Fees {
                platform: 1,
                creator: 2
            }
        );
        // One unit still pays a one-unit fee.
        let fees = split_fee(1, &PRD_RATES).unwrap();
        assert_eq!(
            fees,
            Fees {
                platform: 0,
                creator: 1
            }
        );
    }

    #[test]
    fn zero_amount_and_zero_rate_cost_nothing() {
        assert_eq!(split_fee(0, &PRD_RATES), Ok(Fees::default()));
        let free = FeeRates {
            platform_bps: 0,
            creator_bps: 0,
        };
        assert_eq!(split_fee(u64::MAX, &free), Ok(Fees::default()));
    }

    #[test]
    fn one_sided_rates() {
        let platform_only = FeeRates {
            platform_bps: 100,
            creator_bps: 0,
        };
        assert_eq!(
            split_fee(10_000, &platform_only),
            Ok(Fees {
                platform: 100,
                creator: 0
            })
        );
        let creator_only = FeeRates {
            platform_bps: 0,
            creator_bps: 125,
        };
        assert_eq!(
            split_fee(10_000, &creator_only),
            Ok(Fees {
                platform: 0,
                creator: 125
            })
        );
    }

    #[test]
    fn rejects_rates_above_the_ceiling() {
        let at_ceiling = FeeRates {
            platform_bps: 500,
            creator_bps: 500,
        };
        assert!(at_ceiling.validate().is_ok());
        let over = FeeRates {
            platform_bps: 500,
            creator_bps: 501,
        };
        assert_eq!(over.validate(), Err(MathError::InvalidParams));
        assert_eq!(split_fee(1_000, &over), Err(MathError::InvalidParams));
        // The sum is taken in 32 bits, so two large u16s cannot wrap past the check.
        let wrap = FeeRates {
            platform_bps: u16::MAX,
            creator_bps: u16::MAX,
        };
        assert_eq!(wrap.validate(), Err(MathError::InvalidParams));
    }

    #[test]
    fn largest_amount_does_not_overflow() {
        let fees = split_fee(u64::MAX, &PRD_RATES).unwrap();
        assert!(fees.total().is_ok());
    }
}
