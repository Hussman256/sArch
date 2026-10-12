use core::fmt;

/// Why a calculation was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MathError {
    /// A result or intermediate value does not fit in 64 bits.
    Overflow,
    /// The caller passed an amount of zero.
    ZeroAmount,
    /// The trade is too small to move a whole unit after rounding and fees.
    DustTrade,
    /// Every token on the curve has been sold; it no longer trades.
    CurveComplete,
    /// A sell would pay out more quote than buyers have deposited.
    InsufficientReserves,
    /// Curve or fee parameters are inconsistent.
    InvalidParams,
}

impl fmt::Display for MathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            MathError::Overflow => "arithmetic overflow",
            MathError::ZeroAmount => "amount is zero",
            MathError::DustTrade => "trade too small",
            MathError::CurveComplete => "curve is complete",
            MathError::InsufficientReserves => "insufficient curve reserves",
            MathError::InvalidParams => "invalid parameters",
        })
    }
}
