//! The pool program's account, addresses and instructions.
//!
//! A coin's pool is created exactly once, by the launch program, in the same
//! transaction as the buy that completes the curve. From then on it is a
//! constant-product pool that anyone can swap against.
//!
//! The program has no instruction that adds or removes liquidity. What
//! graduation puts in stays in: the liquidity is locked by the absence of any
//! way to take it out, not by a key someone has promised not to use.

use arch_program::{
    account::AccountMeta, instruction::Instruction, pubkey::Pubkey, system_program,
};
use archpad_math::{PoolFeeRates, PoolReserves};
use borsh::{BorshDeserialize, BorshSerialize};

use crate::{
    error::ArchpadError,
    ids,
    launch::{
        associated_token_address, find_curve_address, find_quote_vault_address,
        find_token_vault_address,
    },
};

/// Seed prefix of a coin's pool, followed by the mint.
pub const POOL_SEED: &[u8] = b"pool";
/// Seed prefix of the pool's token vault, followed by the mint.
pub const POOL_TOKEN_VAULT_SEED: &[u8] = b"pool_token";
/// Seed prefix of the pool's quote vault, followed by the mint.
pub const POOL_QUOTE_VAULT_SEED: &[u8] = b"pool_quote";

/// A coin's pool. There is exactly one per coin.
pub fn find_pool_address(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POOL_SEED, mint.as_ref()], &ids::pool::ID)
}

/// The pool's token vault.
pub fn find_pool_token_vault_address(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POOL_TOKEN_VAULT_SEED, mint.as_ref()], &ids::pool::ID)
}

/// The pool's quote vault.
pub fn find_pool_quote_vault_address(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POOL_QUOTE_VAULT_SEED, mint.as_ref()], &ids::pool::ID)
}

/// A graduated coin's pool.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pool {
    /// Always [`crate::AccountTag::Pool`].
    pub tag: u8,
    /// Layout version.
    pub version: u8,
    /// Bump of the pool's address.
    pub bump: u8,
    /// The coin's mint.
    pub mint: Pubkey,
    /// The asset the coin is priced in.
    pub quote_mint: Pubkey,
    /// Who launched the coin and earns its creator fees.
    pub creator: Pubkey,
    /// Token account holding the pool's tokens.
    pub token_vault: Pubkey,
    /// Token account holding the pool's quote.
    pub quote_vault: Pubkey,
    /// Where the platform's share of each swap fee is paid.
    pub platform_fee_vault: Pubkey,
    /// Where the creator's share of each swap fee is paid.
    pub creator_fee_vault: Pubkey,
    /// Quote the pool prices against. Tracked here rather than read from the
    /// vault balance, so tokens sent to the vault cannot move the price.
    pub quote_reserve: u64,
    /// Tokens the pool prices against.
    pub token_reserve: u64,
    /// Share of each swap that stays in the pool, in basis points.
    pub lp_fee_bps: u16,
    /// Platform's share of each swap, in basis points.
    pub platform_fee_bps: u16,
    /// Creator's share of each swap, in basis points.
    pub creator_fee_bps: u16,
    /// Unix time the pool was created, which is when the coin graduated.
    pub created_at: i64,
}

impl Pool {
    /// Current layout version.
    pub const VERSION: u8 = 1;
    /// Serialized size in bytes.
    pub const LEN: usize = 3 + 7 * 32 + 2 * 8 + 3 * 2 + 8;

    /// The pool's reserves, in the form the math crate works with.
    pub const fn reserves(&self) -> PoolReserves {
        PoolReserves {
            quote: self.quote_reserve,
            token: self.token_reserve,
        }
    }

    /// Replaces the pool's reserves.
    pub fn set_reserves(&mut self, reserves: &PoolReserves) {
        self.quote_reserve = reserves.quote;
        self.token_reserve = reserves.token;
    }

    /// The swap fee split this pool was created with.
    pub const fn fee_rates(&self) -> PoolFeeRates {
        PoolFeeRates {
            lp_bps: self.lp_fee_bps,
            platform_bps: self.platform_fee_bps,
            creator_bps: self.creator_fee_bps,
        }
    }
}

/// What the launch program hands over when it creates a pool.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct InitializePoolArgs {
    /// Tokens to move from the curve into the pool.
    pub token_amount: u64,
    /// Quote to move from the curve into the pool.
    pub quote_amount: u64,
    /// The coin's creator.
    pub creator: Pubkey,
    /// Where the platform's share of swap fees goes.
    pub platform_fee_vault: Pubkey,
    /// Where the creator's share of swap fees goes.
    pub creator_fee_vault: Pubkey,
    /// Share of each swap that stays in the pool, in basis points.
    pub lp_fee_bps: u16,
    /// Platform's share of each swap, in basis points.
    pub platform_fee_bps: u16,
    /// Creator's share of each swap, in basis points.
    pub creator_fee_bps: u16,
}

/// Instructions of the pool program.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum PoolInstruction {
    /// Creates a coin's pool and pulls the curve's reserves into it. Only the
    /// launch program can call this, signing as the coin's curve, so nobody
    /// can create a coin's pool ahead of its graduation or at a price of
    /// their choosing.
    ///
    /// 0. `[writable, signer]` Payer
    /// 1. `[signer]` Curve of the coin (launch program address)
    /// 2. `[writable]` Pool
    /// 3. `[writable]` Pool token vault
    /// 4. `[writable]` Pool quote vault
    /// 5. `[writable]` Curve token vault
    /// 6. `[writable]` Curve quote vault
    /// 7. `[]` Coin mint
    /// 8. `[]` Quote mint
    /// 9. `[]` Token program
    /// 10. `[]` System program
    Initialize(InitializePoolArgs),

    /// Swaps against the pool. A buy spends at most `amount_in` quote, fee
    /// included; a sell sends exactly `amount_in` tokens. Fails if it would
    /// return less than `min_amount_out`.
    ///
    /// 0. `[signer]` Trader
    /// 1. `[writable]` Pool
    /// 2. `[writable]` Pool token vault
    /// 3. `[writable]` Pool quote vault
    /// 4. `[writable]` Trader's token account for the coin
    /// 5. `[writable]` Trader's quote token account
    /// 6. `[writable]` Platform fee vault
    /// 7. `[writable]` Creator fee vault
    /// 8. `[]` Token program
    /// 9. `[]` This program, which it calls to record its events
    Swap {
        /// True to buy the coin with quote, false to sell it for quote.
        buy: bool,
        /// Quote to spend at most (buy) or tokens to sell (sell).
        amount_in: u64,
        /// The least to accept: tokens for a buy, quote after fees for a sell.
        min_amount_out: u64,
    },
}

impl PoolInstruction {
    /// Borsh encoding of the instruction.
    pub fn pack(&self) -> Vec<u8> {
        borsh::to_vec(self).expect("pool instructions always serialize")
    }

    /// Decodes instruction data.
    pub fn unpack(data: &[u8]) -> Result<Self, ArchpadError> {
        Self::try_from_slice(data).map_err(|_| ArchpadError::InvalidInstruction)
    }
}

/// Builds [`PoolInstruction::Initialize`]. Only useful to the launch program,
/// which invokes it signing as the curve.
pub fn initialize(
    payer: &Pubkey,
    mint: &Pubkey,
    quote_mint: &Pubkey,
    args: InitializePoolArgs,
) -> Instruction {
    Instruction {
        program_id: ids::pool::ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(find_curve_address(mint).0, true),
            AccountMeta::new(find_pool_address(mint).0, false),
            AccountMeta::new(find_pool_token_vault_address(mint).0, false),
            AccountMeta::new(find_pool_quote_vault_address(mint).0, false),
            AccountMeta::new(find_token_vault_address(mint).0, false),
            AccountMeta::new(find_quote_vault_address(mint).0, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(*quote_mint, false),
            AccountMeta::new_readonly(apl_token::id(), false),
            AccountMeta::new_readonly(system_program::SYSTEM_PROGRAM_ID, false),
        ],
        data: PoolInstruction::Initialize(args).pack(),
    }
}

/// Builds [`PoolInstruction::Swap`] between the trader's associated token accounts.
pub fn swap(
    trader: &Pubkey,
    pool: &Pool,
    buy: bool,
    amount_in: u64,
    min_amount_out: u64,
) -> Instruction {
    Instruction {
        program_id: ids::pool::ID,
        accounts: vec![
            AccountMeta::new_readonly(*trader, true),
            AccountMeta::new(find_pool_address(&pool.mint).0, false),
            AccountMeta::new(pool.token_vault, false),
            AccountMeta::new(pool.quote_vault, false),
            AccountMeta::new(associated_token_address(trader, &pool.mint), false),
            AccountMeta::new(associated_token_address(trader, &pool.quote_mint), false),
            AccountMeta::new(pool.platform_fee_vault, false),
            AccountMeta::new(pool.creator_fee_vault, false),
            AccountMeta::new_readonly(apl_token::id(), false),
            AccountMeta::new_readonly(ids::pool::ID, false),
        ],
        data: PoolInstruction::Swap {
            buy,
            amount_in,
            min_amount_out,
        }
        .pack(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::tests::key, AccountTag};

    fn sample_pool() -> Pool {
        Pool {
            tag: AccountTag::Pool as u8,
            version: Pool::VERSION,
            bump: 255,
            mint: key(1),
            quote_mint: key(2),
            creator: key(3),
            token_vault: key(4),
            quote_vault: key(5),
            platform_fee_vault: key(6),
            creator_fee_vault: key(7),
            quote_reserve: 17_001_072,
            token_reserve: 206_900_000_000_000,
            lp_fee_bps: 20,
            platform_fee_bps: 5,
            creator_fee_bps: 5,
            created_at: 1_800_000_000,
        }
    }

    fn sample_args() -> InitializePoolArgs {
        InitializePoolArgs {
            token_amount: 206_900_000_000_000,
            quote_amount: 17_001_072,
            creator: key(3),
            platform_fee_vault: key(6),
            creator_fee_vault: key(7),
            lp_fee_bps: 20,
            platform_fee_bps: 5,
            creator_fee_bps: 5,
        }
    }

    #[test]
    fn declared_size_matches_the_encoding() {
        assert_eq!(borsh::to_vec(&sample_pool()).unwrap().len(), Pool::LEN);
        assert_eq!(Pool::LEN, 257);
    }

    #[test]
    fn pool_helpers_reflect_its_fields() {
        let mut pool = sample_pool();
        assert_eq!(pool.fee_rates().total_bps(), 30);
        let mut reserves = pool.reserves();
        reserves.quote += 1;
        reserves.token -= 1;
        pool.set_reserves(&reserves);
        assert_eq!(pool.reserves(), reserves);
    }

    #[test]
    fn instructions_round_trip() {
        for instruction in [
            PoolInstruction::Initialize(sample_args()),
            PoolInstruction::Swap {
                buy: true,
                amount_in: 5,
                min_amount_out: 1,
            },
            PoolInstruction::Swap {
                buy: false,
                amount_in: 5,
                min_amount_out: 1,
            },
        ] {
            assert_eq!(
                PoolInstruction::unpack(&instruction.pack()),
                Ok(instruction)
            );
        }
        assert_eq!(
            PoolInstruction::unpack(&[]),
            Err(ArchpadError::InvalidInstruction)
        );
        assert_eq!(
            PoolInstruction::unpack(&[2]),
            Err(ArchpadError::InvalidInstruction)
        );
        // A bool must be 0 or 1.
        let mut swap = PoolInstruction::Swap {
            buy: true,
            amount_in: 5,
            min_amount_out: 1,
        }
        .pack();
        swap[1] = 2;
        assert_eq!(
            PoolInstruction::unpack(&swap),
            Err(ArchpadError::InvalidInstruction)
        );
    }

    #[test]
    fn only_the_curve_can_initialise_a_pool() {
        let mint = key(1);
        let instruction = initialize(&key(9), &mint, &key(2), sample_args());
        assert_eq!(instruction.program_id, ids::pool::ID);
        assert_eq!(instruction.accounts.len(), 11);
        assert_eq!(instruction.accounts[1].pubkey, find_curve_address(&mint).0);
        assert!(instruction.accounts[1].is_signer);
        assert_eq!(instruction.accounts[2].pubkey, find_pool_address(&mint).0);
    }

    #[test]
    fn swap_uses_the_accounts_recorded_in_the_pool() {
        let pool = sample_pool();
        let instruction = swap(&key(9), &pool, true, 100, 1);
        assert_eq!(instruction.accounts.len(), 10);
        assert_eq!(instruction.accounts[9].pubkey, ids::pool::ID);
        assert_eq!(instruction.accounts[2].pubkey, pool.token_vault);
        assert_eq!(instruction.accounts[3].pubkey, pool.quote_vault);
        assert_eq!(instruction.accounts[6].pubkey, pool.platform_fee_vault);
        assert_eq!(instruction.accounts[7].pubkey, pool.creator_fee_vault);
        assert_eq!(
            instruction
                .accounts
                .iter()
                .filter(|meta| meta.is_signer)
                .count(),
            1
        );
    }

    #[test]
    fn pool_addresses_differ_from_curve_addresses_for_the_same_coin() {
        let mint = key(1);
        assert_ne!(
            find_pool_token_vault_address(&mint).0,
            find_token_vault_address(&mint).0
        );
        assert_ne!(
            find_pool_quote_vault_address(&mint).0,
            find_quote_vault_address(&mint).0
        );
        assert_ne!(find_pool_address(&mint).0, find_curve_address(&mint).0);
    }
}
