/// TRACE — Adversarial Test Suite v2
/// Covers: clean lifecycle, revocation access control, invariant chain defense,
/// AI score boundaries, and description field validation.
#[test_only]
#[allow(duplicate_alias, unused_use)]
module trace::media_tests {

    use sui::test_scenario::{Self as ts, Scenario};
    use sui::clock::{Self, Clock};
    use std::option;
    use std::string;
    use trace::media::{
        Self,
        MediaRecord,
        EditRecord,
        RevocationRecord,
    };

    // =========================================================================
    // Test Addresses
    // =========================================================================

    const CREATOR:  address = @0xCAFE;
    const EDITOR:   address = @0xBEEF;
    const ATTACKER: address = @0xDEAD;

    // =========================================================================
    // Helpers
    // =========================================================================

    fun sample_hash(): vector<u8>    { b"abc123def456abc123def456abc12345" }
    fun sample_phash(): vector<u8>   { b"phash_mock_binary_vector_16bytes" }
    fun sample_blob_id(): vector<u8> { b"walrus_blob_id_test_mock_01" }
    fun sample_cert(): vector<u8>    { b"walrus_cert_mock_payload" }
    fun sample_sig(): vector<u8>     { b"device_ed25519_signature_mock_64b" }

    fun register_original(scenario: &mut Scenario, clock: &Clock): sui::object::ID {
        ts::next_tx(scenario, CREATOR);
        let ctx = ts::ctx(scenario);
        let record = media::register_media(
            sample_blob_id(),
            sample_hash(),
            sample_phash(),
            sample_sig(),
            sample_cert(),
            500,
            option::none(),
            media::edit_original(),
            string::utf8(b"Original capture — Lagos protest"),
            clock,
            ctx,
        );
        let id = sui::object::id(&record);
        sui::transfer::public_transfer(record, CREATOR);
        id
    }

    // =========================================================================
    // TEST 1 — Clean Lifecycle Flow
    // =========================================================================

    #[test]
    fun test_clean_lifecycle() {
        let mut scenario = ts::begin(CREATOR);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        // Step 1: Register original
        let original_id = register_original(&mut scenario, &clock);

        // Step 2: Verify original state
        ts::next_tx(&mut scenario, CREATOR);
        {
            let record = ts::take_from_sender<MediaRecord>(&scenario);
            assert!(media::creator(&record) == CREATOR,                       0);
            assert!(media::edit_type(&record) == media::edit_original(),      1);
            assert!(media::integrity(&record) == media::integrity_original(), 2);
            assert!(!media::is_revoked(&record),                              3);
            assert!(option::is_none(media::parent(&record)),                  4);
            assert!(media::ai_score(&record) == 500,                          5);
            ts::return_to_sender(&scenario, record);
        };

        // Step 3: Register TRIM derivative
        ts::next_tx(&mut scenario, EDITOR);
        {
            let parent_record = ts::take_from_address<MediaRecord>(&scenario, CREATOR);
            let ctx = ts::ctx(&mut scenario);

            let (child, edit_rec) = media::register_edit(
                sample_blob_id(),
                b"child_hash_sha256_mock_32_bytes!",
                sample_phash(),
                sample_sig(),
                sample_cert(),
                300,
                &parent_record,
                media::edit_trim(),
                string::utf8(b"Broadcast trim — removed first 45s"),
                &clock,
                ctx,
            );

            assert!(media::edit_type(&child) == media::edit_trim(),           6);
            assert!(media::integrity(&child) == media::integrity_modified(),  7);
            assert!(option::is_some(media::parent(&child)),                   8);
            assert!(*option::borrow(media::parent(&child)) == original_id,    9);

            sui::transfer::public_transfer(child, EDITOR);
            sui::transfer::public_transfer(edit_rec, EDITOR);
            ts::return_to_address(CREATOR, parent_record);
        };

        // Step 4: Register AI_REMIX — integrity must be AI_GENERATED
        ts::next_tx(&mut scenario, EDITOR);
        {
            let parent_record = ts::take_from_address<MediaRecord>(&scenario, CREATOR);
            let ctx = ts::ctx(&mut scenario);

            let (ai_child, ai_edit) = media::register_edit(
                sample_blob_id(),
                b"ai_remix_hash_sha256_mock_32by!",
                sample_phash(),
                sample_sig(),
                sample_cert(),
                9000,
                &parent_record,
                media::edit_ai_remix(),
                string::utf8(b"AI deepfake remix — synthetic"),
                &clock,
                ctx,
            );

            assert!(media::integrity(&ai_child) == media::integrity_ai_generated(), 10);
            assert!(media::ai_score(&ai_child) == 9000,                             11);

            sui::transfer::public_transfer(ai_child, EDITOR);
            sui::transfer::public_transfer(ai_edit, EDITOR);
            ts::return_to_address(CREATOR, parent_record);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // =========================================================================
    // TEST 2 — Revocation Access Attack (must abort ENotAuthorized)
    // =========================================================================

    #[test]
    #[expected_failure(abort_code = trace::media::ENotAuthorized)]
    fun test_revocation_unauthorized_attack() {
        let mut scenario = ts::begin(CREATOR);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        register_original(&mut scenario, &clock);

        // ATTACKER attempts to revoke CREATOR's record — must abort
        ts::next_tx(&mut scenario, ATTACKER);
        {
            let mut record = ts::take_from_address<MediaRecord>(&scenario, CREATOR);
            let rev = media::revoke_record(
                &mut record,
                0u8,
                &clock,
                ts::ctx(&mut scenario),
            );
            // RevocationRecord has store — use public_transfer
            sui::transfer::public_transfer(rev, ATTACKER);
            ts::return_to_address(CREATOR, record);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // =========================================================================
    // TEST 3 — Authorized Creator Can Revoke Once
    // =========================================================================

    #[test]
    fun test_authorized_revocation() {
        let mut scenario = ts::begin(CREATOR);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        register_original(&mut scenario, &clock);

        ts::next_tx(&mut scenario, CREATOR);
        {
            let mut record = ts::take_from_sender<MediaRecord>(&scenario);
            assert!(!media::is_revoked(&record), 0);

            let rev_record = media::revoke_record(
                &mut record,
                1u8,
                &clock,
                ts::ctx(&mut scenario),
            );

            assert!(media::is_revoked(&record), 1);

            sui::transfer::public_transfer(rev_record, CREATOR);
            ts::return_to_sender(&scenario, record);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // =========================================================================
    // TEST 4 — Double Revocation (must abort EAlreadyRevoked)
    // =========================================================================

    #[test]
    #[expected_failure(abort_code = trace::media::EAlreadyRevoked)]
    fun test_double_revocation_blocked() {
        let mut scenario = ts::begin(CREATOR);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        register_original(&mut scenario, &clock);

        // First revocation — valid
        ts::next_tx(&mut scenario, CREATOR);
        {
            let mut record = ts::take_from_sender<MediaRecord>(&scenario);
            let rev1 = media::revoke_record(&mut record, 0u8, &clock, ts::ctx(&mut scenario));
            sui::transfer::public_transfer(rev1, CREATOR);
            ts::return_to_sender(&scenario, record);
        };

        // Second revocation — must abort
        ts::next_tx(&mut scenario, CREATOR);
        {
            let mut record = ts::take_from_sender<MediaRecord>(&scenario);
            let rev2 = media::revoke_record(&mut record, 0u8, &clock, ts::ctx(&mut scenario));
            sui::transfer::public_transfer(rev2, CREATOR);
            ts::return_to_sender(&scenario, record);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // =========================================================================
    // TEST 5 — Edit on Revoked Parent (must abort EAlreadyRevoked)
    // =========================================================================

    #[test]
    #[expected_failure(abort_code = trace::media::EAlreadyRevoked)]
    fun test_edit_on_revoked_parent_blocked() {
        let mut scenario = ts::begin(CREATOR);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        register_original(&mut scenario, &clock);

        // Revoke the original
        ts::next_tx(&mut scenario, CREATOR);
        {
            let mut record = ts::take_from_sender<MediaRecord>(&scenario);
            let rev = media::revoke_record(&mut record, 2u8, &clock, ts::ctx(&mut scenario));
            sui::transfer::public_transfer(rev, CREATOR);
            ts::return_to_sender(&scenario, record);
        };

        // Attempt to register derivative of revoked parent — must abort
        ts::next_tx(&mut scenario, EDITOR);
        {
            let revoked_parent = ts::take_from_address<MediaRecord>(&scenario, CREATOR);
            let ctx = ts::ctx(&mut scenario);
            let (child, edit_rec) = media::register_edit(
                sample_blob_id(),
                b"bad_child_hash_sha256_32_bytes!_",
                sample_phash(),
                sample_sig(),
                sample_cert(),
                200,
                &revoked_parent,
                media::edit_trim(),
                string::utf8(b"Should fail — parent revoked"),
                &clock,
                ctx,
            );
            sui::transfer::public_transfer(child, EDITOR);
            sui::transfer::public_transfer(edit_rec, EDITOR);
            ts::return_to_address(CREATOR, revoked_parent);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // =========================================================================
    // TEST 6 — Derivative without parent (must abort EParentRequired)
    // =========================================================================

    #[test]
    #[expected_failure(abort_code = trace::media::EParentRequired)]
    fun test_derivative_without_parent_blocked() {
        let mut scenario = ts::begin(CREATOR);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, CREATOR);
        {
            let ctx = ts::ctx(&mut scenario);
            let record = media::register_media(
                sample_blob_id(),
                sample_hash(),
                sample_phash(),
                sample_sig(),
                sample_cert(),
                100,
                option::none(),
                media::edit_trim(),
                string::utf8(b"No parent declared — should fail"),
                &clock,
                ctx,
            );
            sui::transfer::public_transfer(record, CREATOR);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // =========================================================================
    // TEST 7 — AI Score overflow (must abort EInvalidAiScore)
    // =========================================================================

    #[test]
    #[expected_failure(abort_code = trace::media::EInvalidAiScore)]
    fun test_ai_score_overflow_blocked() {
        let mut scenario = ts::begin(CREATOR);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        ts::next_tx(&mut scenario, CREATOR);
        {
            let ctx = ts::ctx(&mut scenario);
            let record = media::register_media(
                sample_blob_id(),
                sample_hash(),
                sample_phash(),
                sample_sig(),
                sample_cert(),
                10001,
                option::none(),
                media::edit_original(),
                string::utf8(b"Invalid ai score above ceiling"),
                &clock,
                ctx,
            );
            sui::transfer::public_transfer(record, CREATOR);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }

    // =========================================================================
    // TEST 8 — AI integrity boundary at 7500 bp
    // =========================================================================

    #[test]
    fun test_ai_integrity_boundary() {
        let mut scenario = ts::begin(CREATOR);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));

        // 7500 bp → AI_GENERATED
        ts::next_tx(&mut scenario, CREATOR);
        {
            let ctx = ts::ctx(&mut scenario);
            let record = media::register_media(
                sample_blob_id(),
                sample_hash(),
                sample_phash(),
                sample_sig(),
                sample_cert(),
                7500,
                option::none(),
                media::edit_original(),
                string::utf8(b"AI boundary upper"),
                &clock,
                ctx,
            );
            assert!(media::integrity(&record) == media::integrity_ai_generated(), 0);
            sui::transfer::public_transfer(record, CREATOR);
        };

        // 7499 bp → ORIGINAL
        ts::next_tx(&mut scenario, CREATOR);
        {
            let ctx = ts::ctx(&mut scenario);
            let record = media::register_media(
                sample_blob_id(),
                sample_hash(),
                sample_phash(),
                sample_sig(),
                sample_cert(),
                7499,
                option::none(),
                media::edit_original(),
                string::utf8(b"AI boundary lower"),
                &clock,
                ctx,
            );
            assert!(media::integrity(&record) == media::integrity_original(), 1);
            sui::transfer::public_transfer(record, CREATOR);
        };

        clock::destroy_for_testing(clock);
        ts::end(scenario);
    }
}
