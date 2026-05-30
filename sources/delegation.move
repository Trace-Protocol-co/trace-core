/// TRACE — Delegation System (F-6)
/// Allows organizations to delegate signing authority to sub-wallets.
/// Content signed by a delegate inherits the organization's root verification.
/// Revocation of a delegate does NOT invalidate previously signed content.
module trace::delegation {

    use sui::clock::{Self, Clock};
    use sui::event;
    use std::string::{Self, String};

    // =========================================================================
    // Error Constants
    // =========================================================================

    const ENotOrgRoot:          u64 = 1;
    const EAlreadyRevoked:      u64 = 2;
    const ENotDelegate:         u64 = 4;
    const ESelfDelegation:      u64 = 5;

    // =========================================================================
    // Structs
    // =========================================================================

    /// Root authority object owned by an organization.
    /// The holder of this object can issue and revoke delegation records.
    public struct OrgRoot has key, store {
        id:           sui::object::UID,
        /// Organization name e.g. "Reuters", "BBC Africa"
        name:         String,
        /// Root wallet — the organization's primary signing address
        authority:    address,
        /// Creation timestamp
        created_at:   u64,
        /// Total delegates ever issued (monotonic counter)
        delegate_count: u64,
    }

    /// A delegation grant — issued by OrgRoot to a sub-wallet (reporter/desk).
    /// This object lives in the delegate's wallet.
    public struct DelegationRecord has key, store {
        id:           sui::object::UID,
        /// The Sui object ID of the parent OrgRoot
        org_id:       sui::object::ID,
        /// Organization name (denormalized for display)
        org_name:     String,
        /// The organization root address that issued this
        org_authority: address,
        /// The delegate's wallet address
        delegate:     address,
        /// Human-readable role e.g. "Lagos Bureau Reporter"
        role:         String,
        /// When this delegation was granted
        granted_at:   u64,
        /// Whether this delegation has been revoked
        revoked:      bool,
        /// When revoked (0 if not revoked)
        revoked_at:   u64,
    }

    /// Revocation receipt — stays in org's possession as audit trail.
    public struct RevocationReceipt has key, store {
        id:             sui::object::UID,
        delegation_id:  sui::object::ID,
        delegate:       address,
        org_authority:  address,
        revoked_at:     u64,
        reason:         String,
    }

    // =========================================================================
    // Events
    // =========================================================================

    public struct OrgRegistered has copy, drop {
        org_id:    sui::object::ID,
        name:      String,
        authority: address,
        timestamp: u64,
    }

    public struct DelegateGranted has copy, drop {
        delegation_id: sui::object::ID,
        org_id:        sui::object::ID,
        org_name:      String,
        delegate:      address,
        role:          String,
        granted_at:    u64,
    }

    public struct DelegateRevoked has copy, drop {
        delegation_id: sui::object::ID,
        org_id:        sui::object::ID,
        delegate:      address,
        revoked_at:    u64,
    }

    // =========================================================================
    // Entry Functions
    // =========================================================================

    /// Register a new organization root.
    /// The caller becomes the org authority — they own the OrgRoot object.
    entry fun register_org(
        name:  vector<u8>,
        clock: &Clock,
        ctx:   &mut sui::tx_context::TxContext,
    ) {
        let authority  = sui::tx_context::sender(ctx);
        let timestamp  = clock::timestamp_ms(clock);

        let org = OrgRoot {
            id:             sui::object::new(ctx),
            name:           string::utf8(name),
            authority,
            created_at:     timestamp,
            delegate_count: 0,
        };

        let org_id = sui::object::id(&org);

        event::emit(OrgRegistered {
            org_id,
            name:      org.name,
            authority,
            timestamp,
        });

        sui::transfer::transfer(org, authority);
    }

    /// Grant delegation to a sub-wallet.
    /// Only the OrgRoot holder can call this.
    /// The DelegationRecord is sent to the delegate's wallet.
    entry fun grant_delegation(
        org:      &mut OrgRoot,
        delegate: address,
        role:     vector<u8>,
        clock:    &Clock,
        ctx:      &mut sui::tx_context::TxContext,
    ) {
        let caller = sui::tx_context::sender(ctx);
        assert!(caller == org.authority, ENotOrgRoot);
        assert!(delegate != caller,      ESelfDelegation);

        let granted_at = clock::timestamp_ms(clock);
        org.delegate_count = org.delegate_count + 1;

        let org_id = sui::object::id(org);

        let record = DelegationRecord {
            id:            sui::object::new(ctx),
            org_id,
            org_name:      org.name,
            org_authority: org.authority,
            delegate,
            role:          string::utf8(role),
            granted_at,
            revoked:       false,
            revoked_at:    0,
        };

        let delegation_id = sui::object::id(&record);

        event::emit(DelegateGranted {
            delegation_id,
            org_id,
            org_name:  org.name,
            delegate,
            role:      record.role,
            granted_at,
        });

        // Send DelegationRecord to the delegate's wallet
        sui::transfer::transfer(record, delegate);
    }

    /// Revoke a delegation.
    /// Only the OrgRoot holder can revoke.
    /// Previously signed content remains valid — revocation is forward-only.
    entry fun revoke_delegation(
        org:        &OrgRoot,
        delegation: &mut DelegationRecord,
        reason:     vector<u8>,
        clock:      &Clock,
        ctx:        &mut sui::tx_context::TxContext,
    ) {
        let caller = sui::tx_context::sender(ctx);
        assert!(caller == org.authority,                 ENotOrgRoot);
        assert!(sui::object::id(org) == delegation.org_id, ENotDelegate);
        assert!(!delegation.revoked,                     EAlreadyRevoked);

        let revoked_at = clock::timestamp_ms(clock);
        delegation.revoked    = true;
        delegation.revoked_at = revoked_at;

        let delegation_id = sui::object::id(delegation);
        let org_id        = sui::object::id(org);

        event::emit(DelegateRevoked {
            delegation_id,
            org_id,
            delegate:   delegation.delegate,
            revoked_at,
        });

        let receipt = RevocationReceipt {
            id:            sui::object::new(ctx),
            delegation_id,
            delegate:      delegation.delegate,
            org_authority: org.authority,
            revoked_at,
            reason:        string::utf8(reason),
        };

        sui::transfer::transfer(receipt, org.authority);
    }

    // =========================================================================
    // Read-Only Accessors
    // =========================================================================

    public fun org_authority(org: &OrgRoot): address         { org.authority }
    public fun org_name(org: &OrgRoot): &String              { &org.name }
    public fun delegate_count(org: &OrgRoot): u64            { org.delegate_count }
    public fun is_delegation_valid(d: &DelegationRecord): bool { !d.revoked }
    public fun delegation_org_id(d: &DelegationRecord): sui::object::ID { d.org_id }
    public fun delegation_delegate(d: &DelegationRecord): address { d.delegate }
    public fun delegation_org_authority(d: &DelegationRecord): address { d.org_authority }
    public fun delegation_role(d: &DelegationRecord): &String { &d.role }

    public fun receipt_delegate(r: &RevocationReceipt): address { r.delegate }
    public fun receipt_org_authority(r: &RevocationReceipt): address { r.org_authority }

    // Expose error constants for tests
    public fun e_not_org_root():     u64 { ENotOrgRoot }
    public fun e_already_revoked():  u64 { EAlreadyRevoked }
    public fun e_self_delegation():  u64 { ESelfDelegation }
    public fun e_not_delegate():     u64 { ENotDelegate }
}
