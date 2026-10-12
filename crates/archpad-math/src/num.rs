use crate::MathError;

/// Basis-point denominator: 10 000 bps = 100%.
pub const BPS_DENOMINATOR: u64 = 10_000;

/// `floor(a * b / d)`, computed in 128 bits.
pub fn mul_div_floor(a: u64, b: u64, d: u64) -> Result<u64, MathError> {
    if d == 0 {
        return Err(MathError::InvalidParams);
    }
    // u64 * u64 always fits in u128.
    let q = (a as u128 * b as u128) / d as u128;
    u64::try_from(q).map_err(|_| MathError::Overflow)
}

/// `ceil(a * b / d)`, computed in 128 bits.
pub fn mul_div_ceil(a: u64, b: u64, d: u64) -> Result<u64, MathError> {
    if d == 0 {
        return Err(MathError::InvalidParams);
    }
    let p = a as u128 * b as u128;
    let d = d as u128;
    let q = p / d + u128::from(p % d != 0);
    u64::try_from(q).map_err(|_| MathError::Overflow)
}

/// `floor(amount * bps / 10_000)`.
pub fn bps_floor(amount: u64, bps: u16) -> Result<u64, MathError> {
    mul_div_floor(amount, u64::from(bps), BPS_DENOMINATOR)
}

/// `ceil(amount * bps / 10_000)`.
pub fn bps_ceil(amount: u64, bps: u16) -> Result<u64, MathError> {
    mul_div_ceil(amount, u64::from(bps), BPS_DENOMINATOR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_in_the_named_direction() {
        assert_eq!(mul_div_floor(7, 3, 2), Ok(10));
        assert_eq!(mul_div_ceil(7, 3, 2), Ok(11));
        assert_eq!(mul_div_floor(8, 3, 2), Ok(12));
        assert_eq!(mul_div_ceil(8, 3, 2), Ok(12));
        assert_eq!(mul_div_ceil(0, 3, 2), Ok(0));
    }

    #[test]
    fn survives_products_wider_than_64_bits() {
        assert_eq!(mul_div_floor(u64::MAX, u64::MAX, u64::MAX), Ok(u64::MAX));
        assert_eq!(mul_div_ceil(u64::MAX, u64::MAX, u64::MAX), Ok(u64::MAX));
    }

    #[test]
    fn reports_overflow_and_zero_divisor() {
        assert_eq!(mul_div_floor(u64::MAX, 2, 1), Err(MathError::Overflow));
        assert_eq!(mul_div_ceil(u64::MAX, 2, 1), Err(MathError::Overflow));
        assert_eq!(mul_div_floor(1, 1, 0), Err(MathError::InvalidParams));
        assert_eq!(mul_div_ceil(1, 1, 0), Err(MathError::InvalidParams));
    }

    #[test]
    fn basis_points() {
        assert_eq!(bps_floor(1_000_000, 225), Ok(22_500));
        assert_eq!(bps_floor(99, 225), Ok(2));
        assert_eq!(bps_ceil(99, 225), Ok(3));
        assert_eq!(bps_ceil(0, 225), Ok(0));
    }
}
