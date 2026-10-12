//! Events the programs record for the indexer.
//!
//! An event is not a log line. A node keeps only the first ten kilobytes of a
//! transaction's log, so anyone can push a trade's log line past the cut by
//! packing enough other output into the same transaction, and an indexer
//! reading logs would never see that trade.
//!
//! Instead each program calls itself: one extra instruction, [`EVENT_IX_TAG`]
//! followed by the Borsh encoding of an [`Event`], signed by an address only
//! that program can sign for. The node records every cross-program call a
//! transaction makes, in full, alongside its result, and that record is what
//! the indexer reads. The instruction does nothing except check the signature,
//! so a forged event cannot be recorded: without the signature the call
//! fails, and the whole transaction with it.

use arch_program::{account::AccountMeta, instruction::Instruction, pubkey::Pubkey};
use borsh::{BorshDeserialize, BorshSerialize};

use crate::{
    fees::find_vault_authority_address, ids, launch::find_curve_address, pool::find_pool_address,
};

/// First byte of an event instruction's data. Chosen well clear of the
/// ordinary instruction tags, which count up from zero.
pub const EVENT_IX_TAG: u8 = 0xE7;

/// Something the indexer needs to know happened.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// A coin was launched. Its name, image and curve parameters are in its
    /// metadata and curve accounts.
    CoinCreated {
        /// The coin's mint.
        mint: Pubkey,
        /// Who launched it.
        creator: Pubkey,
        /// The asset it is priced in.
        quote_mint: Pubkey,
        /// Unix time of the launch.
        timestamp: i64,
    },

    /// A buy or sell settled against a curve.
    Trade {
        /// The coin's mint.
        mint: Pubkey,
        /// The wallet that traded.
        trader: Pubkey,
        /// True for a buy.
        is_buy: bool,
        /// Quote that entered (buy) or left (sell) the curve. This is the
        /// trade's volume, and the amount the fee was charged on.
        quote_amount: u64,
        /// Tokens the trader received (buy) or sold (sell).
        token_amount: u64,
        /// Fee paid to the platform, in quote.
        platform_fee: u64,
        /// Fee paid to the creator, in quote.
        creator_fee: u64,
        /// Curve reserves after the trade.
        virtual_quote: u64,
        /// Curve reserves after the trade.
        virtual_token: u64,
        /// Curve reserves after the trade.
        real_quote: u64,
        /// Curve reserves after the trade.
        real_token: u64,
        /// Unix time of the trade.
        timestamp: i64,
    },

    /// A curve sold out and its reserves moved into the coin's pool.
    Graduated {
        /// The coin's mint.
        mint: Pubkey,
        /// The pool it graduated into.
        pool: Pubkey,
        /// Quote moved into the pool.
        quote_amount: u64,
        /// Tokens moved into the pool.
        token_amount: u64,
        /// Unix time of graduation.
        timestamp: i64,
    },

    /// A swap settled against a pool.
    PoolSwap {
        /// The coin's mint.
        mint: Pubkey,
        /// The wallet that traded.
        trader: Pubkey,
        /// True for a buy.
        is_buy: bool,
        /// Quote that moved the price. The swap's volume.
        quote_amount: u64,
        /// Tokens the trader received (buy) or sold (sell).
        token_amount: u64,
        /// Fee kept by the pool, in quote.
        lp_fee: u64,
        /// Fee paid to the platform, in quote.
        platform_fee: u64,
        /// Fee paid to the creator, in quote.
        creator_fee: u64,
        /// Pool reserves after the swap.
        quote_reserve: u64,
        /// Pool reserves after the swap.
        token_reserve: u64,
        /// Unix time of the swap.
        timestamp: i64,
    },

    /// A creator took their accrued fees for a coin.
    CreatorFeesClaimed {
        /// The coin's mint.
        mint: Pubkey,
        /// The creator.
        creator: Pubkey,
        /// Quote paid out.
        amount: u64,
        /// Unix time of the claim.
        timestamp: i64,
    },

    /// Platform fees for a quote asset were sent to the treasury.
    PlatformFeesWithdrawn {
        /// The quote asset.
        quote_mint: Pubkey,
        /// Quote paid out.
        amount: u64,
        /// Unix time of the withdrawal.
        timestamp: i64,
    },
}

impl Event {
    /// Borsh encoding of the event.
    pub fn pack(&self) -> Vec<u8> {
        borsh::to_vec(self).expect("events always serialize")
    }

    /// Decodes an event from its Borsh encoding.
    pub fn unpack(data: &[u8]) -> Option<Self> {
        Self::try_from_slice(data).ok()
    }

    /// Decodes an event from the data of an event instruction.
    pub fn from_instruction_data(data: &[u8]) -> Option<Self> {
        match data.split_first() {
            Some((&EVENT_IX_TAG, event)) => Self::unpack(event),
            _ => None,
        }
    }

    /// The program that records this kind of event, and the address that has
    /// to sign for it: the coin's curve, the coin's pool, or the fee vault
    /// authority. Each is derived from the program's own ID, so only that
    /// program can produce the signature.
    pub fn source(&self) -> (Pubkey, Pubkey) {
        match self {
            Event::CoinCreated { mint, .. }
            | Event::Trade { mint, .. }
            | Event::Graduated { mint, .. } => (ids::launch::ID, find_curve_address(mint).0),
            Event::PoolSwap { mint, .. } => (ids::pool::ID, find_pool_address(mint).0),
            Event::CreatorFeesClaimed { .. } | Event::PlatformFeesWithdrawn { .. } => {
                (ids::fees::ID, find_vault_authority_address().0)
            }
        }
    }

    /// The instruction that records this event: a call from `program` to
    /// itself, signed by `authority`.
    pub fn instruction(&self, program: &Pubkey, authority: &Pubkey) -> Instruction {
        let mut data = vec![EVENT_IX_TAG];
        data.extend_from_slice(&self.pack());
        Instruction {
            program_id: *program,
            accounts: vec![AccountMeta::new_readonly(*authority, true)],
            data,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::tests::key;

    fn samples() -> Vec<Event> {
        vec![
            Event::CoinCreated {
                mint: key(1),
                creator: key(2),
                quote_mint: key(3),
                timestamp: i64::MAX,
            },
            Event::Trade {
                mint: key(1),
                trader: key(2),
                is_buy: true,
                quote_amount: u64::MAX,
                token_amount: u64::MAX,
                platform_fee: u64::MAX,
                creator_fee: u64::MAX,
                virtual_quote: u64::MAX,
                virtual_token: u64::MAX,
                real_quote: u64::MAX,
                real_token: u64::MAX,
                timestamp: i64::MAX,
            },
            Event::Graduated {
                mint: key(1),
                pool: key(2),
                quote_amount: u64::MAX,
                token_amount: u64::MAX,
                timestamp: i64::MAX,
            },
            Event::PoolSwap {
                mint: key(1),
                trader: key(2),
                is_buy: false,
                quote_amount: u64::MAX,
                token_amount: u64::MAX,
                lp_fee: u64::MAX,
                platform_fee: u64::MAX,
                creator_fee: u64::MAX,
                quote_reserve: u64::MAX,
                token_reserve: u64::MAX,
                timestamp: i64::MAX,
            },
            Event::CreatorFeesClaimed {
                mint: key(1),
                creator: key(2),
                amount: u64::MAX,
                timestamp: i64::MAX,
            },
            Event::PlatformFeesWithdrawn {
                quote_mint: key(1),
                amount: u64::MAX,
                timestamp: i64::MAX,
            },
        ]
    }

    #[test]
    fn event_instructions_round_trip_and_name_their_signer() {
        for event in samples() {
            let (program, authority) = event.source();
            let instruction = event.instruction(&program, &authority);
            assert_eq!(instruction.program_id, program);
            assert_eq!(instruction.data[0], EVENT_IX_TAG);
            assert_eq!(Event::from_instruction_data(&instruction.data), Some(event));
            // One account: the signer, read-only.
            assert_eq!(instruction.accounts.len(), 1);
            assert!(instruction.accounts[0].is_signer);
            assert!(!instruction.accounts[0].is_writable);
            assert_eq!(instruction.accounts[0].pubkey, authority);
        }
        // Ordinary instruction data is never mistaken for an event.
        assert_eq!(Event::from_instruction_data(&[]), None);
        assert_eq!(Event::from_instruction_data(&[0, 1, 2]), None);
        assert_eq!(Event::from_instruction_data(&samples()[0].pack()), None);
    }

    #[test]
    fn each_kind_of_event_belongs_to_one_program() {
        use crate::ids;
        let programs: Vec<Pubkey> = samples().iter().map(|event| event.source().0).collect();
        assert_eq!(
            programs,
            vec![
                ids::launch::ID,
                ids::launch::ID,
                ids::launch::ID,
                ids::pool::ID,
                ids::fees::ID,
                ids::fees::ID,
            ]
        );
        // A coin's events are signed by that coin's own curve or pool.
        let (_, curve_one) = Event::Graduated {
            mint: key(1),
            pool: key(2),
            quote_amount: 1,
            token_amount: 1,
            timestamp: 0,
        }
        .source();
        let (_, curve_two) = Event::Graduated {
            mint: key(3),
            pool: key(2),
            quote_amount: 1,
            token_amount: 1,
            timestamp: 0,
        }
        .source();
        assert_ne!(curve_one, curve_two);
    }

    #[test]
    fn events_round_trip() {
        for event in samples() {
            assert_eq!(Event::unpack(&event.pack()), Some(event));
        }
        assert_eq!(Event::unpack(&[]), None);
        assert_eq!(Event::unpack(&[200]), None);
        // A truncated line decodes to nothing rather than to a wrong event.
        let mut truncated = samples()[1].pack();
        truncated.truncate(truncated.len() - 1);
        assert_eq!(Event::unpack(&truncated), None);
    }

    #[test]
    fn event_tags_are_stable() {
        // The indexer and SDK decode by these leading bytes.
        let tags: Vec<u8> = samples().iter().map(|event| event.pack()[0]).collect();
        assert_eq!(tags, vec![0, 1, 2, 3, 4, 5]);
    }
}
