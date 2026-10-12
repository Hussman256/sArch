//! The config program's accounts and instructions.
//!
//! One account holds every tunable: the fee split, the curve shape, the launch
//! window limits and the quote assets coins may be priced in. The launch
//! program copies what it needs into each curve at creation, so a change made
//! here reaches coins launched afterwards and nothing that already exists.
//!
//! The account is governed by a set of admin keys, of which a threshold must
//! agree before anything changes. An admin proposes an action, the others
//! approve it in their own transactions, and once enough have, anyone can
//! execute it. Replacing the config additionally has to wait out a delay that
//! starts when the last needed approval lands. Pausing has no delay, because
//! it can only stop new launches, never touch funds.
//!
//! The admin keys and the threshold are themselves part of the config, so
//! changing who governs goes through the same approvals and the same delay.

use arch_program::{
    account::AccountMeta, instruction::Instruction, pubkey::Pubkey, system_program,
};
use archpad_math::{CurveParams, FeeRates, PoolFeeRates, BPS_DENOMINATOR};
use borsh::{BorshDeserialize, BorshSerialize};

use crate::{error::ArchpadError, ids, AccountTag};

/// Seed of the single config account.
pub const CONFIG_SEED: &[u8] = b"config";
/// Seed prefix of a proposal, followed by its number.
pub const PROPOSAL_SEED: &[u8] = b"proposal";

/// Quote assets the config can hold at once.
pub const MAX_QUOTE_ASSETS: usize = 8;
/// Admin keys the config can hold at once. Approvals are a bitmask over them.
pub const MAX_ADMINS: usize = 8;
/// Longest launch window in which the per-wallet cap applies (1 hour).
pub const MAX_EARLY_WINDOW_SECS: u32 = 3_600;
/// Longest delay a config change can be made to wait (30 days). Bounded so a
/// bad value cannot lock the config for good.
pub const MAX_TIMELOCK_SECS: u32 = 30 * 24 * 3_600;
/// Most decimals a launched coin may have.
pub const MAX_TOKEN_DECIMALS: u8 = 9;

/// Address of the config account.
pub fn find_config_address() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CONFIG_SEED], &ids::config::ID)
}

/// Address of proposal number `id`.
pub fn find_proposal_address(id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[PROPOSAL_SEED, &id.to_le_bytes()], &ids::config::ID)
}

/// A quote asset coins may be priced in. An all-zero mint marks an empty slot.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct QuoteAsset {
    /// The asset's APL token mint.
    pub mint: Pubkey,
    /// Starting virtual quote reserves for curves priced in this asset. With
    /// the token shape in [`LaunchParams`] this fixes both the opening price
    /// and the amount a curve raises before it graduates.
    pub virtual_quote_reserves: u64,
}

impl QuoteAsset {
    /// True when the slot is unused.
    pub fn is_empty(&self) -> bool {
        self.mint == Pubkey::default()
    }
}

/// Parameters copied into every new curve.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LaunchParams {
    /// Platform's share of each curve trade, in basis points.
    pub platform_fee_bps: u16,
    /// Creator's share of each curve trade, in basis points.
    pub creator_fee_bps: u16,
    /// Smallest share of curve supply the creator must buy in the launch
    /// transaction, in basis points.
    pub min_creator_buy_bps: u16,
    /// Most of the curve supply one wallet may buy during the launch window,
    /// in basis points.
    pub early_wallet_cap_bps: u16,
    /// Length of the launch window, in seconds.
    pub early_window_secs: u32,
    /// Decimals of launched coins.
    pub token_decimals: u8,
    /// Total supply of a launched coin, in base units.
    pub total_supply: u64,
    /// Supply sold through the curve. The rest seeds the pool at graduation.
    pub curve_supply: u64,
    /// Starting virtual token reserves.
    pub virtual_token_reserves: u64,
    /// Share of each pool swap that stays in the pool, in basis points.
    pub pool_lp_fee_bps: u16,
    /// Platform's share of each pool swap, in basis points.
    pub pool_platform_fee_bps: u16,
    /// Creator's share of each pool swap, in basis points.
    pub pool_creator_fee_bps: u16,
}

impl LaunchParams {
    /// The curve trade fee split.
    pub const fn fee_rates(&self) -> FeeRates {
        FeeRates {
            platform_bps: self.platform_fee_bps,
            creator_bps: self.creator_fee_bps,
        }
    }

    /// The pool swap fee split.
    pub const fn pool_fee_rates(&self) -> PoolFeeRates {
        PoolFeeRates {
            lp_bps: self.pool_lp_fee_bps,
            platform_bps: self.pool_platform_fee_bps,
            creator_bps: self.pool_creator_fee_bps,
        }
    }

    /// The curve shape for a quote asset.
    pub const fn curve_params(&self, quote: &QuoteAsset) -> CurveParams {
        CurveParams {
            total_supply: self.total_supply,
            curve_supply: self.curve_supply,
            virtual_token_reserves: self.virtual_token_reserves,
            virtual_quote_reserves: quote.virtual_quote_reserves,
        }
    }
}

/// The keys that govern the config, and how many of them must agree.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Admins {
    /// The admin keys, packed from the front. All zeros marks an unused slot.
    pub members: [Pubkey; MAX_ADMINS],
    /// How many of them must approve an action before it can be executed.
    pub threshold: u8,
}

impl Admins {
    /// Serialized size in bytes.
    pub const LEN: usize = MAX_ADMINS * 32 + 1;

    /// A set with the given keys and threshold. Panics on more than
    /// [`MAX_ADMINS`] keys; for building configs in clients and tests.
    pub fn new(keys: &[Pubkey], threshold: u8) -> Self {
        let mut members = [Pubkey::default(); MAX_ADMINS];
        members[..keys.len()].copy_from_slice(keys);
        Self { members, threshold }
    }

    /// How many admin keys there are.
    pub fn count(&self) -> usize {
        self.members
            .iter()
            .filter(|member| **member != Pubkey::default())
            .count()
    }

    /// Position of an admin key, which is also its bit in an approval mask.
    pub fn index_of(&self, key: &Pubkey) -> Option<usize> {
        if *key == Pubkey::default() {
            return None;
        }
        self.members.iter().position(|member| member == key)
    }

    /// True once the approvals in `mask` reach the threshold.
    pub fn is_met_by(&self, mask: u8) -> bool {
        mask.count_ones() >= u32::from(self.threshold)
    }

    /// At least one key, no gaps, no repeats, and a threshold the keys can
    /// actually reach. Anything else could leave the config with nobody able
    /// to change it.
    pub fn validate(&self) -> Result<(), ArchpadError> {
        let count = self.count();
        let packed = self.members[..count]
            .iter()
            .all(|member| *member != Pubkey::default());
        let unique = (0..count).all(|i| !self.members[..i].contains(&self.members[i]));
        let reachable = self.threshold >= 1 && usize::from(self.threshold) <= count;
        if count >= 1 && packed && unique && reachable {
            Ok(())
        } else {
            Err(ArchpadError::InvalidConfig)
        }
    }
}

/// The config: everything an approved, delayed change can set.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ConfigData {
    /// Who governs the config.
    pub admins: Admins,
    /// Wallet that receives platform fees when they are withdrawn.
    pub treasury: Pubkey,
    /// Seconds an approved config change must wait before it can be executed.
    pub timelock_secs: u32,
    /// Parameters for new launches.
    pub launch: LaunchParams,
    /// Quote assets new coins may be priced in.
    pub quotes: [QuoteAsset; MAX_QUOTE_ASSETS],
}

impl ConfigData {
    /// Serialized size in bytes.
    pub const LEN: usize = Admins::LEN + 32 + 4 + 43 + MAX_QUOTE_ASSETS * 40;

    /// Slot index of a quote asset.
    pub fn quote_index(&self, mint: &Pubkey) -> Option<usize> {
        if *mint == Pubkey::default() {
            return None;
        }
        self.quotes.iter().position(|quote| quote.mint == *mint)
    }

    /// Rejects any config a launch could not safely be created from, or that
    /// nobody could govern.
    pub fn validate(&self) -> Result<(), ArchpadError> {
        let launch = &self.launch;
        let invalid = Err(ArchpadError::InvalidConfig);

        self.admins.validate()?;
        if self.treasury == Pubkey::default() || self.timelock_secs > MAX_TIMELOCK_SECS {
            return invalid;
        }
        if launch.fee_rates().validate().is_err() || launch.pool_fee_rates().validate().is_err() {
            return invalid;
        }
        if launch.token_decimals > MAX_TOKEN_DECIMALS
            || launch.early_window_secs > MAX_EARLY_WINDOW_SECS
            || u64::from(launch.early_wallet_cap_bps) > BPS_DENOMINATOR
            // The creator's mandatory buy counts toward the cap, so a minimum
            // above the cap would make every launch impossible.
            || launch.min_creator_buy_bps > launch.early_wallet_cap_bps
        {
            return invalid;
        }

        let mut configured = 0;
        for (index, quote) in self.quotes.iter().enumerate() {
            if quote.is_empty() {
                if quote.virtual_quote_reserves != 0 {
                    return invalid;
                }
                continue;
            }
            if self.quotes[..index]
                .iter()
                .any(|earlier| earlier.mint == quote.mint)
            {
                return invalid;
            }
            if launch.curve_params(quote).validate().is_err() {
                return invalid;
            }
            configured += 1;
        }
        if configured == 0 {
            return invalid;
        }
        Ok(())
    }
}

/// The config account.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct GlobalConfig {
    /// Always [`AccountTag::GlobalConfig`].
    pub tag: u8,
    /// Layout version.
    pub version: u8,
    /// Bump of the account's address.
    pub bump: u8,
    /// When true, no new coin can be launched. Existing coins keep trading.
    pub launches_paused: bool,
    /// Bit `i` set: no new coin can be launched against quote slot `i`.
    pub paused_quotes: u8,
    /// Counts replacements of `active`. A proposal records the value it was
    /// made under and can only be approved or executed while it still matches:
    /// approvals are positions in the admin list, and a new config may have a
    /// different list.
    pub epoch: u32,
    /// How many proposals have been made. The next one takes this number.
    pub proposal_count: u64,
    /// The config in force.
    pub active: ConfigData,
}

impl GlobalConfig {
    /// Current layout version.
    pub const VERSION: u8 = 1;
    /// Serialized size in bytes.
    pub const LEN: usize = 5 + 4 + 8 + ConfigData::LEN;

    /// A freshly initialised config.
    pub fn new(bump: u8, active: ConfigData) -> Self {
        Self {
            tag: AccountTag::GlobalConfig as u8,
            version: Self::VERSION,
            bump,
            launches_paused: false,
            paused_quotes: 0,
            epoch: 0,
            proposal_count: 0,
            active,
        }
    }

    /// True when new launches against the quote slot are paused.
    pub const fn is_quote_paused(&self, index: usize) -> bool {
        index < MAX_QUOTE_ASSETS && self.paused_quotes & (1 << index) != 0
    }
}

/// Something the admins can do. This is the complete list: there is no action
/// that moves funds, touches a curve or a pool, or changes a coin that
/// already exists.
// One variant carries a whole config and the others a byte or two. That is
// the wire format, and the program keeps the value on the heap.
#[allow(clippy::large_enum_variant)]
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdminAction {
    /// Replace the config. Waits out the timelock after approval.
    SetConfig(ConfigData),
    /// Pause or resume all new launches. No delay.
    SetLaunchesPaused(bool),
    /// Pause or resume new launches against one quote asset. No delay.
    SetQuotePaused {
        /// Mint of the quote asset.
        mint: Pubkey,
        /// True to pause.
        paused: bool,
    },
}

impl AdminAction {
    /// True for the one action that has to wait out the timelock.
    pub const fn is_delayed(&self) -> bool {
        matches!(self, AdminAction::SetConfig(_))
    }
}

impl AdminAction {
    /// Serialized size in bytes.
    pub const fn encoded_len(&self) -> usize {
        match self {
            AdminAction::SetConfig(_) => 1 + ConfigData::LEN,
            AdminAction::SetLaunchesPaused(_) => 1 + 1,
            AdminAction::SetQuotePaused { .. } => 1 + 32 + 1,
        }
    }
}

/// The front of a proposal account: everything but the action itself.
///
/// Voting reads and rewrites only this part, which is why it is its own type:
/// the action behind it can be a whole config, and there is no reason to
/// unpack that to count an approval.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProposalHeader {
    /// Always [`AccountTag::Proposal`].
    pub tag: u8,
    /// Layout version.
    pub version: u8,
    /// Bump of the account's address.
    pub bump: u8,
    /// The proposal's number.
    pub id: u64,
    /// [`GlobalConfig::epoch`] when it was made.
    pub epoch: u32,
    /// The admin who made it.
    pub proposer: Pubkey,
    /// Bit `i` set: the admin at position `i` approves.
    pub approvals: u8,
    /// Unix time it was made.
    pub created_at: i64,
    /// Unix time the approvals reached the threshold, or 0 while they are
    /// short of it. The timelock counts from here.
    pub approved_at: i64,
    /// Unix time it was executed, or 0 if it has not been.
    pub executed_at: i64,
}

impl ProposalHeader {
    /// Current layout version.
    pub const VERSION: u8 = 1;
    /// Serialized size in bytes.
    pub const LEN: usize = 3 + 8 + 4 + 32 + 1 + 8 + 8 + 8;

    /// True once the proposal has been executed.
    pub const fn is_executed(&self) -> bool {
        self.executed_at != 0
    }
}

/// A proposal account: the header, then the action it proposes.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Proposal {
    /// Number, approvals and timestamps.
    pub header: ProposalHeader,
    /// What it does.
    pub action: AdminAction,
}

impl Proposal {
    /// Serialized size of the largest proposal.
    pub const MAX_LEN: usize = ProposalHeader::LEN + 1 + ConfigData::LEN;

    /// Serialized size of this proposal. Accounts are allocated to fit.
    pub const fn encoded_len(&self) -> usize {
        ProposalHeader::LEN + self.action.encoded_len()
    }
}

/// Instructions of the config program.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum ConfigInstruction {
    /// Creates the config account. Only [`ids::INITIAL_AUTHORITY`] may call
    /// this, once. That key has no say afterwards unless the config it sets
    /// lists it as an admin.
    ///
    /// 0. `[writable, signer]` Initial authority, pays for the account
    /// 1. `[writable]` Config account
    /// 2. `[]` System program
    Initialize {
        /// The starting config. Takes effect at once: there is nothing yet to protect.
        config: ConfigData,
    },

    /// Proposes an action and records the proposer's approval of it.
    ///
    /// 0. `[writable, signer]` An admin, pays for the proposal account
    /// 1. `[writable]` Config account
    /// 2. `[writable]` Proposal account, numbered [`GlobalConfig::proposal_count`]
    /// 3. `[]` System program
    Propose {
        /// What to do.
        action: AdminAction,
    },

    /// Adds the signer's approval to a proposal.
    ///
    /// 0. `[signer]` An admin
    /// 1. `[]` Config account
    /// 2. `[writable]` Proposal account
    Approve,

    /// Withdraws the signer's approval. If that takes the proposal back under
    /// the threshold, its timelock starts over the next time it is reached.
    ///
    /// 0. `[signer]` An admin
    /// 1. `[]` Config account
    /// 2. `[writable]` Proposal account
    Revoke,

    /// Carries out a proposal that has enough approvals and, for a config
    /// change, has waited out the timelock. Anyone may call it: the approvals
    /// are what authorise the action.
    ///
    /// 0. `[writable]` Config account
    /// 1. `[writable]` Proposal account
    Execute,
}

impl ConfigInstruction {
    /// Borsh encoding of the instruction.
    pub fn pack(&self) -> Vec<u8> {
        borsh::to_vec(self).expect("config instructions always serialize")
    }

    /// Decodes instruction data.
    pub fn unpack(data: &[u8]) -> Result<Self, ArchpadError> {
        Self::try_from_slice(data).map_err(|_| ArchpadError::InvalidInstruction)
    }
}

/// Builds [`ConfigInstruction::Initialize`].
pub fn initialize(initial_authority: &Pubkey, config: ConfigData) -> Instruction {
    Instruction {
        program_id: ids::config::ID,
        accounts: vec![
            AccountMeta::new(*initial_authority, true),
            AccountMeta::new(find_config_address().0, false),
            AccountMeta::new_readonly(system_program::SYSTEM_PROGRAM_ID, false),
        ],
        data: ConfigInstruction::Initialize { config }.pack(),
    }
}

/// Builds [`ConfigInstruction::Propose`] for the proposal numbered `id`, which
/// must be the config's current [`GlobalConfig::proposal_count`].
pub fn propose(admin: &Pubkey, id: u64, action: AdminAction) -> Instruction {
    Instruction {
        program_id: ids::config::ID,
        accounts: vec![
            AccountMeta::new(*admin, true),
            AccountMeta::new(find_config_address().0, false),
            AccountMeta::new(find_proposal_address(id).0, false),
            AccountMeta::new_readonly(system_program::SYSTEM_PROGRAM_ID, false),
        ],
        data: ConfigInstruction::Propose { action }.pack(),
    }
}

fn vote(admin: &Pubkey, id: u64, instruction: ConfigInstruction) -> Instruction {
    Instruction {
        program_id: ids::config::ID,
        accounts: vec![
            AccountMeta::new_readonly(*admin, true),
            AccountMeta::new_readonly(find_config_address().0, false),
            AccountMeta::new(find_proposal_address(id).0, false),
        ],
        data: instruction.pack(),
    }
}

/// Builds [`ConfigInstruction::Approve`].
pub fn approve(admin: &Pubkey, id: u64) -> Instruction {
    vote(admin, id, ConfigInstruction::Approve)
}

/// Builds [`ConfigInstruction::Revoke`].
pub fn revoke(admin: &Pubkey, id: u64) -> Instruction {
    vote(admin, id, ConfigInstruction::Revoke)
}

/// Builds [`ConfigInstruction::Execute`].
pub fn execute(id: u64) -> Instruction {
    Instruction {
        program_id: ids::config::ID,
        accounts: vec![
            AccountMeta::new(find_config_address().0, false),
            AccountMeta::new(find_proposal_address(id).0, false),
        ],
        data: ConfigInstruction::Execute.pack(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn key(byte: u8) -> Pubkey {
        Pubkey::from([byte; 32])
    }

    /// A config in the shape we expect to run: three admins of whom two must
    /// agree, the PRD's fee split and launch limits, a pump-style token, BTC
    /// and a dollar stablecoin as quotes.
    pub(crate) fn sample_config() -> ConfigData {
        let mut quotes = [QuoteAsset::default(); MAX_QUOTE_ASSETS];
        quotes[0] = QuoteAsset {
            mint: key(0xB7),
            virtual_quote_reserves: 6_000_000,
        };
        quotes[1] = QuoteAsset {
            mint: key(0xD0),
            virtual_quote_reserves: 6_000_000_000,
        };
        ConfigData {
            admins: Admins::new(&[key(0xA1), key(0xA2), key(0xA3)], 2),
            treasury: key(0x77),
            timelock_secs: 86_400,
            launch: LaunchParams {
                platform_fee_bps: 100,
                creator_fee_bps: 125,
                min_creator_buy_bps: 50,
                early_wallet_cap_bps: 200,
                early_window_secs: 10,
                token_decimals: 6,
                total_supply: 1_000_000_000_000_000,
                curve_supply: 793_100_000_000_000,
                virtual_token_reserves: 1_073_000_000_000_000,
                pool_lp_fee_bps: 20,
                pool_platform_fee_bps: 5,
                pool_creator_fee_bps: 5,
            },
            quotes,
        }
    }

    pub(crate) fn sample_proposal(action: AdminAction) -> Proposal {
        Proposal {
            header: ProposalHeader {
                tag: AccountTag::Proposal as u8,
                version: ProposalHeader::VERSION,
                bump: 255,
                id: 7,
                epoch: 3,
                proposer: key(0xA1),
                approvals: 0b011,
                created_at: 1_800_000_000,
                approved_at: 1_800_000_500,
                executed_at: 0,
            },
            action,
        }
    }

    #[test]
    fn declared_sizes_match_the_encoding() {
        assert_eq!(
            borsh::to_vec(&Admins::default()).unwrap().len(),
            Admins::LEN
        );
        assert_eq!(
            borsh::to_vec(&ConfigData::default()).unwrap().len(),
            ConfigData::LEN
        );
        assert_eq!(ConfigData::LEN, 656);
        let account = GlobalConfig::new(255, sample_config());
        assert_eq!(borsh::to_vec(&account).unwrap().len(), GlobalConfig::LEN);
        assert_eq!(GlobalConfig::LEN, 673);

        for action in [
            AdminAction::SetConfig(sample_config()),
            AdminAction::SetLaunchesPaused(true),
            AdminAction::SetQuotePaused {
                mint: key(0xB7),
                paused: true,
            },
        ] {
            let proposal = sample_proposal(action);
            let bytes = borsh::to_vec(&proposal).unwrap();
            assert_eq!(bytes.len(), proposal.encoded_len());
            assert!(proposal.encoded_len() <= Proposal::MAX_LEN);
            // The header is exactly the front of the account, so it can be
            // read and rewritten without touching the action behind it.
            assert_eq!(
                borsh::to_vec(&proposal.header).unwrap(),
                bytes[..ProposalHeader::LEN]
            );
            assert_eq!(
                ProposalHeader::deserialize(&mut &bytes[..]).unwrap(),
                proposal.header
            );
            assert_eq!(
                AdminAction::try_from_slice(&bytes[ProposalHeader::LEN..]).unwrap(),
                proposal.action
            );
        }
        assert_eq!(ProposalHeader::LEN, 72);
        assert_eq!(Proposal::MAX_LEN, 729);
    }

    /// The largest instructions, with everything else a transaction carries,
    /// must fit Arch's 1232-byte limit.
    #[test]
    fn a_config_proposal_fits_in_one_transaction() {
        for instruction in [
            initialize(&key(1), sample_config()),
            propose(&key(0xA1), 0, AdminAction::SetConfig(sample_config())),
        ] {
            let mut keys: std::collections::BTreeSet<Pubkey> = instruction
                .accounts
                .iter()
                .map(|meta| meta.pubkey)
                .collect();
            keys.insert(instruction.program_id);
            // version + signature count + one signature
            let envelope = 4 + 1 + 64;
            // header + key count + keys + blockhash + instruction count
            let message = 3 + 4 + 32 * keys.len() + 32 + 4;
            // program index + account count + indices + data length + data
            let body = 1 + 4 + instruction.accounts.len() + 4 + instruction.data.len();
            assert!(
                envelope + message + body <= 1232,
                "{}",
                envelope + message + body
            );
        }
    }

    #[test]
    fn sample_config_is_valid() {
        assert_eq!(sample_config().validate(), Ok(()));
    }

    #[test]
    fn admin_sets_must_be_usable() {
        let (a, b, c) = (key(1), key(2), key(3));
        assert_eq!(Admins::new(&[a], 1).validate(), Ok(()));
        assert_eq!(Admins::new(&[a, b, c], 2).validate(), Ok(()));
        assert_eq!(Admins::new(&[a, b, c], 3).validate(), Ok(()));
        assert_eq!(
            Admins::new(&[key(1); MAX_ADMINS], 1).validate(),
            Err(ArchpadError::InvalidConfig)
        );

        let invalid = Err(ArchpadError::InvalidConfig);
        assert_eq!(Admins::new(&[], 0).validate(), invalid, "nobody");
        assert_eq!(Admins::new(&[], 1).validate(), invalid, "nobody");
        assert_eq!(
            Admins::new(&[a, b], 0).validate(),
            invalid,
            "no approval needed"
        );
        assert_eq!(
            Admins::new(&[a, b], 3).validate(),
            invalid,
            "more approvals than admins"
        );
        assert_eq!(
            Admins::new(&[a, b, a], 2).validate(),
            invalid,
            "the same key twice"
        );

        // A gap would let a zero key count as a member.
        let mut gap = Admins::new(&[a, b], 2);
        gap.members[1] = Pubkey::default();
        gap.members[2] = b;
        assert_eq!(gap.validate(), invalid, "gap in the list");

        let mut config = sample_config();
        config.admins = Admins::new(&[a, b], 3);
        assert_eq!(config.validate(), invalid, "a config nobody could change");
    }

    #[test]
    fn admins_know_their_members_and_count_approvals() {
        let admins = Admins::new(&[key(1), key(2), key(3)], 2);
        assert_eq!(admins.count(), 3);
        assert_eq!(admins.index_of(&key(1)), Some(0));
        assert_eq!(admins.index_of(&key(3)), Some(2));
        assert_eq!(admins.index_of(&key(4)), None);
        // The zero key is an empty slot, never a member.
        assert_eq!(admins.index_of(&Pubkey::default()), None);

        assert!(!admins.is_met_by(0b000));
        assert!(!admins.is_met_by(0b100));
        assert!(admins.is_met_by(0b101));
        assert!(admins.is_met_by(0b111));
    }

    #[test]
    fn rejects_fee_and_limit_settings_that_would_hurt_launches() {
        let ok = sample_config();
        let mut cases = Vec::new();

        let mut c = ok;
        c.launch.platform_fee_bps = 600;
        c.launch.creator_fee_bps = 500;
        cases.push(("trade fee above the 10% ceiling", c));

        let mut c = ok;
        c.launch.pool_lp_fee_bps = 301;
        cases.push(("pool fee above the 3% ceiling", c));

        let mut c = ok;
        c.launch.min_creator_buy_bps = 201;
        cases.push(("creator minimum above the wallet cap", c));

        let mut c = ok;
        c.launch.early_wallet_cap_bps = 10_001;
        cases.push(("wallet cap above 100%", c));

        let mut c = ok;
        c.launch.early_window_secs = MAX_EARLY_WINDOW_SECS + 1;
        cases.push(("launch window too long", c));

        let mut c = ok;
        c.launch.token_decimals = 10;
        cases.push(("too many decimals", c));

        let mut c = ok;
        c.treasury = Pubkey::default();
        cases.push(("no treasury", c));

        let mut c = ok;
        c.timelock_secs = MAX_TIMELOCK_SECS + 1;
        cases.push(("timelock long enough to lock the config", c));

        for (why, config) in cases {
            assert_eq!(config.validate(), Err(ArchpadError::InvalidConfig), "{why}");
        }
    }

    #[test]
    fn rejects_quote_slots_that_do_not_form_a_usable_curve() {
        let ok = sample_config();

        let mut none = ok;
        none.quotes = [QuoteAsset::default(); MAX_QUOTE_ASSETS];
        assert_eq!(
            none.validate(),
            Err(ArchpadError::InvalidConfig),
            "no quote asset"
        );

        let mut duplicate = ok;
        duplicate.quotes[2] = duplicate.quotes[0];
        assert_eq!(
            duplicate.validate(),
            Err(ArchpadError::InvalidConfig),
            "duplicate mint"
        );

        let mut zero_price = ok;
        zero_price.quotes[0].virtual_quote_reserves = 0;
        assert_eq!(
            zero_price.validate(),
            Err(ArchpadError::InvalidConfig),
            "zero reserves"
        );

        let mut stray = ok;
        stray.quotes[5].virtual_quote_reserves = 1;
        assert_eq!(
            stray.validate(),
            Err(ArchpadError::InvalidConfig),
            "reserves on an empty slot"
        );

        // A token shape whose pool would open far from the curve's closing price.
        let mut discontinuous = ok;
        discontinuous.launch.total_supply = 2_000_000_000_000_000;
        assert_eq!(
            discontinuous.validate(),
            Err(ArchpadError::InvalidConfig),
            "price gap"
        );
    }

    #[test]
    fn finds_quote_slots_and_never_matches_the_empty_mint() {
        let config = sample_config();
        assert_eq!(config.quote_index(&key(0xB7)), Some(0));
        assert_eq!(config.quote_index(&key(0xD0)), Some(1));
        assert_eq!(config.quote_index(&key(0x01)), None);
        assert_eq!(config.quote_index(&Pubkey::default()), None);
    }

    #[test]
    fn quote_pause_bits() {
        let mut account = GlobalConfig::new(255, sample_config());
        assert!(!account.is_quote_paused(1));
        account.paused_quotes = 0b10;
        assert!(account.is_quote_paused(1));
        assert!(!account.is_quote_paused(0));
        assert!(!account.is_quote_paused(MAX_QUOTE_ASSETS));
    }

    #[test]
    fn instructions_round_trip() {
        for instruction in [
            ConfigInstruction::Initialize {
                config: sample_config(),
            },
            ConfigInstruction::Propose {
                action: AdminAction::SetConfig(sample_config()),
            },
            ConfigInstruction::Propose {
                action: AdminAction::SetLaunchesPaused(true),
            },
            ConfigInstruction::Propose {
                action: AdminAction::SetQuotePaused {
                    mint: key(9),
                    paused: false,
                },
            },
            ConfigInstruction::Approve,
            ConfigInstruction::Revoke,
            ConfigInstruction::Execute,
        ] {
            assert_eq!(
                ConfigInstruction::unpack(&instruction.pack()),
                Ok(instruction)
            );
        }
        assert_eq!(
            ConfigInstruction::unpack(&[]),
            Err(ArchpadError::InvalidInstruction)
        );
        assert_eq!(
            ConfigInstruction::unpack(&[99]),
            Err(ArchpadError::InvalidInstruction)
        );
        // Trailing bytes are not silently accepted.
        assert_eq!(
            ConfigInstruction::unpack(&[2, 0]),
            Err(ArchpadError::InvalidInstruction)
        );
        // Nor is an action the program does not know.
        assert_eq!(
            ConfigInstruction::unpack(&[1, 3]),
            Err(ArchpadError::InvalidInstruction)
        );
    }

    #[test]
    fn builders_target_the_config_program_and_the_numbered_proposal() {
        let admin = key(0xA1);
        let (config_address, _) = find_config_address();
        let (proposal_address, _) = find_proposal_address(4);
        assert_ne!(find_proposal_address(4).0, find_proposal_address(5).0);
        assert_ne!(proposal_address, config_address);

        let init = initialize(&admin, sample_config());
        assert_eq!(init.program_id, ids::config::ID);
        assert_eq!(init.accounts.len(), 3);
        assert!(init.accounts[0].is_signer && init.accounts[0].is_writable);
        assert_eq!(init.accounts[1].pubkey, config_address);

        let proposed = propose(&admin, 4, AdminAction::SetLaunchesPaused(true));
        assert_eq!(proposed.program_id, ids::config::ID);
        assert_eq!(proposed.accounts[0], AccountMeta::new(admin, true));
        assert_eq!(
            proposed.accounts[1],
            AccountMeta::new(config_address, false)
        );
        assert_eq!(
            proposed.accounts[2],
            AccountMeta::new(proposal_address, false)
        );
        assert_eq!(proposed.accounts.len(), 4);

        for instruction in [approve(&admin, 4), revoke(&admin, 4)] {
            assert_eq!(instruction.program_id, ids::config::ID);
            assert_eq!(
                instruction.accounts[0],
                AccountMeta::new_readonly(admin, true)
            );
            // A vote cannot change the config, only the proposal.
            assert_eq!(
                instruction.accounts[1],
                AccountMeta::new_readonly(config_address, false)
            );
            assert_eq!(
                instruction.accounts[2],
                AccountMeta::new(proposal_address, false)
            );
        }

        // Executing needs nobody's signature.
        let executed = execute(4);
        assert_eq!(executed.accounts.len(), 2);
        assert!(executed
            .accounts
            .iter()
            .all(|meta| !meta.is_signer && meta.is_writable));
        assert_eq!(executed.accounts[1].pubkey, proposal_address);
    }
}
