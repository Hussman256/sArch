//! The fee vault program's addresses and instructions.
//!
//! Trade fees never pass through anyone's wallet on the way. Each trade pays
//! them straight into token accounts held by this program: one per quote asset
//! for the platform, one per coin for its creator. A creator can take their
//! balance at any time; the platform's balance can only go to the treasury
//! named in the config.

use arch_program::{
    account::AccountMeta, instruction::Instruction, pubkey::Pubkey, system_program,
};
use borsh::{BorshDeserialize, BorshSerialize};

use crate::{config::find_config_address, error::ArchpadError, ids, launch::find_curve_address};

/// Seed of the address that holds authority over every fee vault.
pub const VAULT_AUTHORITY_SEED: &[u8] = b"authority";
/// Seed prefix of a platform fee vault, followed by the quote mint.
pub const PLATFORM_VAULT_SEED: &[u8] = b"platform";
/// Seed prefix of a creator fee vault, followed by the coin's mint.
pub const CREATOR_VAULT_SEED: &[u8] = b"creator";

/// The address that owns every fee vault's tokens. Only the fee vault program
/// can sign for it.
pub fn find_vault_authority_address() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_AUTHORITY_SEED], &ids::fees::ID)
}

/// The platform's fee vault for a quote asset.
pub fn find_platform_vault_address(quote_mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[PLATFORM_VAULT_SEED, quote_mint.as_ref()], &ids::fees::ID)
}

/// The creator's fee vault for a coin. It holds the coin's quote asset.
pub fn find_creator_vault_address(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CREATOR_VAULT_SEED, mint.as_ref()], &ids::fees::ID)
}

/// Instructions of the fee vault program.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum FeesInstruction {
    /// Creates the platform's vault for a quote asset. Anyone may call it: the
    /// address and contents are fixed by the mint, so there is nothing to abuse.
    ///
    /// 0. `[writable, signer]` Payer
    /// 1. `[writable]` Platform vault
    /// 2. `[]` Quote mint
    /// 3. `[]` Vault authority
    /// 4. `[]` Token program
    /// 5. `[]` System program
    InitPlatformVault,

    /// Creates a coin's creator vault. Only the launch program can call it,
    /// signing as the coin's curve, so a vault cannot be planted ahead of a
    /// launch with the wrong quote asset.
    ///
    /// 0. `[writable, signer]` Payer
    /// 1. `[signer]` Curve of the coin (launch program address)
    /// 2. `[writable]` Creator vault
    /// 3. `[]` Coin mint
    /// 4. `[]` Quote mint
    /// 5. `[]` Vault authority
    /// 6. `[]` Token program
    /// 7. `[]` System program
    InitCreatorVault,

    /// Pays a coin's accrued creator fees to an account the creator chooses.
    ///
    /// 0. `[signer]` Creator
    /// 1. `[]` Curve of the coin
    /// 2. `[writable]` Creator vault
    /// 3. `[writable]` Destination token account
    /// 4. `[]` Vault authority
    /// 5. `[]` Token program
    /// 6. `[]` This program, which it calls to record its events
    ClaimCreatorFees,

    /// Sends a platform vault's balance to the treasury's token account.
    /// Anyone may call it: the money can only go to the treasury.
    ///
    /// 0. `[]` Config account
    /// 1. `[writable]` Platform vault
    /// 2. `[writable]` Token account owned by the treasury
    /// 3. `[]` Vault authority
    /// 4. `[]` Token program
    /// 5. `[]` This program, which it calls to record its events
    WithdrawPlatformFees,
}

impl FeesInstruction {
    /// Borsh encoding of the instruction.
    pub fn pack(&self) -> Vec<u8> {
        borsh::to_vec(self).expect("fee instructions always serialize")
    }

    /// Decodes instruction data.
    pub fn unpack(data: &[u8]) -> Result<Self, ArchpadError> {
        Self::try_from_slice(data).map_err(|_| ArchpadError::InvalidInstruction)
    }
}

/// Builds [`FeesInstruction::InitPlatformVault`].
pub fn init_platform_vault(payer: &Pubkey, quote_mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: ids::fees::ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(find_platform_vault_address(quote_mint).0, false),
            AccountMeta::new_readonly(*quote_mint, false),
            AccountMeta::new_readonly(find_vault_authority_address().0, false),
            AccountMeta::new_readonly(apl_token::id(), false),
            AccountMeta::new_readonly(system_program::SYSTEM_PROGRAM_ID, false),
        ],
        data: FeesInstruction::InitPlatformVault.pack(),
    }
}

/// Builds [`FeesInstruction::InitCreatorVault`]. Only useful to the launch
/// program, which invokes it signing as the curve.
pub fn init_creator_vault(payer: &Pubkey, mint: &Pubkey, quote_mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: ids::fees::ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(find_curve_address(mint).0, true),
            AccountMeta::new(find_creator_vault_address(mint).0, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(*quote_mint, false),
            AccountMeta::new_readonly(find_vault_authority_address().0, false),
            AccountMeta::new_readonly(apl_token::id(), false),
            AccountMeta::new_readonly(system_program::SYSTEM_PROGRAM_ID, false),
        ],
        data: FeesInstruction::InitCreatorVault.pack(),
    }
}

/// Builds [`FeesInstruction::ClaimCreatorFees`].
pub fn claim_creator_fees(creator: &Pubkey, mint: &Pubkey, destination: &Pubkey) -> Instruction {
    Instruction {
        program_id: ids::fees::ID,
        accounts: vec![
            AccountMeta::new_readonly(*creator, true),
            AccountMeta::new_readonly(find_curve_address(mint).0, false),
            AccountMeta::new(find_creator_vault_address(mint).0, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(find_vault_authority_address().0, false),
            AccountMeta::new_readonly(apl_token::id(), false),
            AccountMeta::new_readonly(ids::fees::ID, false),
        ],
        data: FeesInstruction::ClaimCreatorFees.pack(),
    }
}

/// Builds [`FeesInstruction::WithdrawPlatformFees`].
pub fn withdraw_platform_fees(quote_mint: &Pubkey, treasury_token_account: &Pubkey) -> Instruction {
    Instruction {
        program_id: ids::fees::ID,
        accounts: vec![
            AccountMeta::new_readonly(find_config_address().0, false),
            AccountMeta::new(find_platform_vault_address(quote_mint).0, false),
            AccountMeta::new(*treasury_token_account, false),
            AccountMeta::new_readonly(find_vault_authority_address().0, false),
            AccountMeta::new_readonly(apl_token::id(), false),
            AccountMeta::new_readonly(ids::fees::ID, false),
        ],
        data: FeesInstruction::WithdrawPlatformFees.pack(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::tests::key;

    #[test]
    fn instructions_round_trip() {
        for instruction in [
            FeesInstruction::InitPlatformVault,
            FeesInstruction::InitCreatorVault,
            FeesInstruction::ClaimCreatorFees,
            FeesInstruction::WithdrawPlatformFees,
        ] {
            assert_eq!(
                FeesInstruction::unpack(&instruction.pack()),
                Ok(instruction)
            );
        }
        assert_eq!(
            FeesInstruction::unpack(&[]),
            Err(ArchpadError::InvalidInstruction)
        );
        assert_eq!(
            FeesInstruction::unpack(&[4]),
            Err(ArchpadError::InvalidInstruction)
        );
        assert_eq!(
            FeesInstruction::unpack(&[0, 0]),
            Err(ArchpadError::InvalidInstruction)
        );
    }

    #[test]
    fn vault_addresses_are_distinct_per_mint_and_per_kind() {
        let (a, b) = (key(1), key(2));
        assert_ne!(
            find_platform_vault_address(&a).0,
            find_platform_vault_address(&b).0
        );
        assert_ne!(
            find_creator_vault_address(&a).0,
            find_creator_vault_address(&b).0
        );
        // The same mint as a quote asset and as a coin gets different vaults.
        assert_ne!(
            find_platform_vault_address(&a).0,
            find_creator_vault_address(&a).0
        );
    }

    #[test]
    fn creator_vault_can_only_be_initialised_by_the_curve() {
        let instruction = init_creator_vault(&key(1), &key(2), &key(3));
        assert_eq!(
            instruction.accounts[1].pubkey,
            find_curve_address(&key(2)).0
        );
        assert!(instruction.accounts[1].is_signer);
    }

    #[test]
    fn claim_and_withdraw_take_no_amount() {
        // Both move the whole balance, so there is no argument to get wrong.
        assert_eq!(claim_creator_fees(&key(1), &key(2), &key(3)).data.len(), 1);
        assert_eq!(withdraw_platform_fees(&key(2), &key(3)).data.len(), 1);
    }
}
