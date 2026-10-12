//! Errors the launchpad programs return, with stable numeric codes.

use arch_program::program_error::ProgramError;
use archpad_math::MathError;
use core::fmt;

/// Every domain error across the four programs.
///
/// The discriminant is the wire value: programs return it as
/// `ProgramError::Custom(code)` and the SDK maps it back to a message. Codes
/// are never reused or renumbered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum ArchpadError {
    // --- shared -----------------------------------------------------------
    /// Instruction data could not be decoded.
    InvalidInstruction = 100,
    /// An account is not the one this instruction requires at that position.
    AccountMismatch = 101,
    /// An account holds a different kind of state than expected.
    WrongAccountType = 102,
    /// The account is already initialised.
    AlreadyInitialized = 103,
    /// A required signature is missing or comes from the wrong key.
    Unauthorized = 104,

    // --- math -------------------------------------------------------------
    /// A value does not fit in 64 bits.
    MathOverflow = 120,
    /// An amount of zero was supplied.
    ZeroAmount = 121,
    /// The trade is too small to move a whole unit after rounding and fees.
    DustTrade = 122,
    /// Every curve token is sold; the curve no longer trades.
    CurveComplete = 123,
    /// The curve cannot pay out that much quote.
    InsufficientReserves = 124,
    /// Curve or fee parameters are inconsistent.
    InvalidParams = 125,

    // --- config -----------------------------------------------------------
    /// The proposed config fails validation.
    InvalidConfig = 200,
    /// The signer is not one of the admin keys.
    NotAnAdmin = 201,
    /// An approved config change cannot be executed before its delay has passed.
    TimelockNotElapsed = 202,
    /// The mint is not one of the configured quote assets.
    UnknownQuoteAsset = 203,
    /// The config was replaced after this proposal was made.
    ProposalStale = 204,
    /// The proposal has already been executed.
    ProposalExecuted = 205,
    /// The proposal does not have enough approvals.
    NotEnoughApprovals = 206,
    /// This admin has already approved the proposal.
    AlreadyApproved = 207,
    /// This admin has not approved the proposal, so has nothing to withdraw.
    NotApproved = 208,

    // --- launch -----------------------------------------------------------
    /// New launches are paused.
    LaunchesPaused = 300,
    /// The chosen quote asset is paused.
    QuoteAssetPaused = 301,
    /// Name, ticker, image or description is empty or too long.
    InvalidMetadata = 302,
    /// The creator's launch buy is below the required share of curve supply.
    CreatorBuyTooSmall = 303,
    /// The buy would take this wallet past the early-window cap.
    WalletCapExceeded = 304,
    /// The trade would settle worse than the caller's limit.
    SlippageExceeded = 305,
    /// The curve has graduated; trade the pool instead.
    CurveGraduated = 306,
    /// This buy would complete the curve but the graduation accounts are missing.
    GraduationAccountsRequired = 307,

    // --- fees -------------------------------------------------------------
    /// There are no fees to claim.
    NothingToClaim = 400,

    // --- pool -------------------------------------------------------------
    /// The pool cannot fill a trade of that size.
    InsufficientLiquidity = 500,
}

impl ArchpadError {
    /// The numeric code programs put on the wire.
    pub const fn code(self) -> u32 {
        self as u32
    }

    /// The error for a wire code, if it is one of ours.
    pub fn from_code(code: u32) -> Option<Self> {
        use ArchpadError::*;
        Some(match code {
            100 => InvalidInstruction,
            101 => AccountMismatch,
            102 => WrongAccountType,
            103 => AlreadyInitialized,
            104 => Unauthorized,
            120 => MathOverflow,
            121 => ZeroAmount,
            122 => DustTrade,
            123 => CurveComplete,
            124 => InsufficientReserves,
            125 => InvalidParams,
            200 => InvalidConfig,
            201 => NotAnAdmin,
            202 => TimelockNotElapsed,
            203 => UnknownQuoteAsset,
            204 => ProposalStale,
            205 => ProposalExecuted,
            206 => NotEnoughApprovals,
            207 => AlreadyApproved,
            208 => NotApproved,
            300 => LaunchesPaused,
            301 => QuoteAssetPaused,
            302 => InvalidMetadata,
            303 => CreatorBuyTooSmall,
            304 => WalletCapExceeded,
            305 => SlippageExceeded,
            306 => CurveGraduated,
            307 => GraduationAccountsRequired,
            400 => NothingToClaim,
            500 => InsufficientLiquidity,
            _ => return None,
        })
    }

    /// A short, user-presentable description.
    pub const fn message(self) -> &'static str {
        use ArchpadError::*;
        match self {
            InvalidInstruction => "instruction data could not be decoded",
            AccountMismatch => "an account is not the one this instruction requires",
            WrongAccountType => "an account holds a different kind of state than expected",
            AlreadyInitialized => "account is already initialised",
            Unauthorized => "missing or wrong signer",
            MathOverflow => "amount does not fit in 64 bits",
            ZeroAmount => "amount is zero",
            DustTrade => "trade is too small",
            CurveComplete => "the curve is complete",
            InsufficientReserves => "the curve cannot pay out that much",
            InvalidParams => "curve or fee parameters are inconsistent",
            InvalidConfig => "proposed config fails validation",
            NotAnAdmin => "signer is not one of the admin keys",
            TimelockNotElapsed => "the approved change is still inside its delay",
            UnknownQuoteAsset => "mint is not a configured quote asset",
            ProposalStale => "the config was replaced after this proposal was made",
            ProposalExecuted => "the proposal has already been executed",
            NotEnoughApprovals => "the proposal does not have enough approvals",
            AlreadyApproved => "this admin has already approved the proposal",
            NotApproved => "this admin has not approved the proposal",
            LaunchesPaused => "new launches are paused",
            QuoteAssetPaused => "this quote asset is paused",
            InvalidMetadata => "name, ticker, image or description is empty or too long",
            CreatorBuyTooSmall => "creator's launch buy is below the required minimum",
            WalletCapExceeded => "buy exceeds the per-wallet cap of the launch window",
            SlippageExceeded => "price moved past your limit",
            CurveGraduated => "the curve has graduated; trade the pool",
            GraduationAccountsRequired => {
                "this buy completes the curve and needs the graduation accounts"
            }
            NothingToClaim => "there are no fees to claim",
            InsufficientLiquidity => "the pool cannot fill a trade of that size",
        }
    }
}

impl fmt::Display for ArchpadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl From<ArchpadError> for ProgramError {
    fn from(error: ArchpadError) -> Self {
        ProgramError::Custom(error.code())
    }
}

impl From<MathError> for ArchpadError {
    fn from(error: MathError) -> Self {
        match error {
            MathError::Overflow => ArchpadError::MathOverflow,
            MathError::ZeroAmount => ArchpadError::ZeroAmount,
            MathError::DustTrade => ArchpadError::DustTrade,
            MathError::CurveComplete => ArchpadError::CurveComplete,
            MathError::InsufficientReserves => ArchpadError::InsufficientReserves,
            MathError::InvalidParams => ArchpadError::InvalidParams,
        }
    }
}

/// Turns a math refusal into the program error for it.
pub fn math_err(error: MathError) -> ProgramError {
    ArchpadError::from(error).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_round_trip_and_are_unique() {
        let mut seen = std::collections::BTreeSet::new();
        for code in 0..1_000u32 {
            if let Some(error) = ArchpadError::from_code(code) {
                assert_eq!(error.code(), code);
                assert!(seen.insert(code));
                assert!(!error.message().is_empty());
            }
        }
        // Every variant is reachable through `from_code`.
        assert_eq!(seen.len(), 30);
    }

    #[test]
    fn converts_to_a_custom_program_error() {
        let error: ProgramError = ArchpadError::SlippageExceeded.into();
        assert_eq!(error, ProgramError::Custom(305));
        assert_eq!(math_err(MathError::DustTrade), ProgramError::Custom(122));
    }
}
