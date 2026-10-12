//! Golden fixtures shared with the TypeScript SDK.
//!
//! The SDK re-implements this crate's addresses, instruction builders, account
//! layouts and events by hand, plus Arch's transaction format. This test
//! writes what the Rust side produces for a fixed set of inputs to
//! `tests/fixtures/interface.json`; the SDK's test suite rebuilds the same
//! things and must get the same bytes.
//!
//! Regenerate after an intentional change with:
//!
//! ```text
//! UPDATE_FIXTURES=1 cargo test -p archpad-interface --test fixtures
//! ```

use arch_program::{
    account::AccountMeta, bpf_loader::BPF_LOADER_ID, compute_budget::ComputeBudgetInstruction,
    hash::Hash, instruction::Instruction, loader_instruction, pubkey::Pubkey,
    sanitized::ArchMessage, system_instruction, system_program::SYSTEM_PROGRAM_ID,
};
use arch_sdk::{RuntimeTransaction, Signature};
use archpad_interface::{
    config::{
        self, AdminAction, Admins, ConfigData, GlobalConfig, LaunchParams, Proposal,
        ProposalHeader, QuoteAsset, MAX_QUOTE_ASSETS,
    },
    fees, ids,
    launch::{self, CreateCoinArgs, Curve, CurveStatus, Position},
    pool::{self, Pool},
    AccountTag, Event,
};
use serde_json::{json, Value};

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/interface.json");

fn key(byte: u8) -> Pubkey {
    Pubkey::from([byte; 32])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn b58(pubkey: &Pubkey) -> String {
    pubkey.to_string()
}

/// Amounts go out as decimal strings so JavaScript reads them without loss.
fn num(value: impl ToString) -> String {
    value.to_string()
}

fn derived((address, bump): (Pubkey, u8)) -> Value {
    json!({ "address": b58(&address), "bump": bump })
}

fn instruction(name: &str, ix: &Instruction) -> Value {
    json!({
        "name": name,
        "programId": b58(&ix.program_id),
        "accounts": ix.accounts.iter().map(|meta: &AccountMeta| json!({
            "pubkey": b58(&meta.pubkey),
            "isSigner": meta.is_signer,
            "isWritable": meta.is_writable,
        })).collect::<Vec<_>>(),
        "data": hex(&ix.data),
    })
}

fn sample_config() -> ConfigData {
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
        admins: Admins::new(&[key(0x33), key(0x34), key(0x35)], 2),
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

fn config_data_json(data: &ConfigData) -> Value {
    json!({
        "admins": {
            // Clients see the real keys only; unused slots are padding.
            "members": data.admins.members.iter()
                .filter(|member| **member != Pubkey::default())
                .map(b58)
                .collect::<Vec<_>>(),
            "threshold": data.admins.threshold,
        },
        "treasury": b58(&data.treasury),
        "timelockSecs": data.timelock_secs,
        "launch": {
            "platformFeeBps": data.launch.platform_fee_bps,
            "creatorFeeBps": data.launch.creator_fee_bps,
            "minCreatorBuyBps": data.launch.min_creator_buy_bps,
            "earlyWalletCapBps": data.launch.early_wallet_cap_bps,
            "earlyWindowSecs": data.launch.early_window_secs,
            "tokenDecimals": data.launch.token_decimals,
            "totalSupply": num(data.launch.total_supply),
            "curveSupply": num(data.launch.curve_supply),
            "virtualTokenReserves": num(data.launch.virtual_token_reserves),
            "poolLpFeeBps": data.launch.pool_lp_fee_bps,
            "poolPlatformFeeBps": data.launch.pool_platform_fee_bps,
            "poolCreatorFeeBps": data.launch.pool_creator_fee_bps,
        },
        "quotes": data.quotes.iter().map(|quote| json!({
            "mint": b58(&quote.mint),
            "virtualQuoteReserves": num(quote.virtual_quote_reserves),
        })).collect::<Vec<_>>(),
    })
}

fn sample_args() -> CreateCoinArgs {
    CreateCoinArgs {
        salt: 0x0102_0304_0506_0708,
        name: "Arch Cat".into(),
        symbol: "ACAT".into(),
        image: "https://example.com/i/acat.png".into(),
        description: "The first cat on Arch. 猫".into(),
        metadata_hash: [0xAB; 32],
        creator_buy_max_quote: 123_456,
        creator_buy_min_tokens: 3_965_500_000_000,
    }
}

fn sample_curve(mint: Pubkey) -> Curve {
    Curve {
        tag: AccountTag::Curve as u8,
        version: Curve::VERSION,
        bump: 254,
        status: CurveStatus::Trading as u8,
        token_decimals: 6,
        mint,
        quote_mint: key(0xB7),
        creator: key(0x11),
        token_vault: launch::find_token_vault_address(&mint).0,
        quote_vault: launch::find_quote_vault_address(&mint).0,
        platform_fee_vault: fees::find_platform_vault_address(&key(0xB7)).0,
        creator_fee_vault: fees::find_creator_vault_address(&mint).0,
        virtual_quote: 6_100_000,
        virtual_token: 1_055_409_836_065_574,
        real_quote: 100_000,
        real_token: 775_509_836_065_574,
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
        metadata_hash: [0xAB; 32],
    }
}

fn curve_json(curve: &Curve) -> Value {
    json!({
        "version": curve.version,
        "bump": curve.bump,
        "status": curve.status,
        "tokenDecimals": curve.token_decimals,
        "mint": b58(&curve.mint),
        "quoteMint": b58(&curve.quote_mint),
        "creator": b58(&curve.creator),
        "tokenVault": b58(&curve.token_vault),
        "quoteVault": b58(&curve.quote_vault),
        "platformFeeVault": b58(&curve.platform_fee_vault),
        "creatorFeeVault": b58(&curve.creator_fee_vault),
        "virtualQuote": num(curve.virtual_quote),
        "virtualToken": num(curve.virtual_token),
        "realQuote": num(curve.real_quote),
        "realToken": num(curve.real_token),
        "totalSupply": num(curve.total_supply),
        "curveSupply": num(curve.curve_supply),
        "initialVirtualQuote": num(curve.initial_virtual_quote),
        "initialVirtualToken": num(curve.initial_virtual_token),
        "platformFeeBps": curve.platform_fee_bps,
        "creatorFeeBps": curve.creator_fee_bps,
        "poolLpFeeBps": curve.pool_lp_fee_bps,
        "poolPlatformFeeBps": curve.pool_platform_fee_bps,
        "poolCreatorFeeBps": curve.pool_creator_fee_bps,
        "launchedAt": num(curve.launched_at),
        "earlyWindowEnd": num(curve.early_window_end),
        "earlyWalletCap": num(curve.early_wallet_cap),
        "graduatedAt": num(curve.graduated_at),
        "metadataHash": hex(&curve.metadata_hash),
    })
}

fn sample_pool(mint: Pubkey) -> Pool {
    Pool {
        tag: AccountTag::Pool as u8,
        version: Pool::VERSION,
        bump: 253,
        mint,
        quote_mint: key(0xB7),
        creator: key(0x11),
        token_vault: pool::find_pool_token_vault_address(&mint).0,
        quote_vault: pool::find_pool_quote_vault_address(&mint).0,
        platform_fee_vault: fees::find_platform_vault_address(&key(0xB7)).0,
        creator_fee_vault: fees::find_creator_vault_address(&mint).0,
        quote_reserve: 17_001_072,
        token_reserve: 206_900_000_000_000,
        lp_fee_bps: 20,
        platform_fee_bps: 5,
        creator_fee_bps: 5,
        created_at: 1_800_000_999,
    }
}

fn pool_json(pool: &Pool) -> Value {
    json!({
        "version": pool.version,
        "bump": pool.bump,
        "mint": b58(&pool.mint),
        "quoteMint": b58(&pool.quote_mint),
        "creator": b58(&pool.creator),
        "tokenVault": b58(&pool.token_vault),
        "quoteVault": b58(&pool.quote_vault),
        "platformFeeVault": b58(&pool.platform_fee_vault),
        "creatorFeeVault": b58(&pool.creator_fee_vault),
        "quoteReserve": num(pool.quote_reserve),
        "tokenReserve": num(pool.token_reserve),
        "lpFeeBps": pool.lp_fee_bps,
        "platformFeeBps": pool.platform_fee_bps,
        "creatorFeeBps": pool.creator_fee_bps,
        "createdAt": num(pool.created_at),
    })
}

fn events(mint: Pubkey) -> Vec<Value> {
    let (trader, creator, quote_mint) = (key(0x22), key(0x11), key(0xB7));
    let event = |name: &str, event: Event, fields: Value| {
        // Where the indexer finds the event: a call from `program` to itself,
        // signed by `authority`, carrying `instructionData`.
        let (program, authority) = event.source();
        json!({
            "name": name,
            "data": hex(&event.pack()),
            "program": b58(&program),
            "authority": b58(&authority),
            "instructionData": hex(&event.instruction(&program, &authority).data),
            "fields": fields,
        })
    };
    vec![
        event(
            "CoinCreated",
            Event::CoinCreated {
                mint,
                creator,
                quote_mint,
                timestamp: 1_800_000_000,
            },
            json!({
                "mint": b58(&mint), "creator": b58(&creator), "quoteMint": b58(&quote_mint),
                "timestamp": "1800000000",
            }),
        ),
        event(
            "Trade",
            Event::Trade {
                mint,
                trader,
                is_buy: true,
                quote_amount: 100_000,
                token_amount: 17_590_163_934_426,
                platform_fee: 1_000,
                creator_fee: 1_250,
                virtual_quote: 6_100_000,
                virtual_token: 1_055_409_836_065_574,
                real_quote: 100_000,
                real_token: 775_509_836_065_574,
                timestamp: 1_800_000_003,
            },
            json!({
                "mint": b58(&mint), "trader": b58(&trader), "isBuy": true,
                "quoteAmount": "100000", "tokenAmount": "17590163934426",
                "platformFee": "1000", "creatorFee": "1250",
                "virtualQuote": "6100000", "virtualToken": "1055409836065574",
                "realQuote": "100000", "realToken": "775509836065574",
                "timestamp": "1800000003",
            }),
        ),
        event(
            "Graduated",
            Event::Graduated {
                mint,
                pool: pool::find_pool_address(&mint).0,
                quote_amount: 17_001_072,
                token_amount: 206_900_000_000_000,
                timestamp: 1_800_000_999,
            },
            json!({
                "mint": b58(&mint), "pool": b58(&pool::find_pool_address(&mint).0),
                "quoteAmount": "17001072", "tokenAmount": "206900000000000",
                "timestamp": "1800000999",
            }),
        ),
        event(
            "PoolSwap",
            Event::PoolSwap {
                mint,
                trader,
                is_buy: false,
                quote_amount: 50_000,
                token_amount: 610_000_000_000,
                lp_fee: 100,
                platform_fee: 25,
                creator_fee: 25,
                quote_reserve: 16_951_172,
                token_reserve: 207_510_000_000_000,
                timestamp: 1_800_001_111,
            },
            json!({
                "mint": b58(&mint), "trader": b58(&trader), "isBuy": false,
                "quoteAmount": "50000", "tokenAmount": "610000000000",
                "lpFee": "100", "platformFee": "25", "creatorFee": "25",
                "quoteReserve": "16951172", "tokenReserve": "207510000000000",
                "timestamp": "1800001111",
            }),
        ),
        event(
            "CreatorFeesClaimed",
            Event::CreatorFeesClaimed {
                mint,
                creator,
                amount: 1_250,
                timestamp: 1_800_002_222,
            },
            json!({
                "mint": b58(&mint), "creator": b58(&creator), "amount": "1250",
                "timestamp": "1800002222",
            }),
        ),
        event(
            "PlatformFeesWithdrawn",
            Event::PlatformFeesWithdrawn {
                quote_mint,
                amount: 1_000,
                timestamp: 1_800_003_333,
            },
            json!({ "quoteMint": b58(&quote_mint), "amount": "1000", "timestamp": "1800003333" }),
        ),
    ]
}

/// One proposal of each kind, as the account bytes and the fields a client
/// should read out of them.
fn sample_proposals(quote_mint: Pubkey) -> Vec<Value> {
    let header = ProposalHeader {
        tag: AccountTag::Proposal as u8,
        version: ProposalHeader::VERSION,
        bump: 253,
        id: 7,
        epoch: 3,
        proposer: key(0x33),
        approvals: 0b101,
        created_at: 1_800_000_000,
        approved_at: 1_800_000_600,
        executed_at: 0,
    };
    let proposal = |name: &str, action: AdminAction, action_json: Value| {
        let proposal = Proposal { header, action };
        json!({
            "name": name,
            "data": hex(&borsh::to_vec(&proposal).unwrap()),
            "fields": {
                "version": header.version,
                "bump": header.bump,
                "id": num(header.id),
                "epoch": header.epoch,
                "proposer": b58(&header.proposer),
                "approvals": header.approvals,
                "createdAt": num(header.created_at),
                "approvedAt": num(header.approved_at),
                "executedAt": num(header.executed_at),
                "action": action_json,
            },
        })
    };
    vec![
        proposal(
            "setConfig",
            AdminAction::SetConfig(sample_config()),
            json!({ "type": "SetConfig", "config": config_data_json(&sample_config()) }),
        ),
        proposal(
            "setLaunchesPaused",
            AdminAction::SetLaunchesPaused(true),
            json!({ "type": "SetLaunchesPaused", "paused": true }),
        ),
        proposal(
            "setQuotePaused",
            AdminAction::SetQuotePaused {
                mint: quote_mint,
                paused: false,
            },
            json!({ "type": "SetQuotePaused", "mint": b58(&quote_mint), "paused": false }),
        ),
    ]
}

fn generate() -> String {
    let (creator, wallet, quote_mint, authority) = (key(0x11), key(0x22), key(0xB7), key(0x33));
    let args = sample_args();
    let mint = launch::find_mint_address(&creator, args.salt).0;
    let curve = sample_curve(mint);
    let pool_state = sample_pool(mint);
    let config_account = GlobalConfig {
        launches_paused: true,
        paused_quotes: 0b10,
        epoch: 3,
        proposal_count: 9,
        ..GlobalConfig::new(255, sample_config())
    };
    let proposals = sample_proposals(quote_mint);
    let position = Position {
        window_bought: 3_965_500_000_000,
        ..Position::new(252, mint, wallet)
    };

    let buy = launch::buy(&wallet, &mint, &quote_mint, 250_000, 1_000_000);
    let budget = ComputeBudgetInstruction::set_compute_unit_limit(1_000_000);
    let transfer = system_instruction::transfer(&wallet, &creator, 5_000);

    let instructions = vec![
        instruction(
            "config.initialize",
            &config::initialize(&authority, sample_config()),
        ),
        instruction(
            "config.proposeConfig",
            &config::propose(&authority, 9, AdminAction::SetConfig(sample_config())),
        ),
        instruction(
            "config.proposeLaunchesPaused",
            &config::propose(&authority, 9, AdminAction::SetLaunchesPaused(true)),
        ),
        instruction(
            "config.proposeQuotePaused",
            &config::propose(
                &authority,
                9,
                AdminAction::SetQuotePaused {
                    mint: quote_mint,
                    paused: true,
                },
            ),
        ),
        instruction("config.approve", &config::approve(&authority, 7)),
        instruction("config.revoke", &config::revoke(&authority, 7)),
        instruction("config.execute", &config::execute(7)),
        instruction(
            "fees.initPlatformVault",
            &fees::init_platform_vault(&wallet, &quote_mint),
        ),
        instruction(
            "fees.claimCreatorFees",
            &fees::claim_creator_fees(
                &creator,
                &mint,
                &launch::associated_token_address(&creator, &quote_mint),
            ),
        ),
        instruction(
            "fees.withdrawPlatformFees",
            &fees::withdraw_platform_fees(
                &quote_mint,
                &launch::associated_token_address(&key(0x77), &quote_mint),
            ),
        ),
        instruction(
            "launch.createCoin",
            &launch::create_coin(&creator, &quote_mint, args.clone()),
        ),
        instruction("launch.buy", &buy),
        instruction(
            "launch.sell",
            &launch::sell(&wallet, &mint, &quote_mint, 1_000_000, 1),
        ),
        instruction(
            "pool.swapBuy",
            &pool::swap(&wallet, &pool_state, true, 250_000, 1_000_000),
        ),
        instruction(
            "pool.swapSell",
            &pool::swap(&wallet, &pool_state, false, 1_000_000, 1),
        ),
        instruction("system.transfer", &transfer),
        instruction(
            "system.createAccount",
            &system_instruction::create_account(&authority, &key(0x44), 123_456, 0, &BPF_LOADER_ID),
        ),
        // The loader instructions that deploy a program and then freeze it.
        instruction(
            "loader.truncate",
            &loader_instruction::truncate(key(0x44), authority, 331_224),
        ),
        instruction(
            "loader.write",
            &loader_instruction::write(
                key(0x44),
                authority,
                997,
                vec![0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01],
            ),
        ),
        instruction(
            "loader.deploy",
            &loader_instruction::deploy(key(0x44), authority),
        ),
        instruction(
            "loader.retract",
            &loader_instruction::retract(key(0x44), authority),
        ),
        instruction(
            "loader.transferAuthority",
            &loader_instruction::transfer_authority(key(0x44), authority, wallet),
        ),
        instruction(
            "loader.finalize",
            &loader_instruction::finalize(key(0x44), authority, key(0x44)),
        ),
        instruction("computeBudget.setComputeUnitLimit", &budget),
        instruction(
            "token.transfer",
            &apl_token::instruction::transfer(
                &apl_token::id(),
                &launch::associated_token_address(&wallet, &quote_mint),
                &launch::associated_token_address(&creator, &quote_mint),
                &wallet,
                &[],
                42,
            )
            .unwrap(),
        ),
        // What a test deployment uses to stand up its own quote assets.
        instruction(
            "token.initializeMint",
            &apl_token::instruction::initialize_mint2(
                &apl_token::id(),
                &key(0x55),
                &authority,
                None,
                8,
            )
            .unwrap(),
        ),
        instruction(
            "token.mintTo",
            &apl_token::instruction::mint_to(
                &apl_token::id(),
                &key(0x55),
                &launch::associated_token_address(&wallet, &key(0x55)),
                &authority,
                &[],
                2_100_000_000_000_000,
            )
            .unwrap(),
        ),
        instruction(
            "associatedToken.createIdempotent",
            &apl_associated_token_account::create_associated_token_account_idempotent(
                &wallet,
                &launch::associated_token_address(&wallet, &mint),
                &wallet,
                &mint,
                &apl_token::id(),
                &SYSTEM_PROGRAM_ID,
            ),
        ),
    ];

    // A transaction as a wallet would send it: raise the compute limit, make
    // sure the buyer has a token account, buy.
    let ata = apl_associated_token_account::create_associated_token_account_idempotent(
        &wallet,
        &launch::associated_token_address(&wallet, &mint),
        &wallet,
        &mint,
        &apl_token::id(),
        &SYSTEM_PROGRAM_ID,
    );
    let blockhash = Hash::from([0xC4; 32]);
    let message = ArchMessage::new(&[budget, ata, buy], Some(wallet), blockhash);
    let transaction = RuntimeTransaction {
        version: 0,
        signatures: vec![Signature([0x5A; 64])],
        message: message.clone(),
    };

    let fixtures = json!({
        "programIds": {
            "config": b58(&ids::config::ID),
            "launch": b58(&ids::launch::ID),
            "fees": b58(&ids::fees::ID),
            "pool": b58(&ids::pool::ID),
            "initialAuthority": b58(&ids::INITIAL_AUTHORITY),
            "token": b58(&apl_token::id()),
            "associatedToken": b58(&apl_associated_token_account::id()),
            "tokenMetadata": b58(&apl_token_metadata::id()),
            "system": b58(&SYSTEM_PROGRAM_ID),
            "computeBudget": b58(&arch_program::compute_budget::ID),
            "loader": b58(&BPF_LOADER_ID),
        },
        "errors": (0..1_000u32)
            .filter_map(archpad_interface::ArchpadError::from_code)
            .map(|error| json!({
                "code": error.code(),
                "name": format!("{error:?}"),
                "message": error.message(),
            }))
            .collect::<Vec<_>>(),
        "loader": {
            "programDataOffset": arch_program::bpf_loader::LoaderState::program_data_offset(),
            "maxWriteLen": arch_sdk::extend_bytes_max_len(),
        },
        "inputs": {
            "creator": b58(&creator),
            "wallet": b58(&wallet),
            "quoteMint": b58(&quote_mint),
            "authority": b58(&authority),
            "treasury": b58(&key(0x77)),
            "salt": num(args.salt),
            "createCoin": {
                "name": args.name, "symbol": args.symbol, "image": args.image,
                "description": args.description, "metadataHash": hex(&args.metadata_hash),
                "creatorBuyMaxQuote": num(args.creator_buy_max_quote),
                "creatorBuyMinTokens": num(args.creator_buy_min_tokens),
            },
            "config": config_data_json(&sample_config()),
        },
        "addresses": {
            "config": derived(config::find_config_address()),
            "proposal7": derived(config::find_proposal_address(7)),
            "proposal9": derived(config::find_proposal_address(9)),
            "mint": derived(launch::find_mint_address(&creator, args.salt)),
            "curve": derived(launch::find_curve_address(&mint)),
            "tokenVault": derived(launch::find_token_vault_address(&mint)),
            "quoteVault": derived(launch::find_quote_vault_address(&mint)),
            "position": derived(launch::find_position_address(&mint, &wallet)),
            "vaultAuthority": derived(fees::find_vault_authority_address()),
            "platformVault": derived(fees::find_platform_vault_address(&quote_mint)),
            "creatorVault": derived(fees::find_creator_vault_address(&mint)),
            "pool": derived(pool::find_pool_address(&mint)),
            "poolTokenVault": derived(pool::find_pool_token_vault_address(&mint)),
            "poolQuoteVault": derived(pool::find_pool_quote_vault_address(&mint)),
            "walletTokenAccount": b58(&launch::associated_token_address(&wallet, &mint)),
            "walletQuoteAccount": b58(&launch::associated_token_address(&wallet, &quote_mint)),
            "metadata": b58(&launch::find_metadata_address(&mint)),
        },
        "instructions": instructions,
        "accounts": {
            "globalConfig": {
                "data": hex(&borsh::to_vec(&config_account).unwrap()),
                "fields": {
                    "version": config_account.version,
                    "bump": config_account.bump,
                    "launchesPaused": config_account.launches_paused,
                    "pausedQuotes": config_account.paused_quotes,
                    "epoch": config_account.epoch,
                    "proposalCount": num(config_account.proposal_count),
                    "active": config_data_json(&config_account.active),
                },
            },
            "proposals": proposals,
            "curve": { "data": hex(&borsh::to_vec(&curve).unwrap()), "fields": curve_json(&curve) },
            "position": {
                "data": hex(&borsh::to_vec(&position).unwrap()),
                "fields": {
                    "version": position.version, "bump": position.bump,
                    "mint": b58(&position.mint), "wallet": b58(&position.wallet),
                    "windowBought": num(position.window_bought),
                },
            },
            "pool": { "data": hex(&borsh::to_vec(&pool_state).unwrap()), "fields": pool_json(&pool_state) },
        },
        "eventInstructionTag": archpad_interface::event::EVENT_IX_TAG,
        "events": events(mint),
        "transaction": {
            "payer": b58(&wallet),
            "recentBlockhash": hex(&blockhash.to_array()),
            "instructionNames": ["computeBudget.setComputeUnitLimit", "associatedToken.createIdempotent", "launch.buy"],
            "header": {
                "numRequiredSignatures": message.header.num_required_signatures,
                "numReadonlySignedAccounts": message.header.num_readonly_signed_accounts,
                "numReadonlyUnsignedAccounts": message.header.num_readonly_unsigned_accounts,
            },
            "accountKeys": message.account_keys.iter().map(b58).collect::<Vec<_>>(),
            "message": hex(&message.serialize()),
            "signingPayload": String::from_utf8(message.hash()).unwrap(),
            "signature": hex(&[0x5A; 64]),
            "serialized": hex(&transaction.serialize()),
            "txid": transaction.txid().to_string(),
        },
    });

    let mut out = serde_json::to_string_pretty(&fixtures).unwrap();
    out.push('\n');
    out
}

#[test]
fn fixtures_are_current() {
    let generated = generate();
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        let path = std::path::Path::new(PATH);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, &generated).unwrap();
    }
    let on_disk = std::fs::read_to_string(PATH)
        .expect("fixture file missing: run with UPDATE_FIXTURES=1 to create it")
        .replace("\r\n", "\n");
    assert!(
        on_disk == generated,
        "tests/fixtures/interface.json is out of date: rerun with UPDATE_FIXTURES=1 and review the diff"
    );
}

/// Every derived address in this deployment uses bump 255. Arch derives
/// addresses as `sha256(seeds || bump || program_id)` and treats no 32-byte
/// hash as "on the curve", so the first bump tried always wins. The SDK relies
/// on this; if it ever stops holding, this fails before the SDK silently
/// derives different addresses.
#[test]
fn derived_addresses_use_the_first_bump() {
    let mint = launch::find_mint_address(&key(0x11), 7).0;
    for (_, bump) in [
        config::find_config_address(),
        launch::find_mint_address(&key(0x11), 7),
        launch::find_curve_address(&mint),
        launch::find_token_vault_address(&mint),
        launch::find_quote_vault_address(&mint),
        launch::find_position_address(&mint, &key(0x22)),
        fees::find_vault_authority_address(),
        fees::find_platform_vault_address(&key(0xB7)),
        fees::find_creator_vault_address(&mint),
        pool::find_pool_address(&mint),
        pool::find_pool_token_vault_address(&mint),
        pool::find_pool_quote_vault_address(&mint),
    ] {
        assert_eq!(bump, 255);
    }
}
