#[allow(duplicate_alias, unused_const)]
module trace::seal_policy {
    use sui::event;

    // ── Access tiers ──────────────────────────────────────────────────────────
    const TIER_PUBLIC:        u8 = 0;
    const TIER_VERIFIER:      u8 = 1;
    const TIER_INSTITUTIONAL: u8 = 2;

    // ── Error codes ───────────────────────────────────────────────────────────
    const ENotAuthorized:  u64 = 1;
    const EInvalidTier:    u64 = 2;
    const EAlreadyRevoked: u64 = 3;

    // Expose error codes for tests
    public fun err_not_authorized():  u64 { ENotAuthorized }
    public fun err_invalid_tier():    u64 { EInvalidTier }
    public fun err_already_revoked(): u64 { EAlreadyRevoked }

    // ── Access policy object ──────────────────────────────────────────────────
    public struct BankAccessPolicy has key, store {
        id:                UID,
        admin:             address,
        verifier_count:    u64,
        institution_count: u64,
    }

    // ── Verifier credential ───────────────────────────────────────────────────
    public struct VerifierCredential has key, store {
        id:      UID,
        holder:  address,
        tier:    u8,
        issued:  u64,
        revoked: bool,
    }

    // ── Events ────────────────────────────────────────────────────────────────
    public struct CredentialIssued has copy, drop {
        credential_id: address,
        holder:        address,
        tier:          u8,
    }

    public struct CredentialRevoked has copy, drop {
        credential_id: address,
        holder:        address,
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    fun init(ctx: &mut TxContext) {
        let policy = BankAccessPolicy {
            id:                object::new(ctx),
            admin:             ctx.sender(),
            verifier_count:    0,
            institution_count: 0,
        };
        transfer::share_object(policy);
    }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(ctx);
    }

    // ── Issue verifier credential ─────────────────────────────────────────────
    public fun issue_credential(
        policy:    &mut BankAccessPolicy,
        recipient: address,
        tier:      u8,
        ctx:       &mut TxContext,
    ) {
        assert!(ctx.sender() == policy.admin, ENotAuthorized);
        assert!(tier == TIER_VERIFIER || tier == TIER_INSTITUTIONAL, EInvalidTier);

        let credential = VerifierCredential {
            id:      object::new(ctx),
            holder:  recipient,
            tier,
            issued:  0,
            revoked: false,
        };

        let id = object::uid_to_address(&credential.id);

        if (tier == TIER_INSTITUTIONAL) {
            policy.institution_count = policy.institution_count + 1;
        } else {
            policy.verifier_count = policy.verifier_count + 1;
        };

        event::emit(CredentialIssued { credential_id: id, holder: recipient, tier });
        transfer::transfer(credential, recipient);
    }

    // ── Seal approve function ─────────────────────────────────────────────────
    // Called by Seal key servers to authorize decryption of sighting records.
    // Presenter must hold a valid, non-revoked VerifierCredential.
    public fun seal_approve(
        credential: &VerifierCredential,
        _id:        vector<u8>,
        ctx:        &TxContext,
    ) {
        assert!(!credential.revoked, ENotAuthorized);
        assert!(credential.holder == ctx.sender(), ENotAuthorized);
        assert!(
            credential.tier == TIER_VERIFIER || credential.tier == TIER_INSTITUTIONAL,
            EInvalidTier
        );
    }

    // ── Revoke credential ─────────────────────────────────────────────────────
    public fun revoke_credential(
        policy:     &BankAccessPolicy,
        credential: &mut VerifierCredential,
        ctx:        &TxContext,
    ) {
        assert!(ctx.sender() == policy.admin, ENotAuthorized);
        assert!(!credential.revoked, EAlreadyRevoked);
        credential.revoked = true;
        let id = object::uid_to_address(&credential.id);
        event::emit(CredentialRevoked { credential_id: id, holder: credential.holder });
    }

    // ── View functions ────────────────────────────────────────────────────────
    public fun is_valid_verifier(credential: &VerifierCredential): bool {
        !credential.revoked &&
            (credential.tier == TIER_VERIFIER || credential.tier == TIER_INSTITUTIONAL)
    }

    public fun get_tier(credential: &VerifierCredential): u8 {
        credential.tier
    }
}
