/// TRACE — Seal Policy Test Suite
/// Covers: policy init, credential issuance, seal_approve authorization,
/// revocation, access control, and tier validation.
#[test_only]
#[allow(duplicate_alias, unused_use)]
module trace::seal_policy_tests {

    use sui::test_scenario::{Self as ts, Scenario};
    use trace::seal_policy::{
        Self,
        BankAccessPolicy,
        VerifierCredential,
    };

    // =========================================================================
    // Test Addresses
    // =========================================================================

    const ADMIN:       address = @0xAD;
    const JOURNALIST:  address = @0xA1;
    const INSTITUTION: address = @0xA2;
    const ATTACKER:    address = @0xDE;

    const TIER_VERIFIER:      u8 = 1;
    const TIER_INSTITUTIONAL: u8 = 2;

    // =========================================================================
    // Helpers
    // =========================================================================

    fun begin(sender: address): Scenario {
        let mut scenario = ts::begin(sender);
        {
            // init creates BankAccessPolicy as shared object
            seal_policy::init_for_testing(scenario.ctx());
        };
        scenario
    }

    // =========================================================================
    // Test 1 — Policy initializes correctly
    // =========================================================================

    #[test]
    fun test_policy_init() {
        let mut scenario = begin(ADMIN);
        scenario.next_tx(ADMIN);
        {
            // BankAccessPolicy should exist as shared object
            let policy = scenario.take_shared<BankAccessPolicy>();
            ts::return_shared(policy);
        };
        scenario.end();
    }

    // =========================================================================
    // Test 2 — Admin can issue verifier credential
    // =========================================================================

    #[test]
    fun test_issue_verifier_credential() {
        let mut scenario = begin(ADMIN);
        scenario.next_tx(ADMIN);
        {
            let mut policy = scenario.take_shared<BankAccessPolicy>();
            seal_policy::issue_credential(
                &mut policy,
                JOURNALIST,
                TIER_VERIFIER,
                scenario.ctx(),
            );
            ts::return_shared(policy);
        };
        // Journalist should now have credential
        scenario.next_tx(JOURNALIST);
        {
            let credential = scenario.take_from_sender<VerifierCredential>();
            assert!(seal_policy::is_valid_verifier(&credential), 0);
            assert!(seal_policy::get_tier(&credential) == TIER_VERIFIER, 1);
            scenario.return_to_sender(credential);
        };
        scenario.end();
    }

    // =========================================================================
    // Test 3 — Admin can issue institutional credential
    // =========================================================================

    #[test]
    fun test_issue_institutional_credential() {
        let mut scenario = begin(ADMIN);
        scenario.next_tx(ADMIN);
        {
            let mut policy = scenario.take_shared<BankAccessPolicy>();
            seal_policy::issue_credential(
                &mut policy,
                INSTITUTION,
                TIER_INSTITUTIONAL,
                scenario.ctx(),
            );
            ts::return_shared(policy);
        };
        scenario.next_tx(INSTITUTION);
        {
            let credential = scenario.take_from_sender<VerifierCredential>();
            assert!(seal_policy::is_valid_verifier(&credential), 0);
            assert!(seal_policy::get_tier(&credential) == TIER_INSTITUTIONAL, 1);
            scenario.return_to_sender(credential);
        };
        scenario.end();
    }

    // =========================================================================
    // Test 4 — Non-admin cannot issue credentials
    // =========================================================================

    #[test]
    #[expected_failure(abort_code = 1)]
    fun test_attacker_cannot_issue_credential() {
        let mut scenario = begin(ADMIN);
        scenario.next_tx(ATTACKER); // attacker tries to issue
        {
            let mut policy = scenario.take_shared<BankAccessPolicy>();
            seal_policy::issue_credential(
                &mut policy,
                ATTACKER,
                TIER_VERIFIER,
                scenario.ctx(),
            );
            ts::return_shared(policy);
        };
        scenario.end();
    }

    // =========================================================================
    // Test 5 — Invalid tier rejected
    // =========================================================================

    #[test]
    #[expected_failure(abort_code = 2)]
    fun test_invalid_tier_rejected() {
        let mut scenario = begin(ADMIN);
        scenario.next_tx(ADMIN);
        {
            let mut policy = scenario.take_shared<BankAccessPolicy>();
            // Tier 0 (PUBLIC) cannot be issued as credential
            seal_policy::issue_credential(
                &mut policy,
                JOURNALIST,
                0u8, // invalid — public tier
                scenario.ctx(),
            );
            ts::return_shared(policy);
        };
        scenario.end();
    }

    // =========================================================================
    // Test 6 — seal_approve passes for valid credential holder
    // =========================================================================

    #[test]
    fun test_seal_approve_valid() {
        let mut scenario = begin(ADMIN);
        scenario.next_tx(ADMIN);
        {
            let mut policy = scenario.take_shared<BankAccessPolicy>();
            seal_policy::issue_credential(&mut policy, JOURNALIST, TIER_VERIFIER, scenario.ctx());
            ts::return_shared(policy);
        };
        scenario.next_tx(JOURNALIST);
        {
            let credential = scenario.take_from_sender<VerifierCredential>();
            // seal_approve should not abort for valid holder
            seal_policy::seal_approve(
                &credential,
                b"sighting_record_id",
                scenario.ctx(),
            );
            scenario.return_to_sender(credential);
        };
        scenario.end();
    }

    // =========================================================================
    // Test 7 — seal_approve fails for wrong caller
    // =========================================================================

    #[test]
    #[expected_failure(abort_code = 1)]
    fun test_seal_approve_wrong_caller() {
        let mut scenario = begin(ADMIN);
        scenario.next_tx(ADMIN);
        {
            let mut policy = scenario.take_shared<BankAccessPolicy>();
            seal_policy::issue_credential(&mut policy, JOURNALIST, TIER_VERIFIER, scenario.ctx());
            ts::return_shared(policy);
        };
        // Attacker tries to use journalist's credential
        scenario.next_tx(JOURNALIST);
        {
            let credential = scenario.take_from_sender<VerifierCredential>();
            scenario.return_to_sender(credential);
        };
        // Attacker context — seal_approve should fail
        scenario.next_tx(ATTACKER);
        {
            // Attacker cannot take journalist's credential but we test the logic
            // by using a credential with wrong holder
            let mut policy = scenario.take_shared<BankAccessPolicy>();
            seal_policy::issue_credential(&mut policy, ATTACKER, TIER_VERIFIER, scenario.ctx());
            ts::return_shared(policy);
        };
        scenario.next_tx(JOURNALIST); // journalist context but using attacker's flow
        {
            let credential = scenario.take_from_address<VerifierCredential>(ATTACKER);
            // This should fail because credential.holder != ctx.sender() (JOURNALIST)
            seal_policy::seal_approve(&credential, b"id", scenario.ctx());
            ts::return_to_address(ATTACKER, credential);
        };
        scenario.end();
    }

    // =========================================================================
    // Test 8 — Admin can revoke credential
    // =========================================================================

    #[test]
    fun test_revoke_credential() {
        let mut scenario = begin(ADMIN);
        scenario.next_tx(ADMIN);
        {
            let mut policy = scenario.take_shared<BankAccessPolicy>();
            seal_policy::issue_credential(&mut policy, JOURNALIST, TIER_VERIFIER, scenario.ctx());
            ts::return_shared(policy);
        };
        scenario.next_tx(JOURNALIST);
        {
            let credential = scenario.take_from_sender<VerifierCredential>();
            assert!(seal_policy::is_valid_verifier(&credential), 0);
            scenario.return_to_sender(credential);
        };
        // Admin revokes
        scenario.next_tx(ADMIN);
        {
            let policy = scenario.take_shared<BankAccessPolicy>();
            let mut credential = scenario.take_from_address<VerifierCredential>(JOURNALIST);
            seal_policy::revoke_credential(&policy, &mut credential, scenario.ctx());
            assert!(!seal_policy::is_valid_verifier(&credential), 1);
            ts::return_shared(policy);
            ts::return_to_address(JOURNALIST, credential);
        };
        scenario.end();
    }

    // =========================================================================
    // Test 9 — Revoked credential fails seal_approve
    // =========================================================================

    #[test]
    #[expected_failure(abort_code = 1)]
    fun test_revoked_credential_rejected() {
        let mut scenario = begin(ADMIN);
        scenario.next_tx(ADMIN);
        {
            let mut policy = scenario.take_shared<BankAccessPolicy>();
            seal_policy::issue_credential(&mut policy, JOURNALIST, TIER_VERIFIER, scenario.ctx());
            ts::return_shared(policy);
        };
        // Admin revokes
        scenario.next_tx(ADMIN);
        {
            let policy = scenario.take_shared<BankAccessPolicy>();
            let mut credential = scenario.take_from_address<VerifierCredential>(JOURNALIST);
            seal_policy::revoke_credential(&policy, &mut credential, scenario.ctx());
            ts::return_shared(policy);
            ts::return_to_address(JOURNALIST, credential);
        };
        // Journalist tries to use revoked credential
        scenario.next_tx(JOURNALIST);
        {
            let credential = scenario.take_from_sender<VerifierCredential>();
            // Should abort — credential is revoked
            seal_policy::seal_approve(&credential, b"id", scenario.ctx());
            scenario.return_to_sender(credential);
        };
        scenario.end();
    }

    // =========================================================================
    // Test 10 — Cannot revoke already revoked credential
    // =========================================================================

    #[test]
    #[expected_failure(abort_code = 3)]
    fun test_double_revoke_fails() {
        let mut scenario = begin(ADMIN);
        scenario.next_tx(ADMIN);
        {
            let mut policy = scenario.take_shared<BankAccessPolicy>();
            seal_policy::issue_credential(&mut policy, JOURNALIST, TIER_VERIFIER, scenario.ctx());
            ts::return_shared(policy);
        };
        // First revoke
        scenario.next_tx(ADMIN);
        {
            let policy = scenario.take_shared<BankAccessPolicy>();
            let mut credential = scenario.take_from_address<VerifierCredential>(JOURNALIST);
            seal_policy::revoke_credential(&policy, &mut credential, scenario.ctx());
            ts::return_shared(policy);
            ts::return_to_address(JOURNALIST, credential);
        };
        // Second revoke — should fail
        scenario.next_tx(ADMIN);
        {
            let policy = scenario.take_shared<BankAccessPolicy>();
            let mut credential = scenario.take_from_address<VerifierCredential>(JOURNALIST);
            seal_policy::revoke_credential(&policy, &mut credential, scenario.ctx());
            ts::return_shared(policy);
            ts::return_to_address(JOURNALIST, credential);
        };
        scenario.end();
    }
}
