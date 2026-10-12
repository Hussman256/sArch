//! The launch program's accounts, addresses and instructions.
//!
//! One instruction creates a coin: its mint, its metadata, its bonding curve
//! and the creator's mandatory first buy, all in one transaction. Two more
//! trade against the curve. The buy that takes the last curve tokens also
//! moves the curve's reserves into the coin's pool, in that same transaction.

use arch_program::{
    account::AccountMeta, instruction::Instruction, pubkey::Pubkey, system_program,
};
use archpad_math::{FeeRates, PoolFeeRates, Reserves};
use borsh::{BorshDeserialize, BorshSerialize};

use crate::{
    config::find_config_address,
    error::ArchpadError,
    fees::{find_creator_vault_address, find_platform_vault_address, find_vault_authority_address},
    ids,
    pool::{find_pool_address, find_pool_quote_vault_address, find_pool_token_vault_address},
    AccountTag,
};

/// Seed prefix of a coin's mint, followed by the creator and a salt.
pub const MINT_SEED: &[u8] = b"mint";
/// Seed prefix of a coin's curve, followed by the mint.
pub const CURVE_SEED: &[u8] = b"curve";
/// Seed prefix of the curve's token vault, followed by the mint.
pub const TOKEN_VAULT_SEED: &[u8] = b"token_vault";
/// Seed prefix of the curve's quote vault, followed by the mint.
pub const QUOTE_VAULT_SEED: &[u8] = b"quote_vault";
/// Seed prefix of a wallet's position in a coin, followed by the mint and the wallet.
pub const POSITION_SEED: &[u8] = b"position";

/// Longest coin name, in bytes.
pub const MAX_NAME_LEN: usize = 32;
/// Longest ticker, in bytes.
pub const MAX_SYMBOL_LEN: usize = 10;
/// Longest image URI, in bytes.
pub const MAX_IMAGE_LEN: usize = 128;
/// Longest on-chain description, in bytes. The full text lives off-chain,
/// committed to by [`CreateCoinArgs::metadata_hash`].
///
/// These four limits are sized so a launch still fits Arch's 1232-byte
/// transaction limit with every field at its maximum.
pub const MAX_DESCRIPTION_LEN: usize = 140;

/// A coin's mint. Derived, so a launch needs no second signer.
pub fn find_mint_address(creator: &Pubkey, salt: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[MINT_SEED, creator.as_ref(), &salt.to_le_bytes()],
        &ids::launch::ID,
    )
}

/// A coin's curve account.
pub fn find_curve_address(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CURVE_SEED, mint.as_ref()], &ids::launch::ID)
}

/// The curve's token vault.
pub fn find_token_vault_address(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[TOKEN_VAULT_SEED, mint.as_ref()], &ids::launch::ID)
}

/// The curve's quote vault.
pub fn find_quote_vault_address(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[QUOTE_VAULT_SEED, mint.as_ref()], &ids::launch::ID)
}

/// A wallet's position in a coin.
pub fn find_position_address(mint: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[POSITION_SEED, mint.as_ref(), wallet.as_ref()],
        &ids::launch::ID,
    )
}

/// A wallet's associated token account for a mint.
pub fn associated_token_address(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    apl_associated_token_account::get_associated_token_address_and_bump_seed(
        wallet,
        mint,
        &apl_associated_token_account::id(),
    )
    .0
}

/// A coin's metadata account in the APL token metadata program.
pub fn find_metadata_address(mint: &Pubkey) -> Pubkey {
    apl_token_metadata::find_metadata_pda_with_program(&apl_token_metadata::id(), mint).0
}

/// Where a curve is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum CurveStatus {
    /// Buys and sells settle against the curve.
    Trading = 0,
    /// Every curve token is sold and the reserves have moved to the pool.
    Graduated = 1,
}

/// A coin's bonding curve.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Curve {
    /// Always [`AccountTag::Curve`].
    pub tag: u8,
    /// Layout version.
    pub version: u8,
    /// Bump of the curve's address.
    pub bump: u8,
    /// A [`CurveStatus`].
    pub status: u8,
    /// Decimals of the coin.
    pub token_decimals: u8,
    /// The coin's mint.
    pub mint: Pubkey,
    /// The asset the coin is priced in.
    pub quote_mint: Pubkey,
    /// Who launched the coin and earns its creator fees.
    pub creator: Pubkey,
    /// Token account holding the unsold supply.
    pub token_vault: Pubkey,
    /// Token account holding the quote buyers have paid in.
    pub quote_vault: Pubkey,
    /// Where the platform's share of each trade fee is paid.
    pub platform_fee_vault: Pubkey,
    /// Where the creator's share of each trade fee is paid.
    pub creator_fee_vault: Pubkey,
    /// Virtual quote reserves. Prices come from the virtual reserves.
    pub virtual_quote: u64,
    /// Virtual token reserves.
    pub virtual_token: u64,
    /// Quote the curve actually holds.
    pub real_quote: u64,
    /// Curve tokens not yet sold.
    pub real_token: u64,
    /// Total supply of the coin.
    pub total_supply: u64,
    /// Supply sold through the curve.
    pub curve_supply: u64,
    /// Virtual quote reserves at launch.
    pub initial_virtual_quote: u64,
    /// Virtual token reserves at launch.
    pub initial_virtual_token: u64,
    /// Platform's share of each curve trade, in basis points.
    pub platform_fee_bps: u16,
    /// Creator's share of each curve trade, in basis points.
    pub creator_fee_bps: u16,
    /// Share of each pool swap that stays in the pool, in basis points.
    pub pool_lp_fee_bps: u16,
    /// Platform's share of each pool swap, in basis points.
    pub pool_platform_fee_bps: u16,
    /// Creator's share of each pool swap, in basis points.
    pub pool_creator_fee_bps: u16,
    /// Unix time of the launch.
    pub launched_at: i64,
    /// Unix time the launch window closes. Before it, each wallet is capped.
    pub early_window_end: i64,
    /// Most tokens one wallet may buy before the launch window closes.
    pub early_wallet_cap: u64,
    /// Unix time of graduation, or 0 while still trading.
    pub graduated_at: i64,
    /// SHA-256 of the coin's off-chain metadata document (full description,
    /// social links). Lets anyone check that what a site shows is what the
    /// creator launched with.
    pub metadata_hash: [u8; 32],
}

impl Curve {
    /// Current layout version.
    pub const VERSION: u8 = 1;
    /// Serialized size in bytes.
    pub const LEN: usize = 5 + 7 * 32 + 8 * 8 + 5 * 2 + 4 * 8 + 32;

    /// The curve's reserves, in the form the math crate works with.
    pub const fn reserves(&self) -> Reserves {
        Reserves {
            virtual_quote: self.virtual_quote,
            virtual_token: self.virtual_token,
            real_quote: self.real_quote,
            real_token: self.real_token,
        }
    }

    /// Replaces the curve's reserves.
    pub fn set_reserves(&mut self, reserves: &Reserves) {
        self.virtual_quote = reserves.virtual_quote;
        self.virtual_token = reserves.virtual_token;
        self.real_quote = reserves.real_quote;
        self.real_token = reserves.real_token;
    }

    /// The curve trade fee split this coin launched with.
    pub const fn fee_rates(&self) -> FeeRates {
        FeeRates {
            platform_bps: self.platform_fee_bps,
            creator_bps: self.creator_fee_bps,
        }
    }

    /// The pool swap fee split this coin launched with.
    pub const fn pool_fee_rates(&self) -> PoolFeeRates {
        PoolFeeRates {
            lp_bps: self.pool_lp_fee_bps,
            platform_bps: self.pool_platform_fee_bps,
            creator_bps: self.pool_creator_fee_bps,
        }
    }

    /// True while the curve still trades.
    pub const fn is_trading(&self) -> bool {
        self.status == CurveStatus::Trading as u8
    }

    /// True while the per-wallet cap applies.
    pub const fn in_early_window(&self, now: i64) -> bool {
        now < self.early_window_end
    }

    /// Tokens held back from the curve for the pool.
    pub const fn pool_supply(&self) -> u64 {
        self.total_supply - self.curve_supply
    }
}

/// How much of a coin a wallet bought during its launch window.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    /// Always [`AccountTag::Position`].
    pub tag: u8,
    /// Layout version.
    pub version: u8,
    /// Bump of the position's address.
    pub bump: u8,
    /// The coin.
    pub mint: Pubkey,
    /// The wallet.
    pub wallet: Pubkey,
    /// Tokens this wallet bought before the launch window closed.
    pub window_bought: u64,
}

impl Position {
    /// Current layout version.
    pub const VERSION: u8 = 1;
    /// Serialized size in bytes.
    pub const LEN: usize = 3 + 2 * 32 + 8;

    /// A wallet's position before its first buy.
    pub fn new(bump: u8, mint: Pubkey, wallet: Pubkey) -> Self {
        Self {
            tag: AccountTag::Position as u8,
            version: Self::VERSION,
            bump,
            mint,
            wallet,
            window_bought: 0,
        }
    }
}

/// What a creator supplies to launch a coin.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct CreateCoinArgs {
    /// Any number the creator has not used before. It makes the mint address unique.
    pub salt: u64,
    /// Coin name.
    pub name: String,
    /// Ticker.
    pub symbol: String,
    /// Image URI.
    pub image: String,
    /// Short description stored on chain.
    pub description: String,
    /// SHA-256 of the off-chain metadata document, or all zeros if there is none.
    pub metadata_hash: [u8; 32],
    /// The most quote the creator will spend on their launch buy, fee included.
    pub creator_buy_max_quote: u64,
    /// The fewest tokens the creator will accept for it.
    pub creator_buy_min_tokens: u64,
}

impl CreateCoinArgs {
    /// Checks the text fields. Name and ticker are required; all four must fit
    /// their limits.
    pub fn validate(&self) -> Result<(), ArchpadError> {
        let ok = !self.name.is_empty()
            && self.name.len() <= MAX_NAME_LEN
            && !self.symbol.is_empty()
            && self.symbol.len() <= MAX_SYMBOL_LEN
            && self.image.len() <= MAX_IMAGE_LEN
            && self.description.len() <= MAX_DESCRIPTION_LEN;
        if ok {
            Ok(())
        } else {
            Err(ArchpadError::InvalidMetadata)
        }
    }
}

/// Instructions of the launch program.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum LaunchInstruction {
    /// Launches a coin and makes the creator's mandatory first buy.
    ///
    /// Mints the whole supply into the curve's vault, then gives up the mint
    /// authority. The mint never has a freeze authority.
    ///
    /// 0. `[writable, signer]` Creator, pays for the new accounts
    /// 1. `[]` Config account
    /// 2. `[]` Quote mint
    /// 3. `[writable]` Coin mint
    /// 4. `[writable]` Curve
    /// 5. `[writable]` Curve token vault
    /// 6. `[writable]` Curve quote vault
    /// 7. `[writable]` Coin metadata account
    /// 8. `[writable]` Creator's associated token account for the coin
    /// 9. `[writable]` Creator's quote token account
    /// 10. `[writable]` Creator's position
    /// 11. `[writable]` Platform fee vault for the quote asset
    /// 12. `[writable]` Creator fee vault for the coin
    /// 13. `[]` Fee vault authority
    /// 14. `[]` Token program
    /// 15. `[]` System program
    /// 16. `[]` Associated token account program
    /// 17. `[]` Token metadata program
    /// 18. `[]` Fee vault program
    /// 19. `[]` This program, which it calls to record its events
    CreateCoin(CreateCoinArgs),

    /// Buys from the curve, spending at most `max_quote_in` with the fee
    /// included. Fails if it would return fewer than `min_tokens_out`.
    ///
    /// If the buy takes the last curve tokens it also graduates the coin:
    /// the curve's reserves and the held-back supply move into the coin's
    /// pool before the instruction returns.
    ///
    /// 0. `[writable, signer]` Buyer
    /// 1. `[writable]` Curve
    /// 2. `[writable]` Curve token vault
    /// 3. `[writable]` Curve quote vault
    /// 4. `[writable]` Buyer's token account for the coin
    /// 5. `[writable]` Buyer's quote token account
    /// 6. `[writable]` Buyer's position
    /// 7. `[writable]` Platform fee vault
    /// 8. `[writable]` Creator fee vault
    /// 9. `[]` Token program
    /// 10. `[]` System program
    /// 11. `[]` This program, which it calls to record its events
    ///
    /// Needed only by a buy that completes the curve, harmless otherwise:
    ///
    /// 12. `[]` Pool program
    /// 13. `[writable]` Pool
    /// 14. `[writable]` Pool token vault
    /// 15. `[writable]` Pool quote vault
    /// 16. `[]` Coin mint
    /// 17. `[]` Quote mint
    Buy {
        /// The most quote to spend, fee included.
        max_quote_in: u64,
        /// The fewest tokens to accept.
        min_tokens_out: u64,
    },

    /// Sells `tokens_in` back to the curve. Fails if it would pay out less
    /// than `min_quote_out` after the fee.
    ///
    /// 0. `[signer]` Seller
    /// 1. `[writable]` Curve
    /// 2. `[writable]` Curve token vault
    /// 3. `[writable]` Curve quote vault
    /// 4. `[writable]` Seller's token account for the coin
    /// 5. `[writable]` Seller's quote token account
    /// 6. `[writable]` Platform fee vault
    /// 7. `[writable]` Creator fee vault
    /// 8. `[]` Token program
    /// 9. `[]` This program, which it calls to record its events
    Sell {
        /// Tokens to sell.
        tokens_in: u64,
        /// The least quote to accept, after the fee.
        min_quote_out: u64,
    },
}

impl LaunchInstruction {
    /// Borsh encoding of the instruction.
    pub fn pack(&self) -> Vec<u8> {
        borsh::to_vec(self).expect("launch instructions always serialize")
    }

    /// Decodes instruction data.
    pub fn unpack(data: &[u8]) -> Result<Self, ArchpadError> {
        Self::try_from_slice(data).map_err(|_| ArchpadError::InvalidInstruction)
    }
}

/// Builds [`LaunchInstruction::CreateCoin`]. The creator pays from, and
/// receives into, their associated token accounts.
pub fn create_coin(creator: &Pubkey, quote_mint: &Pubkey, args: CreateCoinArgs) -> Instruction {
    let mint = find_mint_address(creator, args.salt).0;
    Instruction {
        program_id: ids::launch::ID,
        accounts: vec![
            AccountMeta::new(*creator, true),
            AccountMeta::new_readonly(find_config_address().0, false),
            AccountMeta::new_readonly(*quote_mint, false),
            AccountMeta::new(mint, false),
            AccountMeta::new(find_curve_address(&mint).0, false),
            AccountMeta::new(find_token_vault_address(&mint).0, false),
            AccountMeta::new(find_quote_vault_address(&mint).0, false),
            AccountMeta::new(find_metadata_address(&mint), false),
            AccountMeta::new(associated_token_address(creator, &mint), false),
            AccountMeta::new(associated_token_address(creator, quote_mint), false),
            AccountMeta::new(find_position_address(&mint, creator).0, false),
            AccountMeta::new(find_platform_vault_address(quote_mint).0, false),
            AccountMeta::new(find_creator_vault_address(&mint).0, false),
            AccountMeta::new_readonly(find_vault_authority_address().0, false),
            AccountMeta::new_readonly(apl_token::id(), false),
            AccountMeta::new_readonly(system_program::SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(apl_associated_token_account::id(), false),
            AccountMeta::new_readonly(apl_token_metadata::id(), false),
            AccountMeta::new_readonly(ids::fees::ID, false),
            AccountMeta::new_readonly(ids::launch::ID, false),
        ],
        data: LaunchInstruction::CreateCoin(args).pack(),
    }
}

/// Builds [`LaunchInstruction::Buy`], graduation accounts included, so the
/// buy succeeds whether or not it turns out to be the one that completes the
/// curve.
pub fn buy(
    buyer: &Pubkey,
    mint: &Pubkey,
    quote_mint: &Pubkey,
    max_quote_in: u64,
    min_tokens_out: u64,
) -> Instruction {
    Instruction {
        program_id: ids::launch::ID,
        accounts: vec![
            AccountMeta::new(*buyer, true),
            AccountMeta::new(find_curve_address(mint).0, false),
            AccountMeta::new(find_token_vault_address(mint).0, false),
            AccountMeta::new(find_quote_vault_address(mint).0, false),
            AccountMeta::new(associated_token_address(buyer, mint), false),
            AccountMeta::new(associated_token_address(buyer, quote_mint), false),
            AccountMeta::new(find_position_address(mint, buyer).0, false),
            AccountMeta::new(find_platform_vault_address(quote_mint).0, false),
            AccountMeta::new(find_creator_vault_address(mint).0, false),
            AccountMeta::new_readonly(apl_token::id(), false),
            AccountMeta::new_readonly(system_program::SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(ids::launch::ID, false),
            AccountMeta::new_readonly(ids::pool::ID, false),
            AccountMeta::new(find_pool_address(mint).0, false),
            AccountMeta::new(find_pool_token_vault_address(mint).0, false),
            AccountMeta::new(find_pool_quote_vault_address(mint).0, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(*quote_mint, false),
        ],
        data: LaunchInstruction::Buy {
            max_quote_in,
            min_tokens_out,
        }
        .pack(),
    }
}

/// Builds [`LaunchInstruction::Sell`].
pub fn sell(
    seller: &Pubkey,
    mint: &Pubkey,
    quote_mint: &Pubkey,
    tokens_in: u64,
    min_quote_out: u64,
) -> Instruction {
    Instruction {
        program_id: ids::launch::ID,
        accounts: vec![
            AccountMeta::new_readonly(*seller, true),
            AccountMeta::new(find_curve_address(mint).0, false),
            AccountMeta::new(find_token_vault_address(mint).0, false),
            AccountMeta::new(find_quote_vault_address(mint).0, false),
            AccountMeta::new(associated_token_address(seller, mint), false),
            AccountMeta::new(associated_token_address(seller, quote_mint), false),
            AccountMeta::new(find_platform_vault_address(quote_mint).0, false),
            AccountMeta::new(find_creator_vault_address(mint).0, false),
            AccountMeta::new_readonly(apl_token::id(), false),
            AccountMeta::new_readonly(ids::launch::ID, false),
        ],
        data: LaunchInstruction::Sell {
            tokens_in,
            min_quote_out,
        }
        .pack(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::config::tests::key;

    pub(crate) fn sample_args() -> CreateCoinArgs {
        CreateCoinArgs {
            salt: 7,
            name: "Arch Cat".into(),
            symbol: "ACAT".into(),
            image: "https://example.com/i/acat.png".into(),
            description: "The first cat on Arch.".into(),
            metadata_hash: [9; 32],
            creator_buy_max_quote: 100_000,
            creator_buy_min_tokens: 3_965_500_000_000,
        }
    }

    pub(crate) fn sample_curve() -> Curve {
        Curve {
            tag: AccountTag::Curve as u8,
            version: Curve::VERSION,
            bump: 255,
            status: CurveStatus::Trading as u8,
            token_decimals: 6,
            mint: key(1),
            quote_mint: key(2),
            creator: key(3),
            token_vault: key(4),
            quote_vault: key(5),
            platform_fee_vault: key(6),
            creator_fee_vault: key(7),
            virtual_quote: 6_000_000,
            virtual_token: 1_073_000_000_000_000,
            real_quote: 0,
            real_token: 793_100_000_000_000,
            total_supply: 1_000_000_000_000_000,
            curve_supply: 793_100_000_000_000,
            initial_virtual_quote: 6_000_000,
            initial_virtual_token: 1_073_000_000_000_000,
            platform_fee_bps: 100,
            creator_fee_bps: 125,
            pool_lp_fee_bps: 20,
            pool_platform_fee_bps: 5,
            pool_creator_fee_bps: 5,
            launched_at: 1_800_000_000,
            early_window_end: 1_800_000_010,
            early_wallet_cap: 15_862_000_000_000,
            graduated_at: 0,
            metadata_hash: [9; 32],
        }
    }

    #[test]
    fn declared_sizes_match_the_encoding() {
        assert_eq!(borsh::to_vec(&sample_curve()).unwrap().len(), Curve::LEN);
        assert_eq!(Curve::LEN, 367);
        let position = Position::new(255, key(1), key(2));
        assert_eq!(borsh::to_vec(&position).unwrap().len(), Position::LEN);
        assert_eq!(Position::LEN, 75);
    }

    #[test]
    fn curve_helpers_reflect_its_fields() {
        let mut curve = sample_curve();
        assert!(curve.is_trading());
        assert!(curve.in_early_window(1_800_000_009));
        assert!(!curve.in_early_window(1_800_000_010));
        assert_eq!(curve.pool_supply(), 206_900_000_000_000);
        assert_eq!(curve.fee_rates().total_bps(), 225);
        assert_eq!(curve.pool_fee_rates().total_bps(), 30);

        let mut reserves = curve.reserves();
        reserves.real_quote = 42;
        reserves.virtual_quote += 42;
        curve.set_reserves(&reserves);
        assert_eq!(curve.reserves(), reserves);

        curve.status = CurveStatus::Graduated as u8;
        assert!(!curve.is_trading());
    }

    #[test]
    fn metadata_limits() {
        assert_eq!(sample_args().validate(), Ok(()));

        let at_limit = CreateCoinArgs {
            name: "n".repeat(MAX_NAME_LEN),
            symbol: "S".repeat(MAX_SYMBOL_LEN),
            image: "i".repeat(MAX_IMAGE_LEN),
            description: "d".repeat(MAX_DESCRIPTION_LEN),
            ..sample_args()
        };
        assert_eq!(at_limit.validate(), Ok(()));

        // Image and description may be left out; name and ticker may not.
        let bare = CreateCoinArgs {
            image: String::new(),
            description: String::new(),
            ..sample_args()
        };
        assert_eq!(bare.validate(), Ok(()));

        for broken in [
            CreateCoinArgs {
                name: String::new(),
                ..sample_args()
            },
            CreateCoinArgs {
                symbol: String::new(),
                ..sample_args()
            },
            CreateCoinArgs {
                name: "n".repeat(MAX_NAME_LEN + 1),
                ..sample_args()
            },
            CreateCoinArgs {
                symbol: "S".repeat(MAX_SYMBOL_LEN + 1),
                ..sample_args()
            },
            CreateCoinArgs {
                image: "i".repeat(MAX_IMAGE_LEN + 1),
                ..sample_args()
            },
            CreateCoinArgs {
                description: "d".repeat(MAX_DESCRIPTION_LEN + 1),
                ..sample_args()
            },
        ] {
            assert_eq!(broken.validate(), Err(ArchpadError::InvalidMetadata));
        }
    }

    #[test]
    fn limits_are_counted_in_bytes_not_characters() {
        // Eleven 3-byte characters are 33 bytes: over the name limit.
        let wide = CreateCoinArgs {
            name: "猫".repeat(11),
            ..sample_args()
        };
        assert_eq!(wide.validate(), Err(ArchpadError::InvalidMetadata));
    }

    #[test]
    fn instructions_round_trip() {
        for instruction in [
            LaunchInstruction::CreateCoin(sample_args()),
            LaunchInstruction::Buy {
                max_quote_in: 1,
                min_tokens_out: 2,
            },
            LaunchInstruction::Sell {
                tokens_in: 3,
                min_quote_out: 4,
            },
        ] {
            assert_eq!(
                LaunchInstruction::unpack(&instruction.pack()),
                Ok(instruction)
            );
        }
        assert_eq!(
            LaunchInstruction::unpack(&[]),
            Err(ArchpadError::InvalidInstruction)
        );
        assert_eq!(
            LaunchInstruction::unpack(&[3]),
            Err(ArchpadError::InvalidInstruction)
        );
        assert_eq!(
            LaunchInstruction::unpack(&[1, 0]),
            Err(ArchpadError::InvalidInstruction)
        );
    }

    #[test]
    fn addresses_are_distinct_per_coin_and_per_wallet() {
        let creator = key(1);
        let (mint_a, _) = find_mint_address(&creator, 1);
        let (mint_b, _) = find_mint_address(&creator, 2);
        assert_ne!(mint_a, mint_b, "salt separates one creator's coins");
        assert_ne!(
            mint_a,
            find_mint_address(&key(2), 1).0,
            "creators cannot collide"
        );

        let addresses = [
            find_curve_address(&mint_a).0,
            find_token_vault_address(&mint_a).0,
            find_quote_vault_address(&mint_a).0,
            find_position_address(&mint_a, &creator).0,
            find_position_address(&mint_a, &key(2)).0,
            find_position_address(&mint_b, &creator).0,
            find_curve_address(&mint_b).0,
        ];
        let unique: std::collections::BTreeSet<_> = addresses.iter().collect();
        assert_eq!(unique.len(), addresses.len());
    }

    #[test]
    fn builders_list_accounts_in_the_documented_order() {
        let (creator, quote) = (key(1), key(2));
        let args = sample_args();
        let mint = find_mint_address(&creator, args.salt).0;

        let create = create_coin(&creator, &quote, args);
        assert_eq!(create.program_id, ids::launch::ID);
        assert_eq!(create.accounts.len(), 20);
        assert_eq!(create.accounts[0], AccountMeta::new(creator, true));
        assert_eq!(create.accounts[3].pubkey, mint);
        assert_eq!(create.accounts[4].pubkey, find_curve_address(&mint).0);
        assert_eq!(create.accounts[18].pubkey, ids::fees::ID);
        assert_eq!(create.accounts[19].pubkey, ids::launch::ID);
        assert_eq!(
            create.accounts.iter().filter(|meta| meta.is_signer).count(),
            1
        );

        let buy = buy(&creator, &mint, &quote, 10, 1);
        assert_eq!(buy.accounts.len(), 18);
        assert_eq!(buy.accounts[11].pubkey, ids::launch::ID);
        assert_eq!(buy.accounts[12].pubkey, ids::pool::ID);
        assert_eq!(buy.accounts[13].pubkey, find_pool_address(&mint).0);
        assert_eq!(buy.accounts.iter().filter(|meta| meta.is_signer).count(), 1);

        let sell = sell(&creator, &mint, &quote, 10, 1);
        assert_eq!(sell.accounts.len(), 10);
        assert_eq!(sell.accounts[9].pubkey, ids::launch::ID);
        assert!(sell.accounts[0].is_signer && !sell.accounts[0].is_writable);
    }

    /// A launch with every text field at its limit must still fit in one
    /// transaction, alongside a compute-budget instruction.
    #[test]
    fn largest_launch_fits_in_one_transaction() {
        let creator = key(1);
        let args = CreateCoinArgs {
            name: "n".repeat(MAX_NAME_LEN),
            symbol: "S".repeat(MAX_SYMBOL_LEN),
            image: "i".repeat(MAX_IMAGE_LEN),
            description: "d".repeat(MAX_DESCRIPTION_LEN),
            ..sample_args()
        };
        let create = create_coin(&creator, &key(2), args);
        let budget = arch_program::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(
            1_000_000,
        );

        // Unique account keys: the instruction's accounts plus the two programs invoked.
        let mut keys: std::collections::BTreeSet<Pubkey> =
            create.accounts.iter().map(|meta| meta.pubkey).collect();
        keys.insert(create.program_id);
        keys.insert(budget.program_id);

        // version + signature count + one signature
        let envelope = 4 + 4 + 64;
        // header + key count + keys + blockhash + instruction count
        let message = 3 + 4 + 32 * keys.len() + 32 + 4;
        // program index + account count + indices + data length + data
        let instruction = |ix: &Instruction| 1 + 4 + ix.accounts.len() + 4 + ix.data.len();
        let total = envelope + message + instruction(&create) + instruction(&budget);
        assert!(
            total <= 1232,
            "largest launch is {total} bytes, limit is 1232"
        );
    }
}
