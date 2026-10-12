//! The rules of governing the config.
//!
//! These are plain functions over the config and a proposal: no accounts, no
//! clock, no cross-program calls. The processor does the account plumbing and
//! calls in here, which keeps every rule about who may change what, and when,
//! testable off-chain.

use arch_program::pubkey::Pubkey;
use archpad_interface::{
    config::{AdminAction, GlobalConfig, ProposalHeader, MAX_QUOTE_ASSETS},
    AccountTag, ArchpadError,
};

/// The signer's position among the admins, which is also their approval bit.
fn admin_bit(config: &GlobalConfig, signer: &Pubkey) -> Result<u8, ArchpadError> {
    config
        .active
        .admins
        .index_of(signer)
        .map(|index| 1u8 << index)
        .ok_or(ArchpadError::NotAnAdmin)
}

/// A proposal can be voted on or executed only once, and only under the config
/// it was made against: its approvals are positions in that config's admin
/// list, and would mean other people under another.
fn require_open(config: &GlobalConfig, proposal: &ProposalHeader) -> Result<(), ArchpadError> {
    if proposal.is_executed() {
        return Err(ArchpadError::ProposalExecuted);
    }
    if proposal.epoch != config.epoch {
        return Err(ArchpadError::ProposalStale);
    }
    Ok(())
}

/// Checks an action makes sense against the config as it stands.
fn require_sound(config: &GlobalConfig, action: &AdminAction) -> Result<(), ArchpadError> {
    match action {
        AdminAction::SetConfig(next) => next.validate(),
        AdminAction::SetLaunchesPaused(_) => Ok(()),
        AdminAction::SetQuotePaused { mint, .. } => config
            .active
            .quote_index(mint)
            .map(drop)
            .ok_or(ArchpadError::UnknownQuoteAsset),
    }
}

/// Zero means "not yet", so a real time of zero is recorded as one.
fn stamp(now: i64) -> i64 {
    now.max(1)
}

/// Opens a proposal for `action` with the proposer's own approval on it, and
/// takes the next proposal number.
pub fn propose(
    config: &mut GlobalConfig,
    proposer: &Pubkey,
    action: &AdminAction,
    bump: u8,
    now: i64,
) -> Result<ProposalHeader, ArchpadError> {
    let approvals = admin_bit(config, proposer)?;
    require_sound(config, action)?;

    let id = config.proposal_count;
    config.proposal_count = id.checked_add(1).ok_or(ArchpadError::MathOverflow)?;
    Ok(ProposalHeader {
        tag: AccountTag::Proposal as u8,
        version: ProposalHeader::VERSION,
        bump,
        id,
        epoch: config.epoch,
        proposer: *proposer,
        approvals,
        created_at: now,
        // With a threshold of one, the proposer's approval is already enough.
        approved_at: if config.active.admins.is_met_by(approvals) {
            stamp(now)
        } else {
            0
        },
        executed_at: 0,
    })
}

/// Adds an admin's approval. The timelock starts when the threshold is first
/// reached, not when the proposal was made: a proposal one person staged long
/// ago gives nobody notice that it is about to happen.
pub fn approve(
    config: &GlobalConfig,
    proposal: &mut ProposalHeader,
    admin: &Pubkey,
    now: i64,
) -> Result<(), ArchpadError> {
    require_open(config, proposal)?;
    let bit = admin_bit(config, admin)?;
    if proposal.approvals & bit != 0 {
        return Err(ArchpadError::AlreadyApproved);
    }
    proposal.approvals |= bit;
    if proposal.approved_at == 0 && config.active.admins.is_met_by(proposal.approvals) {
        proposal.approved_at = stamp(now);
    }
    Ok(())
}

/// Withdraws an admin's approval. Falling back under the threshold resets the
/// timelock, so the delay always runs in full from the last time enough
/// admins agreed.
pub fn revoke(
    config: &GlobalConfig,
    proposal: &mut ProposalHeader,
    admin: &Pubkey,
) -> Result<(), ArchpadError> {
    require_open(config, proposal)?;
    let bit = admin_bit(config, admin)?;
    if proposal.approvals & bit == 0 {
        return Err(ArchpadError::NotApproved);
    }
    proposal.approvals &= !bit;
    if !config.active.admins.is_met_by(proposal.approvals) {
        proposal.approved_at = 0;
    }
    Ok(())
}

/// Carries out an approved proposal. A config change must also have waited
/// out the timelock of the config it replaces, so shortening the timelock is
/// itself subject to the current one.
pub fn execute(
    config: &mut GlobalConfig,
    proposal: &mut ProposalHeader,
    action: &AdminAction,
    now: i64,
) -> Result<(), ArchpadError> {
    require_open(config, proposal)?;
    if proposal.approved_at == 0 || !config.active.admins.is_met_by(proposal.approvals) {
        return Err(ArchpadError::NotEnoughApprovals);
    }
    let delay = if action.is_delayed() {
        i64::from(config.active.timelock_secs)
    } else {
        0
    };
    let ready_at = proposal
        .approved_at
        .checked_add(delay)
        .ok_or(ArchpadError::MathOverflow)?;
    if now < ready_at {
        return Err(ArchpadError::TimelockNotElapsed);
    }
    // The config may have moved on since the proposal was made (a quote asset
    // paused, say), so check again that the action still makes sense.
    require_sound(config, action)?;

    match action {
        AdminAction::SetConfig(next) => {
            // Pause bits belong to a mint, not to a slot. Carry each one over
            // to wherever its mint now sits, and drop it if the mint is gone.
            let mut paused_quotes = 0u8;
            for (index, quote) in config.active.quotes.iter().enumerate() {
                if config.is_quote_paused(index) {
                    if let Some(new_index) = next.quote_index(&quote.mint) {
                        paused_quotes |= 1 << new_index;
                    }
                }
            }
            config.active = *next;
            config.paused_quotes = paused_quotes;
            // Every other open proposal was approved by positions in the old
            // admin list. Moving the epoch on retires them all.
            config.epoch = config
                .epoch
                .checked_add(1)
                .ok_or(ArchpadError::MathOverflow)?;
        }
        AdminAction::SetLaunchesPaused(paused) => config.launches_paused = *paused,
        AdminAction::SetQuotePaused { mint, paused } => {
            let index = config
                .active
                .quote_index(mint)
                .ok_or(ArchpadError::UnknownQuoteAsset)?;
            debug_assert!(index < MAX_QUOTE_ASSETS);
            if *paused {
                config.paused_quotes |= 1 << index;
            } else {
                config.paused_quotes &= !(1 << index);
            }
        }
    }
    proposal.executed_at = stamp(now);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use archpad_interface::config::{Admins, ConfigData, LaunchParams, QuoteAsset};

    const ALICE: Pubkey = Pubkey::new_from_array([0xA1; 32]);
    const BOB: Pubkey = Pubkey::new_from_array([0xA2; 32]);
    const CAROL: Pubkey = Pubkey::new_from_array([0xA3; 32]);
    const STRANGER: Pubkey = Pubkey::new_from_array([2; 32]);
    const BTC: Pubkey = Pubkey::new_from_array([0xB7; 32]);
    const USD: Pubkey = Pubkey::new_from_array([0xD0; 32]);
    const DAY: i64 = 86_400;
    const T0: i64 = 1_800_000_000;

    /// Three admins, any two of whom can act, and a one-day timelock.
    fn data() -> ConfigData {
        let mut quotes = [QuoteAsset::default(); MAX_QUOTE_ASSETS];
        quotes[0] = QuoteAsset {
            mint: BTC,
            virtual_quote_reserves: 6_000_000,
        };
        quotes[1] = QuoteAsset {
            mint: USD,
            virtual_quote_reserves: 6_000_000_000,
        };
        ConfigData {
            admins: Admins::new(&[ALICE, BOB, CAROL], 2),
            treasury: Pubkey::new_from_array([0x77; 32]),
            timelock_secs: DAY as u32,
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

    fn config() -> GlobalConfig {
        GlobalConfig::new(255, data())
    }

    fn cheaper() -> AdminAction {
        let mut next = data();
        next.launch.platform_fee_bps = 50;
        AdminAction::SetConfig(next)
    }

    const PAUSE: AdminAction = AdminAction::SetLaunchesPaused(true);

    /// Proposes `action` as Alice and has Bob approve it at `approved`.
    fn approved(config: &mut GlobalConfig, action: &AdminAction, approved: i64) -> ProposalHeader {
        let mut proposal = propose(config, &ALICE, action, 255, T0).unwrap();
        approve(config, &mut proposal, &BOB, approved).unwrap();
        proposal
    }

    #[test]
    fn one_admin_alone_cannot_change_anything() {
        let mut config = config();
        let action = cheaper();
        let mut proposal = propose(&mut config, &ALICE, &action, 255, T0).unwrap();
        assert_eq!(proposal.approvals, 0b001);
        assert_eq!(proposal.approved_at, 0);

        // However long Alice waits, her approval alone is not enough.
        assert_eq!(
            execute(&mut config, &mut proposal, &action, T0 + 100 * DAY),
            Err(ArchpadError::NotEnoughApprovals)
        );
        // Nor can she approve twice to make up the numbers.
        assert_eq!(
            approve(&config, &mut proposal, &ALICE, T0),
            Err(ArchpadError::AlreadyApproved)
        );
        assert_eq!(config.active, data());
        assert_eq!(config.epoch, 0);

        // The same goes for a pause.
        let mut pause = propose(&mut config, &ALICE, &PAUSE, 255, T0).unwrap();
        assert_eq!(
            execute(&mut config, &mut pause, &PAUSE, T0),
            Err(ArchpadError::NotEnoughApprovals)
        );
        assert!(!config.launches_paused);
    }

    #[test]
    fn a_config_change_needs_the_threshold_and_then_the_timelock() {
        let mut config = config();
        let action = cheaper();
        // Alice proposes at T0; Bob approves half a day later.
        let mut proposal = approved(&mut config, &action, T0 + DAY / 2);
        assert_eq!(proposal.approvals, 0b011);
        assert_eq!(proposal.approved_at, T0 + DAY / 2);

        // The delay counts from the approval that reached the threshold, not
        // from when the proposal was made.
        assert_eq!(
            execute(&mut config, &mut proposal, &action, T0 + DAY),
            Err(ArchpadError::TimelockNotElapsed)
        );
        assert_eq!(
            execute(&mut config, &mut proposal, &action, T0 + DAY / 2 + DAY - 1),
            Err(ArchpadError::TimelockNotElapsed)
        );
        assert_eq!(config.active, data());

        execute(&mut config, &mut proposal, &action, T0 + DAY / 2 + DAY).unwrap();
        assert_eq!(config.active.launch.platform_fee_bps, 50);
        assert_eq!(config.epoch, 1);
        assert_eq!(proposal.executed_at, T0 + DAY / 2 + DAY);

        // Done is done.
        assert_eq!(
            execute(&mut config, &mut proposal, &action, T0 + 10 * DAY),
            Err(ArchpadError::ProposalExecuted)
        );
        assert_eq!(
            approve(&config, &mut proposal, &CAROL, T0),
            Err(ArchpadError::ProposalExecuted)
        );
        assert_eq!(
            revoke(&config, &mut proposal, &ALICE),
            Err(ArchpadError::ProposalExecuted)
        );
    }

    #[test]
    fn a_pause_needs_the_threshold_but_no_delay() {
        let mut config = config();
        let mut proposal = approved(&mut config, &PAUSE, T0 + 5);
        execute(&mut config, &mut proposal, &PAUSE, T0 + 5).unwrap();
        assert!(config.launches_paused);
        // A pause is not a new config: the epoch, and with it every other
        // open proposal, is untouched.
        assert_eq!(config.epoch, 0);

        let resume = AdminAction::SetLaunchesPaused(false);
        let mut proposal = approved(&mut config, &resume, T0 + 6);
        execute(&mut config, &mut proposal, &resume, T0 + 6).unwrap();
        assert!(!config.launches_paused);
    }

    #[test]
    fn strangers_have_no_say() {
        let mut config = config();
        let not_admin = Err(ArchpadError::NotAnAdmin);
        assert_eq!(
            propose(&mut config, &STRANGER, &PAUSE, 255, T0).map(drop),
            not_admin
        );
        // The zero key marks an empty admin slot. It is nobody.
        assert_eq!(
            propose(&mut config, &Pubkey::default(), &PAUSE, 255, T0).map(drop),
            not_admin
        );
        // A refused proposal does not use up a number.
        assert_eq!(config.proposal_count, 0);

        let mut proposal = propose(&mut config, &ALICE, &PAUSE, 255, T0).unwrap();
        assert_eq!(approve(&config, &mut proposal, &STRANGER, T0), not_admin);
        assert_eq!(revoke(&config, &mut proposal, &STRANGER), not_admin);
        assert_eq!(proposal.approvals, 0b001);
    }

    #[test]
    fn proposals_are_numbered_in_order() {
        let mut config = config();
        let first = propose(&mut config, &ALICE, &PAUSE, 255, T0).unwrap();
        let second = propose(&mut config, &BOB, &cheaper(), 254, T0 + 1).unwrap();
        assert_eq!((first.id, second.id), (0, 1));
        assert_eq!(config.proposal_count, 2);
        assert_eq!(second.proposer, BOB);
        assert_eq!(second.approvals, 0b010);
        assert_eq!(second.bump, 254);
        assert_eq!(second.created_at, T0 + 1);
        assert_eq!(second.tag, AccountTag::Proposal as u8);
    }

    #[test]
    fn an_invalid_action_is_refused_when_proposed() {
        let mut config = config();
        let mut greedy = data();
        greedy.launch.platform_fee_bps = 900;
        greedy.launch.creator_fee_bps = 200;
        assert_eq!(
            propose(
                &mut config,
                &ALICE,
                &AdminAction::SetConfig(greedy),
                255,
                T0
            )
            .map(drop),
            Err(ArchpadError::InvalidConfig)
        );

        // A config that would leave nobody able to govern.
        let mut locked_out = data();
        locked_out.admins = Admins::new(&[ALICE, BOB], 3);
        assert_eq!(
            propose(
                &mut config,
                &ALICE,
                &AdminAction::SetConfig(locked_out),
                255,
                T0
            )
            .map(drop),
            Err(ArchpadError::InvalidConfig)
        );

        let unknown = AdminAction::SetQuotePaused {
            mint: STRANGER,
            paused: true,
        };
        assert_eq!(
            propose(&mut config, &ALICE, &unknown, 255, T0).map(drop),
            Err(ArchpadError::UnknownQuoteAsset)
        );
        let empty = AdminAction::SetQuotePaused {
            mint: Pubkey::default(),
            paused: true,
        };
        assert_eq!(
            propose(&mut config, &ALICE, &empty, 255, T0).map(drop),
            Err(ArchpadError::UnknownQuoteAsset)
        );
        assert_eq!(config.proposal_count, 0);
    }

    #[test]
    fn withdrawing_an_approval_stops_the_clock_and_restarts_it_from_scratch() {
        let mut config = config();
        let action = cheaper();
        let mut proposal = approved(&mut config, &action, T0);
        assert_eq!(proposal.approved_at, T0);

        // Bob changes his mind most of the way through the delay.
        revoke(&config, &mut proposal, &BOB).unwrap();
        assert_eq!(proposal.approvals, 0b001);
        assert_eq!(proposal.approved_at, 0);
        assert_eq!(
            revoke(&config, &mut proposal, &BOB),
            Err(ArchpadError::NotApproved)
        );
        assert_eq!(
            execute(&mut config, &mut proposal, &action, T0 + 2 * DAY),
            Err(ArchpadError::NotEnoughApprovals)
        );

        // Carol approves later. The delay runs in full from then.
        approve(&config, &mut proposal, &CAROL, T0 + 2 * DAY).unwrap();
        assert_eq!(proposal.approvals, 0b101);
        assert_eq!(proposal.approved_at, T0 + 2 * DAY);
        assert_eq!(
            execute(&mut config, &mut proposal, &action, T0 + 2 * DAY + DAY - 1),
            Err(ArchpadError::TimelockNotElapsed)
        );
        execute(&mut config, &mut proposal, &action, T0 + 3 * DAY).unwrap();
    }

    #[test]
    fn extra_approvals_do_not_restart_the_clock() {
        let mut config = config();
        let action = cheaper();
        let mut proposal = approved(&mut config, &action, T0);
        approve(&config, &mut proposal, &CAROL, T0 + DAY / 2).unwrap();
        assert_eq!(proposal.approved_at, T0);

        // Three approved, two needed: one can leave without resetting anything.
        revoke(&config, &mut proposal, &ALICE).unwrap();
        assert_eq!(proposal.approved_at, T0);
        execute(&mut config, &mut proposal, &action, T0 + DAY).unwrap();
    }

    #[test]
    fn replacing_the_config_retires_every_other_open_proposal() {
        let mut config = config();
        let action = cheaper();
        let mut change = approved(&mut config, &action, T0);
        let mut pause = approved(&mut config, &PAUSE, T0);

        // Remove Carol and keep two-of-two.
        let mut smaller = data();
        smaller.admins = Admins::new(&[ALICE, BOB], 2);
        let shrink = AdminAction::SetConfig(smaller);
        let mut shrink_proposal = approved(&mut config, &shrink, T0);
        execute(&mut config, &mut shrink_proposal, &shrink, T0 + DAY).unwrap();
        assert_eq!(config.epoch, 1);
        assert_eq!(config.active.admins.count(), 2);

        // Proposals approved under the old admin list are dead, even though
        // they had enough approvals and had waited long enough.
        let stale = Err(ArchpadError::ProposalStale);
        assert_eq!(execute(&mut config, &mut change, &action, T0 + DAY), stale);
        assert_eq!(execute(&mut config, &mut pause, &PAUSE, T0 + DAY), stale);
        assert_eq!(approve(&config, &mut pause, &BOB, T0 + DAY), stale);
        assert_eq!(revoke(&config, &mut pause, &ALICE), stale);
        assert!(!config.launches_paused);

        // And Carol is now a stranger.
        assert_eq!(
            propose(&mut config, &CAROL, &PAUSE, 255, T0 + DAY).map(drop),
            Err(ArchpadError::NotAnAdmin)
        );
    }

    #[test]
    fn shortening_the_timelock_is_itself_delayed() {
        let mut config = config();
        let mut instant = data();
        instant.timelock_secs = 0;
        let remove_delay = AdminAction::SetConfig(instant);

        // The removal waits out the current one-day delay...
        let mut proposal = approved(&mut config, &remove_delay, T0);
        assert_eq!(
            execute(&mut config, &mut proposal, &remove_delay, T0 + DAY - 1),
            Err(ArchpadError::TimelockNotElapsed)
        );
        execute(&mut config, &mut proposal, &remove_delay, T0 + DAY).unwrap();

        // ...and only after that do approved changes apply at once.
        let mut next = instant;
        next.launch.platform_fee_bps = 50;
        let action = AdminAction::SetConfig(next);
        let mut proposal = propose(&mut config, &ALICE, &action, 255, T0 + DAY).unwrap();
        approve(&config, &mut proposal, &BOB, T0 + DAY).unwrap();
        execute(&mut config, &mut proposal, &action, T0 + DAY).unwrap();
        assert_eq!(config.active.launch.platform_fee_bps, 50);
    }

    #[test]
    fn a_single_admin_can_act_alone_when_the_threshold_is_one() {
        let mut solo = data();
        solo.admins = Admins::new(&[ALICE], 1);
        solo.timelock_secs = 0;
        let mut config = GlobalConfig::new(255, solo);

        // Proposing is approving, so the proposal is ready as soon as it exists.
        let mut proposal = propose(&mut config, &ALICE, &PAUSE, 255, T0).unwrap();
        assert_eq!(proposal.approved_at, T0);
        execute(&mut config, &mut proposal, &PAUSE, T0).unwrap();
        assert!(config.launches_paused);

        // Even at the dawn of time an approval is marked as having happened.
        let mut proposal = propose(&mut config, &ALICE, &PAUSE, 255, 0).unwrap();
        assert_eq!(proposal.approved_at, 1);
        execute(&mut config, &mut proposal, &PAUSE, 1).unwrap();
        assert_eq!(proposal.executed_at, 1);
    }

    #[test]
    fn quote_assets_pause_one_at_a_time() {
        let mut config = config();
        let pause_usd = AdminAction::SetQuotePaused {
            mint: USD,
            paused: true,
        };
        let mut proposal = approved(&mut config, &pause_usd, T0);
        execute(&mut config, &mut proposal, &pause_usd, T0).unwrap();
        assert!(config.is_quote_paused(1));
        assert!(!config.is_quote_paused(0));

        let resume_usd = AdminAction::SetQuotePaused {
            mint: USD,
            paused: false,
        };
        let mut proposal = approved(&mut config, &resume_usd, T0);
        execute(&mut config, &mut proposal, &resume_usd, T0).unwrap();
        assert_eq!(config.paused_quotes, 0);
    }

    #[test]
    fn a_quote_pause_follows_its_mint_when_slots_move() {
        let mut config = config();
        let pause_usd = AdminAction::SetQuotePaused {
            mint: USD,
            paused: true,
        };
        let mut proposal = approved(&mut config, &pause_usd, T0);
        execute(&mut config, &mut proposal, &pause_usd, T0).unwrap();

        // Swap the two slots and add a third asset.
        let mut reordered = data();
        reordered.quotes.swap(0, 1);
        reordered.quotes[2] = QuoteAsset {
            mint: Pubkey::new_from_array([0xA0; 32]),
            virtual_quote_reserves: 9_000_000,
        };
        let reorder = AdminAction::SetConfig(reordered);
        let mut proposal = approved(&mut config, &reorder, T0);
        execute(&mut config, &mut proposal, &reorder, T0 + DAY).unwrap();

        assert!(
            config.is_quote_paused(0),
            "USD moved to slot 0 and stays paused"
        );
        assert!(!config.is_quote_paused(1), "BTC was never paused");
        assert!(!config.is_quote_paused(2));

        // Remove USD: its pause bit goes with it rather than landing on a neighbour.
        let mut without_usd = config.active;
        without_usd.quotes[0] = QuoteAsset::default();
        let remove = AdminAction::SetConfig(without_usd);
        let mut proposal = approved(&mut config, &remove, T0 + DAY);
        execute(&mut config, &mut proposal, &remove, T0 + 2 * DAY).unwrap();
        assert_eq!(config.paused_quotes, 0);
    }

    #[test]
    fn a_quote_pause_for_an_asset_removed_meanwhile_cannot_be_forced_through() {
        // Not reachable through the processor, because removing an asset
        // moves the epoch on and retires the pause proposal first. The rule
        // still holds on its own.
        let mut config = config();
        let pause_usd = AdminAction::SetQuotePaused {
            mint: USD,
            paused: true,
        };
        let mut proposal = approved(&mut config, &pause_usd, T0);
        config.active.quotes[1] = QuoteAsset::default();
        assert_eq!(
            execute(&mut config, &mut proposal, &pause_usd, T0),
            Err(ArchpadError::UnknownQuoteAsset)
        );
        assert_eq!(config.paused_quotes, 0);
        assert_eq!(proposal.executed_at, 0);
    }
}
