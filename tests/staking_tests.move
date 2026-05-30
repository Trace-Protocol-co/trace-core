#[test_only]
#[allow(unused_use, unused_const)]
module trace::staking_tests {

    use sui::test_scenario::{Self as ts};
    use sui::clock::{Self, Clock};
    use sui::coin::{Self};
    use sui::sui::SUI;
    use trace::staking::{Self, StakeDeposit, Treasury};

    const CREATOR:    address = @0xAAA;
    const CHALLENGER: address = @0xBBB;
    const ADMIN:      address = @0xCCC;

    // 100 SUI in MIST
    const HUNDRED_SUI: u64 = 100_000_000_000;
    // 4 days ago in ms
    const FOUR_DAYS_MS: u64 = 4 * 24 * 60 * 60 * 1000;

    // TEST 1 — Required stake calculation
    #[test]
    fun test_required_stake_calculation() {
        let now = 1_000_000_000u64;

        // Within 72h — no stake required
        let recent = now - (48 * 60 * 60 * 1000); // 48h ago
        assert!(staking::required_stake(recent, now) == 0, 0);

        // Exactly 72h — no stake required (at threshold, not beyond)
        let at_threshold = now - staking::stake_threshold_ms();
        assert!(staking::required_stake(at_threshold, now) == 0, 1);

        // 4 days ago — 1 extra day beyond 72h → 50 SUI required
        let four_days_ago = now - FOUR_DAYS_MS;
        let required = staking::required_stake(four_days_ago, now);
        assert!(required == staking::stake_per_day_mist(), 2); // 1 extra day = 50 SUI

        // Future timestamp — no stake
        assert!(staking::required_stake(now + 1000, now) == 0, 3);
    }

    // TEST 2 — Deposit and release (unchallenged)
    #[test]
    fun test_deposit_and_release() {
        let mut scenario = ts::begin(CREATOR);

        // Init creates Treasury as shared object
        // We simulate by using test_scenario

        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        // Set clock to "now"
        clock::set_for_testing(&mut clock, 10_000_000_000);

        ts::next_tx(&mut scenario, CREATOR);
        {
            let ctx = ts::ctx(&mut scenario);
            // Claimed timestamp: 4 days ago
            let claimed = 10_000_000_000 - FOUR_DAYS_MS;
            let required = staking::required_stake(claimed, 10_000_000_000);
            assert!(required > 0, 0);

            // Mint test SUI
            let payment = coin::mint_for_testing<SUI>(HUNDRED_SUI, ctx);

            staking::deposit_stake(
                @0x1234, // fake media address
                claimed,
                payment,
                &clock,
                ctx,
            );
        };

        // Advance clock past challenge window
        clock::set_for_testing(&mut clock, 10_000_000_000 + staking::challenge_window_ms() + 1000);

        // Release stake
        ts::next_tx(&mut scenario, CREATOR);
        {
            let mut deposit = ts::take_shared<StakeDeposit>(&scenario);
            assert!(!staking::is_settled(&deposit), 1);
            assert!(!staking::is_challenged(&deposit), 2);

            staking::release_stake(
                &mut deposit,
                &clock,
                ts::ctx(&mut scenario),
            );

            assert!(staking::is_settled(&deposit), 3);
            ts::return_shared(deposit);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // TEST 3 — Challenge filed within window
    #[test]
    fun test_challenge_flow() {
        let mut scenario = ts::begin(CREATOR);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 10_000_000_000);

        // Deposit stake
        ts::next_tx(&mut scenario, CREATOR);
        {
            let ctx = ts::ctx(&mut scenario);
            let claimed = 10_000_000_000 - FOUR_DAYS_MS;
            let payment = coin::mint_for_testing<SUI>(HUNDRED_SUI, ctx);
            staking::deposit_stake(@0x5678, claimed, payment, &clock, ctx);
        };

        // Challenger files challenge within window
        ts::next_tx(&mut scenario, CHALLENGER);
        {
            let mut deposit = ts::take_shared<StakeDeposit>(&scenario);
            assert!(!staking::is_challenged(&deposit), 0);

            staking::file_challenge(
                &mut deposit,
                b"On-chain evidence: footage metadata shows different capture time",
                &clock,
                ts::ctx(&mut scenario),
            );

            assert!(staking::is_challenged(&deposit), 1);
            ts::return_shared(deposit);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // TEST 4 — Cannot release if challenged
    #[test]
    #[expected_failure(abort_code = trace::staking::EAlreadyChallenged)]
    fun test_cannot_release_if_challenged() {
        let mut scenario = ts::begin(CREATOR);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 10_000_000_000);

        ts::next_tx(&mut scenario, CREATOR);
        {
            let ctx = ts::ctx(&mut scenario);
            let claimed = 10_000_000_000 - FOUR_DAYS_MS;
            let payment = coin::mint_for_testing<SUI>(HUNDRED_SUI, ctx);
            staking::deposit_stake(@0x9abc, claimed, payment, &clock, ctx);
        };

        ts::next_tx(&mut scenario, CHALLENGER);
        {
            let mut deposit = ts::take_shared<StakeDeposit>(&scenario);
            staking::file_challenge(&mut deposit, b"evidence", &clock, ts::ctx(&mut scenario));
            ts::return_shared(deposit);
        };

        // Advance past window
        clock::set_for_testing(&mut clock, 10_000_000_000 + staking::challenge_window_ms() + 1000);

        // Creator tries to release — must abort because it was challenged
        ts::next_tx(&mut scenario, CREATOR);
        {
            let mut deposit = ts::take_shared<StakeDeposit>(&scenario);
            staking::release_stake(&mut deposit, &clock, ts::ctx(&mut scenario));
            ts::return_shared(deposit);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // TEST 5 — Cannot challenge after window closes
    #[test]
    #[expected_failure(abort_code = trace::staking::EChallengeWindowClosed)]
    fun test_cannot_challenge_after_window() {
        let mut scenario = ts::begin(CREATOR);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 10_000_000_000);

        ts::next_tx(&mut scenario, CREATOR);
        {
            let ctx = ts::ctx(&mut scenario);
            let claimed = 10_000_000_000 - FOUR_DAYS_MS;
            let payment = coin::mint_for_testing<SUI>(HUNDRED_SUI, ctx);
            staking::deposit_stake(@0xdef0, claimed, payment, &clock, ctx);
        };

        // Advance past challenge window
        clock::set_for_testing(&mut clock, 10_000_000_000 + staking::challenge_window_ms() + 1000);

        // Too late to challenge — must abort
        ts::next_tx(&mut scenario, CHALLENGER);
        {
            let mut deposit = ts::take_shared<StakeDeposit>(&scenario);
            staking::file_challenge(&mut deposit, b"too late", &clock, ts::ctx(&mut scenario));
            ts::return_shared(deposit);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // TEST 6 — No stake required for recent content
    #[test]
    #[expected_failure(abort_code = trace::staking::EStakeNotRequired)]
    fun test_stake_not_required_for_recent() {
        let mut scenario = ts::begin(CREATOR);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clock, 10_000_000_000);

        ts::next_tx(&mut scenario, CREATOR);
        {
            let ctx = ts::ctx(&mut scenario);
            // 24h ago — within free window, no stake required
            let claimed = 10_000_000_000 - (24 * 60 * 60 * 1000);
            let payment = coin::mint_for_testing<SUI>(HUNDRED_SUI, ctx);
            // Must abort — stake not required for recent content
            staking::deposit_stake(@0x1111, claimed, payment, &clock, ctx);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }
}
