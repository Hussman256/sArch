/**
 * The programs' error codes, mirrored from the Rust `ArchpadError` enum, and
 * helpers to turn a failed transaction into something a person can act on.
 */

export interface ProgramErrorInfo {
  code: number;
  name: string;
  message: string;
}

const ERRORS: readonly ProgramErrorInfo[] = [
  { code: 100, name: "InvalidInstruction", message: "instruction data could not be decoded" },
  { code: 101, name: "AccountMismatch", message: "an account is not the one this instruction requires" },
  { code: 102, name: "WrongAccountType", message: "an account holds a different kind of state than expected" },
  { code: 103, name: "AlreadyInitialized", message: "account is already initialised" },
  { code: 104, name: "Unauthorized", message: "missing or wrong signer" },
  { code: 120, name: "MathOverflow", message: "amount does not fit in 64 bits" },
  { code: 121, name: "ZeroAmount", message: "amount is zero" },
  { code: 122, name: "DustTrade", message: "trade is too small" },
  { code: 123, name: "CurveComplete", message: "the curve is complete" },
  { code: 124, name: "InsufficientReserves", message: "the curve cannot pay out that much" },
  { code: 125, name: "InvalidParams", message: "curve or fee parameters are inconsistent" },
  { code: 200, name: "InvalidConfig", message: "proposed config fails validation" },
  { code: 201, name: "NotAnAdmin", message: "signer is not one of the admin keys" },
  { code: 202, name: "TimelockNotElapsed", message: "the approved change is still inside its delay" },
  { code: 203, name: "UnknownQuoteAsset", message: "mint is not a configured quote asset" },
  { code: 204, name: "ProposalStale", message: "the config was replaced after this proposal was made" },
  { code: 205, name: "ProposalExecuted", message: "the proposal has already been executed" },
  { code: 206, name: "NotEnoughApprovals", message: "the proposal does not have enough approvals" },
  { code: 207, name: "AlreadyApproved", message: "this admin has already approved the proposal" },
  { code: 208, name: "NotApproved", message: "this admin has not approved the proposal" },
  { code: 300, name: "LaunchesPaused", message: "new launches are paused" },
  { code: 301, name: "QuoteAssetPaused", message: "this quote asset is paused" },
  { code: 302, name: "InvalidMetadata", message: "name, ticker, image or description is empty or too long" },
  { code: 303, name: "CreatorBuyTooSmall", message: "creator's launch buy is below the required minimum" },
  { code: 304, name: "WalletCapExceeded", message: "buy exceeds the per-wallet cap of the launch window" },
  { code: 305, name: "SlippageExceeded", message: "price moved past your limit" },
  { code: 306, name: "CurveGraduated", message: "the curve has graduated; trade the pool" },
  { code: 307, name: "GraduationAccountsRequired", message: "this buy completes the curve and needs the graduation accounts" },
  { code: 400, name: "NothingToClaim", message: "there are no fees to claim" },
  { code: 500, name: "InsufficientLiquidity", message: "the pool cannot fill a trade of that size" },
];

const BY_CODE = new Map(ERRORS.map((error) => [error.code, error]));

/** Every error the launchpad programs can return. */
export const PROGRAM_ERRORS: readonly ProgramErrorInfo[] = ERRORS;

/** The launchpad error for a custom program error code, if it is one of ours. */
export function programError(code: number): ProgramErrorInfo | undefined {
  return BY_CODE.get(code);
}

/**
 * Finds the launchpad error in a failed transaction's status message or logs.
 *
 * Nodes report a program's custom error as `custom program error: 0x131` (hex);
 * some paths print it in decimal. Both are recognised.
 */
export function findProgramError(...texts: (string | readonly string[] | undefined)[]): ProgramErrorInfo | undefined {
  for (const text of texts.flatMap((entry) => (entry === undefined ? [] : typeof entry === "string" ? [entry] : [...entry]))) {
    const hexMatch = /custom(?: program)? error:?\s*0x([0-9a-f]+)/i.exec(text);
    if (hexMatch) {
      const found = BY_CODE.get(Number.parseInt(hexMatch[1]!, 16));
      if (found) return found;
    }
    const decimalMatch = /Custom\((\d+)\)/.exec(text);
    if (decimalMatch) {
      const found = BY_CODE.get(Number(decimalMatch[1]));
      if (found) return found;
    }
  }
  return undefined;
}

/** A transaction the chain processed and rejected. */
export class TransactionFailedError extends Error {
  override readonly name = "TransactionFailedError";
  /** The launchpad error behind the failure, when it can be identified. */
  readonly programError: ProgramErrorInfo | undefined;

  constructor(
    readonly txid: string,
    /** The node's own description of the failure. */
    readonly reason: string,
    readonly logs: readonly string[],
  ) {
    const known = findProgramError(reason, logs);
    super(known ? known.message : `transaction failed: ${reason}`);
    this.programError = known;
  }
}
