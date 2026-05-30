/// TRACE — Media Authenticity Protocol
/// Core provenance contract: registration, edit lineage, revocation, and on-chain display.
/// Deployed on Sui testnet: 0x3eff0f24ece1bd96bef48ba534eb498331a87cb1fb90d30de5bf1ec940cc648e
#[allow(unused_const, duplicate_alias)]
module trace::media {

    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::display;
    use sui::package;
    use std::option::{Self, Option};
    use std::string::{Self, String};

    // =========================================================================
    // Error Constants
    // =========================================================================

    const ENotAuthorized:    u64 = 1;
    const EAlreadyRevoked:   u64 = 2;
    const EInvalidEditType:  u64 = 3;
    const EParentRequired:   u64 = 4;
    const EInvalidAiScore:   u64 = 6;
    const EEmptyHash:        u64 = 7;
    const EEmptyBlobId:      u64 = 8;

    // =========================================================================
    // Edit Type Constants
    // =========================================================================

    const EDIT_ORIGINAL:    u8 = 0;
    const EDIT_TRIM:        u8 = 1;
    const EDIT_COLOR_GRADE: u8 = 2;
    const EDIT_SUBTITLE:    u8 = 3;
    const EDIT_AI_REMIX:    u8 = 4;
    const EDIT_CROP:        u8 = 5;
    const EDIT_MERGE:       u8 = 6;
    const EDIT_TRANSLATE:   u8 = 7;

    // =========================================================================
    // Integrity Status Constants
    // =========================================================================

    const INTEGRITY_ORIGINAL:     u8 = 0;
    const INTEGRITY_MODIFIED:     u8 = 1;
    const INTEGRITY_UNVERIFIED:   u8 = 2;
    const INTEGRITY_AI_GENERATED: u8 = 3;

    // =========================================================================
    // One-Time Witness (for Display)
    // =========================================================================

    /// OTW for package publisher claim
    public struct MEDIA has drop {}

    // =========================================================================
    // Structs
    // =========================================================================

    /// Root node of the provenance graph.
    /// Every registered media file is a first-class Sui object.
    public struct MediaRecord has key, store {
        id:               sui::object::UID,
        /// Walrus blob identifier — immutable reference to off-chain storage
        blob_id:          vector<u8>,
        /// SHA-256 of raw file bytes — exact integrity proof
        content_hash:     vector<u8>,
        /// pHash binary vector — loose similarity matching across re-encodes
        perceptual_hash:  vector<u8>,
        /// Ed25519 signature from capture device / enclave
        device_signature: vector<u8>,
        /// Wallet address or zkLogin identity
        creator:          address,
        /// Consensus-anchored timestamp (sui::clock)
        timestamp:        u64,
        /// Walrus storage certificate blob
        walrus_cert:      vector<u8>,
        /// AI generation probability in basis points (0–10000)
        ai_score:         u16,
        /// Pointer to parent MediaRecord; null for originals
        parent:           Option<sui::object::ID>,
        /// Edit type — maps to EDIT_* constants
        edit_type:        u8,
        /// Integrity status — maps to INTEGRITY_* constants
        integrity:        u8,
        /// On-chain revocation flag
        revoked:          bool,
        /// Human-readable description
        description:      String,
    }

    /// Declared derivative action — audit trail for every edit.
    public struct EditRecord has key, store {
        id:          sui::object::UID,
        media_id:    sui::object::ID,
        parent_id:   sui::object::ID,
        editor:      address,
        edit_type:   u8,
        timestamp:   u64,
        description: String,
    }

    /// Public revocation flag — permanently on-chain.
    /// Content cannot be deleted from Walrus; only flagged here.
    public struct RevocationRecord has key, store {
        id:        sui::object::UID,
        media_id:  sui::object::ID,
        reason:    u8,
        timestamp: u64,
        authority: address,
    }

    // =========================================================================
    // Events
    // =========================================================================

    public struct MediaRegistered has copy, drop {
        media_id:   sui::object::ID,
        blob_id:    vector<u8>,
        creator:    address,
        timestamp:  u64,
        edit_type:  u8,
        integrity:  u8,
        has_parent: bool,
    }

    public struct EditRegistered has copy, drop {
        edit_record_id: sui::object::ID,
        media_id:       sui::object::ID,
        parent_id:      sui::object::ID,
        editor:         address,
        edit_type:      u8,
        timestamp:      u64,
    }

    public struct RecordRevoked has copy, drop {
        media_id:  sui::object::ID,
        reason:    u8,
        authority: address,
        timestamp: u64,
    }

    // =========================================================================
    // Init — sets up Display for MediaRecord
    // =========================================================================

    fun init(otw: MEDIA, ctx: &mut sui::tx_context::TxContext) {
        let publisher = package::claim(otw, ctx);

        let mut display_obj = display::new<MediaRecord>(&publisher, ctx);
        display_obj.add(string::utf8(b"name"),        string::utf8(b"TRACE Media Record"));
        display_obj.add(string::utf8(b"description"), string::utf8(b"Cryptographic provenance record anchored on Sui + Walrus"));
        display_obj.add(string::utf8(b"creator"),     string::utf8(b"{creator}"));
        display_obj.add(string::utf8(b"timestamp"),   string::utf8(b"{timestamp}"));
        display_obj.add(string::utf8(b"integrity"),   string::utf8(b"{integrity}"));
        display_obj.add(string::utf8(b"blob_id"),     string::utf8(b"{blob_id}"));
        display_obj.update_version();

        sui::transfer::public_transfer(publisher, sui::tx_context::sender(ctx));
        sui::transfer::public_transfer(display_obj, sui::tx_context::sender(ctx));
    }

    // =========================================================================
    // Entry Functions — callable from PTBs and CLI
    // =========================================================================

    /// Register a new piece of media and transfer to sender.
    /// entry: callable directly from PTBs without a wrapper.
    entry fun register_media_entry(
        blob_id:          vector<u8>,
        content_hash:     vector<u8>,
        perceptual_hash:  vector<u8>,
        device_signature: vector<u8>,
        walrus_cert:      vector<u8>,
        ai_score:         u16,
        parent:           Option<sui::object::ID>,
        edit_type:        u8,
        description:      vector<u8>,
        clock:            &Clock,
        ctx:              &mut sui::tx_context::TxContext,
    ) {
        let record = register_media(
            blob_id, content_hash, perceptual_hash, device_signature,
            walrus_cert, ai_score, parent, edit_type,
            string::utf8(description), clock, ctx,
        );
        sui::transfer::transfer(record, sui::tx_context::sender(ctx));
    }

    /// Register a derivative edit, linking child → parent.
    entry fun register_edit_entry(
        blob_id:          vector<u8>,
        content_hash:     vector<u8>,
        perceptual_hash:  vector<u8>,
        device_signature: vector<u8>,
        walrus_cert:      vector<u8>,
        ai_score:         u16,
        parent_record:    &MediaRecord,
        edit_type:        u8,
        description:      vector<u8>,
        clock:            &Clock,
        ctx:              &mut sui::tx_context::TxContext,
    ) {
        let (child, edit_rec) = register_edit(
            blob_id, content_hash, perceptual_hash, device_signature,
            walrus_cert, ai_score, parent_record, edit_type,
            string::utf8(description), clock, ctx,
        );
        let sender = sui::tx_context::sender(ctx);
        sui::transfer::transfer(child, sender);
        sui::transfer::transfer(edit_rec, sender);
    }

    /// Revoke a media record. Restricted to original creator.
    entry fun revoke_record_entry(
        record: &mut MediaRecord,
        reason: u8,
        clock:  &Clock,
        ctx:    &mut sui::tx_context::TxContext,
    ) {
        let rev = revoke_record(record, reason, clock, ctx);
        sui::transfer::transfer(rev, sui::tx_context::sender(ctx));
    }

    // =========================================================================
    // Public Functions — composable in PTBs, return objects
    // =========================================================================

    public fun register_media(
        blob_id:          vector<u8>,
        content_hash:     vector<u8>,
        perceptual_hash:  vector<u8>,
        device_signature: vector<u8>,
        walrus_cert:      vector<u8>,
        ai_score:         u16,
        parent:           Option<sui::object::ID>,
        edit_type:        u8,
        description:      String,
        clock:            &Clock,
        ctx:              &mut sui::tx_context::TxContext,
    ): MediaRecord {
        assert!(std::vector::length(&blob_id) > 0,      EEmptyBlobId);
        assert!(std::vector::length(&content_hash) > 0, EEmptyHash);
        assert!(ai_score <= 10000,                       EInvalidAiScore);
        assert!(edit_type <= EDIT_TRANSLATE,             EInvalidEditType);

        let is_derivative = edit_type != EDIT_ORIGINAL;
        if (is_derivative) {
            assert!(option::is_some(&parent), EParentRequired);
        };

        let integrity  = derive_integrity(edit_type, ai_score);
        let timestamp  = clock::timestamp_ms(clock);
        let creator    = sui::tx_context::sender(ctx);

        let record = MediaRecord {
            id: sui::object::new(ctx),
            blob_id,
            content_hash,
            perceptual_hash,
            device_signature,
            creator,
            timestamp,
            walrus_cert,
            ai_score,
            parent,
            edit_type,
            integrity,
            revoked: false,
            description,
        };

        let media_id = sui::object::id(&record);

        event::emit(MediaRegistered {
            media_id,
            blob_id: record.blob_id,
            creator,
            timestamp,
            edit_type,
            integrity,
            has_parent: option::is_some(&record.parent),
        });

        record
    }

    public fun register_edit(
        blob_id:          vector<u8>,
        content_hash:     vector<u8>,
        perceptual_hash:  vector<u8>,
        device_signature: vector<u8>,
        walrus_cert:      vector<u8>,
        ai_score:         u16,
        parent_record:    &MediaRecord,
        edit_type:        u8,
        description:      String,
        clock:            &Clock,
        ctx:              &mut sui::tx_context::TxContext,
    ): (MediaRecord, EditRecord) {
        assert!(!parent_record.revoked,        EAlreadyRevoked);
        assert!(edit_type != EDIT_ORIGINAL,    EInvalidEditType);
        assert!(edit_type <= EDIT_TRANSLATE,   EInvalidEditType);
        assert!(ai_score <= 10000,             EInvalidAiScore);

        let parent_id = sui::object::id(parent_record);

        let media = register_media(
            blob_id, content_hash, perceptual_hash, device_signature,
            walrus_cert, ai_score, option::some(parent_id), edit_type,
            description, clock, ctx,
        );

        let media_id  = sui::object::id(&media);
        let editor    = sui::tx_context::sender(ctx);
        let timestamp = clock::timestamp_ms(clock);

        let edit_record = EditRecord {
            id: sui::object::new(ctx),
            media_id,
            parent_id,
            editor,
            edit_type,
            timestamp,
            description: media.description,
        };

        let edit_record_id = sui::object::id(&edit_record);

        event::emit(EditRegistered {
            edit_record_id,
            media_id,
            parent_id,
            editor,
            edit_type,
            timestamp,
        });

        (media, edit_record)
    }

    public fun revoke_record(
        record:    &mut MediaRecord,
        reason:    u8,
        clock:     &Clock,
        ctx:       &mut sui::tx_context::TxContext,
    ): RevocationRecord {
        let caller = sui::tx_context::sender(ctx);
        assert!(caller == record.creator, ENotAuthorized);
        assert!(!record.revoked,          EAlreadyRevoked);

        record.revoked = true;

        let media_id  = sui::object::id(record);
        let timestamp = clock::timestamp_ms(clock);

        event::emit(RecordRevoked {
            media_id,
            reason,
            authority: caller,
            timestamp,
        });

        RevocationRecord {
            id:        sui::object::new(ctx),
            media_id,
            reason,
            timestamp,
            authority: caller,
        }
    }

    // =========================================================================
    // Read-Only Accessors
    // =========================================================================

    public fun creator(r: &MediaRecord): address               { r.creator }
    public fun is_revoked(r: &MediaRecord): bool               { r.revoked }
    public fun integrity(r: &MediaRecord): u8                  { r.integrity }
    public fun edit_type(r: &MediaRecord): u8                  { r.edit_type }
    public fun ai_score(r: &MediaRecord): u16                  { r.ai_score }
    public fun timestamp(r: &MediaRecord): u64                 { r.timestamp }
    public fun content_hash(r: &MediaRecord): &vector<u8>      { &r.content_hash }
    public fun blob_id(r: &MediaRecord): &vector<u8>           { &r.blob_id }
    public fun parent(r: &MediaRecord): &Option<sui::object::ID> { &r.parent }
    public fun description(r: &MediaRecord): &String           { &r.description }

    // Expose edit type constants
    public fun edit_original():    u8 { EDIT_ORIGINAL }
    public fun edit_trim():        u8 { EDIT_TRIM }
    public fun edit_color_grade(): u8 { EDIT_COLOR_GRADE }
    public fun edit_subtitle():    u8 { EDIT_SUBTITLE }
    public fun edit_ai_remix():    u8 { EDIT_AI_REMIX }
    public fun edit_crop():        u8 { EDIT_CROP }

    // Expose integrity constants
    public fun integrity_original():     u8 { INTEGRITY_ORIGINAL }
    public fun integrity_modified():     u8 { INTEGRITY_MODIFIED }
    public fun integrity_unverified():   u8 { INTEGRITY_UNVERIFIED }
    public fun integrity_ai_generated(): u8 { INTEGRITY_AI_GENERATED }

    // Expose error constants for tests
    public fun e_not_authorized():   u64 { ENotAuthorized }
    public fun e_already_revoked():  u64 { EAlreadyRevoked }
    public fun e_parent_required():  u64 { EParentRequired }
    public fun e_invalid_ai_score(): u64 { EInvalidAiScore }

    // =========================================================================
    // Internal Helpers
    // =========================================================================

    fun derive_integrity(edit_type: u8, ai_score: u16): u8 {
        if (edit_type == EDIT_ORIGINAL) {
            if (ai_score >= 7500) { INTEGRITY_AI_GENERATED }
            else { INTEGRITY_ORIGINAL }
        } else if (edit_type == EDIT_AI_REMIX || ai_score >= 7500) {
            INTEGRITY_AI_GENERATED
        } else {
            INTEGRITY_MODIFIED
        }
    }
}
