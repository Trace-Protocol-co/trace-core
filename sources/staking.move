/// TRACE — Temporal Staking (F-8)
/// Anti-backdating mechanism: creators stake SUI to claim old timestamps.
/// If a timestamp claim is successfully challenged within the window,
/// the stake is slashed — 70% to challenger, 30% to protocol treasury.
#[allow(unused_const)]
module trace::staking {

    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::event;
    use sui::balance::{Self, Balance};
    use std::string::{Self, String};

    // =========================================================================
    // Error Constants
    // =========================================================================

    const EInsufficientStake:      u64 = 1;
    const EStakeNotRequired:       u64 = 2;
    const EChallengeWindowClosed:  u64 = 3;
    const EAlreadyChallenged:      u64 = 4;
    const EAlreadySettled:         u64 = 5;
    const ENotChallengeable:       u64 = 6;

    // =========================================================================
    // Protocol Constants
    // =========================================================================

    /// Timestamps older than 72h require staking (milliseconds)
    const STAKE_THRESHOLD_MS:  u64 = 72 * 60 * 60 * 1000;

    /// Required stake per 24h of backdating: 50 SUI in MIST
    const STAKE_PER_DAY_MIST:  u64 = 50_000_000_000;

    /// Challenge window: 7 days in milliseconds
    const CHALLENGE_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1000;

    /// Challenger share of slashed stake in basis points (70%)
    const CHALLENGER_SHARE_BPS: u64 = 7000;

    // =========================================================================
    // Structs
    // =========================================================================

    /// Shared protocol treasury — holds slashed stakes.
    public struct Treasury has key {
        id:            sui::object::UID,
        balance:       Balance<SUI>,
        total_slashed: u64,
        total_claims:  u64,
    }

    /// A stake deposit for a backdated timestamp claim.
    /// Shared object so anyone can challenge it.
    public struct StakeDeposit has key, store {
        id:                 sui::object::UID,
        media_id:           sui::object::ID,
        creator:            address,
        claimed_timestamp:  u64,
        deposited_at:       u64,
        stake_amount:       u64,
        balance:            Balance<SUI>,
        challenge_deadline: u64,
        challenged:         bool,
        settled:            bool,
        challenger:         std::option::Option<address>,
        challenge_evidence: std::option::Option<String>,
    }

    /// A challenge receipt — held by the challenger as proof of filing.
    public struct Challenge has key, store {
        id:         sui::object::UID,
        deposit_id: sui::object::ID,
        media_id:   sui::object::ID,
        challenger: address,
        filed_at:   u64,
        evidence:   String,
    }

    // =========================================================================
    // Events
    // =========================================================================

    public struct StakeDeposited has copy, drop {
        deposit_id:         sui::object::ID,
        media_id:           sui::object::ID,
        creator:            address,
        claimed_timestamp:  u64,
        stake_amount:       u64,
        challenge_deadline: u64,
    }

    public struct ChallengeFiled has copy, drop {
        challenge_id: sui::object::ID,
        deposit_id:   sui::object::ID,
        media_id:     sui::object::ID,
        challenger:   address,
        filed_at:     u64,
    }

    public struct StakeSlashed has copy, drop {
        deposit_id:        sui::object::ID,
        media_id:          sui::object::ID,
        creator:           address,
        challenger:        address,
        amount_slashed:    u64,
        challenger_reward: u64,
        treasury_amount:   u64,
    }

    public struct StakeReleased has copy, drop {
        deposit_id:  sui::object::ID,
        media_id:    sui::object::ID,
        creator:     address,
        amount:      u64,
        released_at: u64,
    }

    // =========================================================================
    // Init — create shared Treasury
    // =========================================================================

    fun init(ctx: &mut sui::tx_context::TxContext) {
        sui::transfer::share_object(Treasury {
            id:            sui::object::new(ctx),
            balance:       balance::zero<SUI>(),
            total_slashed: 0,
            total_claims:  0,
        });
    }

    // =========================================================================
    // Public Computation — pure, no state change
    // =========================================================================

    /// Compute required stake for a backdated claim.
    /// Returns 0 if no stake required (within the 72h free window).
    public fun required_stake(
        claimed_timestamp_ms: u64,
        current_time_ms:      u64,
    ): u64 {
        if (current_time_ms <= claimed_timestamp_ms) { return 0 };
        let age_ms = current_time_ms - claimed_timestamp_ms;
        if (age_ms <= STAKE_THRESHOLD_MS) { return 0 };
        let extra_ms   = age_ms - STAKE_THRESHOLD_MS;
        // Ceiling division: round up to nearest day
        let extra_days = (extra_ms + 86_400_000 - 1) / 86_400_000;
        extra_days * STAKE_PER_DAY_MIST
    }

    // =========================================================================
    // Entry Functions
    // =========================================================================

    /// Deposit a stake for a backdated timestamp claim.
    /// The deposit becomes a shared object so anyone can challenge it.
    entry fun deposit_stake(
        media_id:          address,
        claimed_timestamp: u64,
        mut payment:       Coin<SUI>,
        clock:             &Clock,
        ctx:               &mut sui::tx_context::TxContext,
    ) {
        let creator      = sui::tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);
        let mid          = sui::object::id_from_address(media_id);

        let required = required_stake(claimed_timestamp, current_time);
        assert!(required > 0,                        EStakeNotRequired);
        assert!(coin::value(&payment) >= required,   EInsufficientStake);

        let stake_coin = coin::split(&mut payment, required, ctx);
        let stake_bal  = coin::into_balance(stake_coin);

        // Return change to sender
        if (coin::value(&payment) > 0) {
            sui::transfer::public_transfer(payment, creator);
        } else {
            coin::destroy_zero(payment);
        };

        let challenge_deadline = current_time + CHALLENGE_WINDOW_MS;

        let deposit = StakeDeposit {
            id:                 sui::object::new(ctx),
            media_id:           mid,
            creator,
            claimed_timestamp,
            deposited_at:       current_time,
            stake_amount:       required,
            balance:            stake_bal,
            challenge_deadline,
            challenged:         false,
            settled:            false,
            challenger:         std::option::none(),
            challenge_evidence: std::option::none(),
        };

        let deposit_id = sui::object::id(&deposit);

        event::emit(StakeDeposited {
            deposit_id,
            media_id: mid,
            creator,
            claimed_timestamp,
            stake_amount:      required,
            challenge_deadline,
        });

        sui::transfer::share_object(deposit);
    }

    /// File a challenge against a backdated timestamp claim.
    /// Anyone can challenge within the challenge window.
    entry fun file_challenge(
        deposit:  &mut StakeDeposit,
        evidence: vector<u8>,
        clock:    &Clock,
        ctx:      &mut sui::tx_context::TxContext,
    ) {
        let challenger   = sui::tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);

        assert!(!deposit.challenged,                        EAlreadyChallenged);
        assert!(!deposit.settled,                           EAlreadySettled);
        assert!(current_time <= deposit.challenge_deadline, EChallengeWindowClosed);

        deposit.challenged         = true;
        deposit.challenger         = std::option::some(challenger);
        deposit.challenge_evidence = std::option::some(string::utf8(evidence));

        let deposit_id = sui::object::id(deposit);

        let challenge = Challenge {
            id:         sui::object::new(ctx),
            deposit_id,
            media_id:   deposit.media_id,
            challenger,
            filed_at:   current_time,
            evidence:   string::utf8(evidence),
        };

        let challenge_id = sui::object::id(&challenge);

        event::emit(ChallengeFiled {
            challenge_id,
            deposit_id,
            media_id:   deposit.media_id,
            challenger,
            filed_at:   current_time,
        });

        sui::transfer::transfer(challenge, challenger);
    }

    /// Slash the stake after a successful challenge.
    /// 70% goes to challenger, 30% to protocol treasury.
    entry fun slash_stake(
        deposit:  &mut StakeDeposit,
        treasury: &mut Treasury,
        ctx:      &mut sui::tx_context::TxContext,
    ) {
        assert!(deposit.challenged,  ENotChallengeable);
        assert!(!deposit.settled,    EAlreadySettled);

        deposit.settled = true;
        treasury.total_claims = treasury.total_claims + 1;

        let total          = balance::value(&deposit.balance);
        let challenger_amt = (total * CHALLENGER_SHARE_BPS) / 10000;
        let treasury_amt   = total - challenger_amt;

        let challenger_addr = *std::option::borrow(&deposit.challenger);

        let challenger_bal  = balance::split(&mut deposit.balance, challenger_amt);
        sui::transfer::public_transfer(
            coin::from_balance(challenger_bal, ctx),
            challenger_addr,
        );

        let treasury_bal = balance::split(&mut deposit.balance, treasury_amt);
        balance::join(&mut treasury.balance, treasury_bal);
        treasury.total_slashed = treasury.total_slashed + total;

        event::emit(StakeSlashed {
            deposit_id:        sui::object::id(deposit),
            media_id:          deposit.media_id,
            creator:           deposit.creator,
            challenger:        challenger_addr,
            amount_slashed:    total,
            challenger_reward: challenger_amt,
            treasury_amount:   treasury_amt,
        });
    }

    /// Release stake back to creator — only if challenge window passed unchallenged.
    entry fun release_stake(
        deposit: &mut StakeDeposit,
        clock:   &Clock,
        ctx:     &mut sui::tx_context::TxContext,
    ) {
        let current_time = clock::timestamp_ms(clock);
        assert!(!deposit.challenged,                       EAlreadyChallenged);
        assert!(!deposit.settled,                          EAlreadySettled);
        assert!(current_time > deposit.challenge_deadline, EChallengeWindowClosed);

        deposit.settled = true;

        let amount = balance::value(&deposit.balance);
        let refund = balance::split(&mut deposit.balance, amount);

        event::emit(StakeReleased {
            deposit_id:  sui::object::id(deposit),
            media_id:    deposit.media_id,
            creator:     deposit.creator,
            amount,
            released_at: current_time,
        });

        sui::transfer::public_transfer(
            coin::from_balance(refund, ctx),
            deposit.creator,
        );
    }

    // =========================================================================
    // Read-Only Accessors
    // =========================================================================

    public fun treasury_balance(t: &Treasury): u64        { balance::value(&t.balance) }
    public fun treasury_total_slashed(t: &Treasury): u64  { t.total_slashed }
    public fun deposit_amount(d: &StakeDeposit): u64      { d.stake_amount }
    public fun deposit_creator(d: &StakeDeposit): address { d.creator }
    public fun is_challenged(d: &StakeDeposit): bool      { d.challenged }
    public fun is_settled(d: &StakeDeposit): bool         { d.settled }
    public fun challenge_deadline(d: &StakeDeposit): u64  { d.challenge_deadline }

    // Expose constants for TypeScript middleware
    public fun stake_threshold_ms():  u64 { STAKE_THRESHOLD_MS }
    public fun stake_per_day_mist():  u64 { STAKE_PER_DAY_MIST }
    public fun challenge_window_ms(): u64 { CHALLENGE_WINDOW_MS }

    // Expose error constants for tests
    public fun e_insufficient_stake():      u64 { EInsufficientStake }
    public fun e_stake_not_required():      u64 { EStakeNotRequired }
    public fun e_challenge_window_closed(): u64 { EChallengeWindowClosed }
    public fun e_already_challenged():      u64 { EAlreadyChallenged }
    public fun e_already_settled():         u64 { EAlreadySettled }
}
