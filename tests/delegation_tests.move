#[test_only]
#[allow(unused_use)]
module trace::delegation_tests {

    use sui::test_scenario::{Self as ts};
    use sui::clock::{Self, Clock};
    use trace::delegation::{Self, OrgRoot, DelegationRecord, RevocationReceipt};

    const ORG:      address = @0xAAA;
    const REPORTER: address = @0xBBB;
    const ATTACKER: address = @0xCCC;

    // =========================================================================
    // TEST 1 — Org registration and delegate grant
    // =========================================================================

    #[test]
    fun test_org_register_and_grant() {
        let mut scenario = ts::begin(ORG);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        // Register org
        ts::next_tx(&mut scenario, ORG);
        {
            delegation::register_org(
                b"Reuters Africa",
                &clock,
                ts::ctx(&mut scenario),
            );
        };

        // Grant delegation to reporter
        ts::next_tx(&mut scenario, ORG);
        {
            let mut org = ts::take_from_sender<OrgRoot>(&scenario);
            assert!(delegation::delegate_count(&org) == 0, 0);

            delegation::grant_delegation(
                &mut org,
                REPORTER,
                b"Lagos Bureau Reporter",
                &clock,
                ts::ctx(&mut scenario),
            );

            assert!(delegation::delegate_count(&org) == 1, 1);
            ts::return_to_sender(&scenario, org);
        };

        // Verify reporter received delegation record
        ts::next_tx(&mut scenario, REPORTER);
        {
            let record = ts::take_from_sender<DelegationRecord>(&scenario);
            assert!(delegation::is_delegation_valid(&record), 2);
            assert!(delegation::delegation_delegate(&record) == REPORTER, 3);
            ts::return_to_sender(&scenario, record);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // =========================================================================
    // TEST 2 — Unauthorized grant attempt (must abort ENotOrgRoot)
    // =========================================================================

    #[test]
    #[expected_failure(abort_code = trace::delegation::ENotOrgRoot)]
    fun test_unauthorized_grant_blocked() {
        let mut scenario = ts::begin(ORG);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ORG);
        {
            delegation::register_org(b"Reuters", &clock, ts::ctx(&mut scenario));
        };

        // ATTACKER tries to grant delegation using ORG's OrgRoot — must abort
        ts::next_tx(&mut scenario, ATTACKER);
        {
            let mut org = ts::take_from_address<OrgRoot>(&scenario, ORG);
            delegation::grant_delegation(
                &mut org,
                REPORTER,
                b"Fake Reporter",
                &clock,
                ts::ctx(&mut scenario),
            );
            ts::return_to_address(ORG, org);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // =========================================================================
    // TEST 3 — Self delegation (must abort ESelfDelegation)
    // =========================================================================

    #[test]
    #[expected_failure(abort_code = trace::delegation::ESelfDelegation)]
    fun test_self_delegation_blocked() {
        let mut scenario = ts::begin(ORG);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ORG);
        {
            delegation::register_org(b"Reuters", &clock, ts::ctx(&mut scenario));
        };

        ts::next_tx(&mut scenario, ORG);
        {
            let mut org = ts::take_from_sender<OrgRoot>(&scenario);
            // ORG delegates to itself — must abort
            delegation::grant_delegation(
                &mut org,
                ORG,
                b"Self",
                &clock,
                ts::ctx(&mut scenario),
            );
            ts::return_to_sender(&scenario, org);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // =========================================================================
    // TEST 4 — Revoke delegation
    // =========================================================================

    #[test]
    fun test_revocation_flow() {
        let mut scenario = ts::begin(ORG);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ORG);
        { delegation::register_org(b"BBC Africa", &clock, ts::ctx(&mut scenario)); };

        ts::next_tx(&mut scenario, ORG);
        {
            let mut org = ts::take_from_sender<OrgRoot>(&scenario);
            delegation::grant_delegation(
                &mut org, REPORTER, b"Abuja Desk",
                &clock, ts::ctx(&mut scenario),
            );
            ts::return_to_sender(&scenario, org);
        };

        // Revoke the delegation
        ts::next_tx(&mut scenario, ORG);
        {
            let org    = ts::take_from_sender<OrgRoot>(&scenario);
            let mut record = ts::take_from_address<DelegationRecord>(&scenario, REPORTER);

            assert!(delegation::is_delegation_valid(&record), 0);

            delegation::revoke_delegation(
                &org,
                &mut record,
                b"Reporter left organization",
                &clock,
                ts::ctx(&mut scenario),
            );

            assert!(!delegation::is_delegation_valid(&record), 1);

            ts::return_to_sender(&scenario, org);
            ts::return_to_address(REPORTER, record);
        };

        // Verify org received the revocation receipt
        ts::next_tx(&mut scenario, ORG);
        {
            let receipt = ts::take_from_sender<RevocationReceipt>(&scenario);
            assert!(delegation::receipt_delegate(&receipt) == REPORTER, 2);
            ts::return_to_sender(&scenario, receipt);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // =========================================================================
    // TEST 5 — Double revocation (must abort EAlreadyRevoked)
    // =========================================================================

    #[test]
    #[expected_failure(abort_code = trace::delegation::EAlreadyRevoked)]
    fun test_double_revocation_blocked() {
        let mut scenario = ts::begin(ORG);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, ORG);
        { delegation::register_org(b"AP", &clock, ts::ctx(&mut scenario)); };

        ts::next_tx(&mut scenario, ORG);
        {
            let mut org = ts::take_from_sender<OrgRoot>(&scenario);
            delegation::grant_delegation(&mut org, REPORTER, b"Photo Desk", &clock, ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, org);
        };

        // First revocation
        ts::next_tx(&mut scenario, ORG);
        {
            let org = ts::take_from_sender<OrgRoot>(&scenario);
            let mut record = ts::take_from_address<DelegationRecord>(&scenario, REPORTER);
            delegation::revoke_delegation(&org, &mut record, b"First revocation", &clock, ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, org);
            ts::return_to_address(REPORTER, record);
        };

        // Second revocation — must abort
        ts::next_tx(&mut scenario, ORG);
        {
            let org = ts::take_from_sender<OrgRoot>(&scenario);
            let mut record = ts::take_from_address<DelegationRecord>(&scenario, REPORTER);
            delegation::revoke_delegation(&org, &mut record, b"Second revocation", &clock, ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, org);
            ts::return_to_address(REPORTER, record);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }
}
