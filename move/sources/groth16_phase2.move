// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/// On-chain coordination for a Groth16 trusted-setup ceremony.
///
/// A single shared `Ceremony` object is the source of truth. Its lifecycle is a
/// linear `Phase`:
///   Setup            — created; auditors attest the circuit `r1cs` matches what's
///                       expected (phase 1 is external/public — see `phase1_digest`).
///   Phase2Contribute — the head is seeded; contributions (open, or limited to an
///                       allowlist) advance an ordered chain (the `slot` governs each
///                       round); the organizer (`OrganizerCap`, both admin and
///                       attestor) verifies each off-chain and `accept`s it.
///   Phase2Beacon     — a second beacon is drawn; contributions are frozen and the
///                       organizer makes a final sealing contribution with it.
///   Closed           — sealed; the head is final and immutable; final zkey/vkey
///                       blob ids point auditors at the published artifacts.
///
/// Each transition emits `PhaseAdvanced`; the per-transition data (beacons, head,
/// counts) lives on the object.
///
/// Note on `blob_id`: every `blob_id` field/argument here is the object id of the
/// `walrus::shared_blob::SharedBlob` wrapping the params — NOT the Walrus content
/// blob id. Storing the SharedBlob keeps each artifact community-fundable (anyone
/// can extend its storage) despite contributions coming from throwaway CLI keys.
/// The contract does no Walrus validation; off-chain verification resolves the
/// SharedBlob to confirm it's shared, certified, permanent, and long-lived, and to
/// read the content blob id it wraps. Hence no Walrus dependency in `Move.toml`.
module ceremony::groth16_phase2;

use std::string::String;
use sui::clock::Clock;
use sui::event;
use sui::random::{Self, Random};
use sui::vec_set::{Self, VecSet};

// === Errors ===

#[error]
const ESlotNotOpen: vector<u8> = b"The contribution slot is not open.";
#[error]
const ENotClaimant: vector<u8> = b"Only the current claimant may submit to this slot.";
#[error]
const EExpired: vector<u8> = b"The claim deadline has passed; reopen the slot first.";
#[error]
const ENotPending: vector<u8> = b"No contribution is pending verification.";
#[error]
const ENotExpired: vector<u8> = b"The current claim has not expired yet.";
#[error]
const EWrongPhase: vector<u8> = b"The ceremony is not in the phase required for this action.";
#[error]
const EWrongCeremony: vector<u8> = b"This OrganizerCap belongs to a different ceremony.";
#[error]
const EHeadChanged: vector<u8> = b"The ceremony head does not match the expected head.";
#[error]
const EPendingChanged: vector<u8> = b"The pending contribution does not match the expected contribution.";
#[error]
const ENotAuditor: vector<u8> = b"The caller is not a designated auditor.";
#[error]
const EAlreadyApproved: vector<u8> = b"This auditor has already approved the r1cs.";
#[error]
const ENotApproved: vector<u8> = b"Not enough auditor approvals to start phase 2.";
#[error]
const EBadThreshold: vector<u8> = b"Approval threshold exceeds the number of auditors.";
#[error]
const EZeroThresholdWithAuditors: vector<u8> = b"Threshold must be at least 1 when auditors are listed; pass no auditors to skip approval.";
#[error]
const ENotAllowed: vector<u8> = b"The sender is not on the ceremony's contributor allowlist.";
#[error]
const EBadAccessMode: vector<u8> = b"Access mode must be PERMISSIONLESS (0) or PERMISSIONED (1).";
#[error]
const EDuplicateAddress: vector<u8> = b"The auditors or allowlist contains a duplicate address.";
#[error]
const EInvalidContributionHash: vector<u8> = b"Contribution hash must be 64 bytes.";
#[error]
const EInvalidPhase1Digest: vector<u8> = b"Phase-1 digest must be 64 bytes (BLAKE2b-512).";
#[error]
const EInvalidName: vector<u8> = b"Contribution name is too long.";
#[error]
const EInvalidUrl: vector<u8> = b"Coordinator URL is too long.";
#[error]
const EInvalidSlotDuration: vector<u8> = b"Slot duration must be positive and at most one hour.";
#[error]
const ESlotDeadlineOverflow: vector<u8> = b"Slot duration exceeds the remaining timestamp range.";

// === Constants ===

/// Bound how long an abandoned claim can block ceremony progress.
const MAX_SLOT_DURATION_MS: u64 = 60 * 60 * 1000;

/// Max bytes of a contribution `name`, a super long name can freeze ceremony
const MAX_NAME_BYTES: u64 = 64;

/// Max bytes of `coordinator_url`, this is just for the sanity to make sure
/// all adjustable variables have an upper bound.
const MAX_URL_BYTES: u64 = 256;

/// Access mode passed to `create_ceremony`.
const PERMISSIONLESS: u8 = 0; // anyone may contribute
const PERMISSIONED: u8 = 1;   // only allowlisted addresses may contribute

// === Structs ===

/// Minted to whoever `create_ceremony`s; that organizer is both admin and
/// attestor. Bound to its `Ceremony`, so a cap minted for another ceremony
/// (anyone may create one) is useless here.
public struct OrganizerCap has key, store { id: UID, ceremony: ID }

/// The ceremony lifecycle. Advances strictly forward.
public enum Phase has copy, drop, store {
    Setup,            // created; phase-1 beacon drawn; gathering auditor approvals
    Phase2Contribute, // head seeded; contributions open (governed by `slot`)
    Phase2Beacon,     // final beacon drawn; contributions frozen; awaiting the seal
    Closed,           // sealed; head final and immutable
}

public struct Contribution has copy, drop, store {
    contributor: address,
    blob_id: ID,
    contribution_hash: vector<u8>,
    name: String,
    ts_ms: u64,
}

/// The within-`Phase2Contribute` round state machine.
public enum Slot has drop, store {
    Open,
    Claimed { who: address, until_ms: u64 },
    Pending { who: address, blob_id: ID, contribution_hash: vector<u8>, name: String },
}

public struct Ceremony has key {
    id: UID,
    phase: Phase,
    organizer: address,         // creator and admin; receives leftovers from funded permissioned contributors
    permissioned: bool,         // true = only allowlisted addresses may contribute; switchable via set_access_mode
    // setup
    phase1_digest: vector<u8>,  // BLAKE2b-512 of the public phase1/pot_final.ptau the genesis is built from
    r1cs_blob_id: ID,           // SharedBlob object of the circuit r1cs the auditors attest to
    auditors: vector<address>,  // who may approve the r1cs
    threshold: u64,             // how many distinct approvals start_phase_2 requires
    approvals: vector<address>, // auditors who have approved so far
    allowlist: Option<VecSet<address>>, // who may claim while permissioned; retained across mode switches; none until first permissioned
    // phase 2
    chain: vector<Contribution>,
    head_blob_id: ID,           // pointer to the latest accepted params' SharedBlob (genesis, then each contribution)
    slot: Slot,
    slot_duration_ms: u64,      // organizer-selected window for future claims
    final_beacon: vector<u8>,   // drawn entering Phase2Beacon; entropy for the seal
    final_zkey_blob_id: ID,     // SharedBlob of the final full zkey, set on close
    final_vkey_blob_id: ID,     // SharedBlob of the final verification key JSON, set on close
    coordinator_url: String,    // coordinator HTTP base URL for requests + telemetry; empty = none
}

// === Events ===

/// Emitted on every phase transition (`phase` is the new phase).
public struct PhaseAdvanced has copy, drop { ceremony: ID, phase: Phase }
public struct R1csApproved has copy, drop { auditor: address, count: u64 }
public struct SlotClaimed has copy, drop { who: address }
public struct ContributionSubmitted has copy, drop { who: address, blob_id: ID, contribution_hash: vector<u8> }
public struct ContributionAccepted has copy, drop { who: address, blob_id: ID, contribution_hash: vector<u8>, index: u64 }
public struct ContributionRejected has copy, drop { who: address }
public struct ContributorsAdded has copy, drop { addrs: vector<address> }
public struct ContributorsRemoved has copy, drop { addrs: vector<address> }
public struct AccessModeChanged has copy, drop { ceremony: ID, permissioned: bool }
public struct SlotDurationChanged has copy, drop { ceremony: ID, slot_duration_ms: u64 }

// === Helpers ===

fun check_cap(cap: &OrganizerCap, c: &Ceremony) {
    assert!(cap.ceremony == object::id(c), EWrongCeremony);
}

/// Abort if `v` lists the same address twice.
fun assert_unique(v: &vector<address>) {
    let n = v.length();
    let mut i = 0;
    while (i < n) {
        let mut j = i + 1;
        while (j < n) {
            assert!(*v.borrow(i) != *v.borrow(j), EDuplicateAddress);
            j = j + 1;
        };
        i = i + 1;
    };
}

fun check_contribution_hash(h: &vector<u8>) {
    assert!(h.length() == 64, EInvalidContributionHash);
}

fun check_name(n: &String) {
    assert!(n.length() <= MAX_NAME_BYTES, EInvalidName);
}

fun check_url(u: &String) {
    assert!(u.length() <= MAX_URL_BYTES, EInvalidUrl);
}

// === Setup ===

/// Create and share a ceremony. `phase1_digest` commits to the adopted public
/// phase1/pot_final.ptau the genesis is built from; `r1cs_blob_id` is the SharedBlob of the
/// circuit r1cs the auditors attest to; `threshold`-of-`auditors` approvals are required to start
/// phase 2 — listing no auditors (threshold 0) skips approval entirely, while listing
/// auditors requires `threshold >= 1` so they cannot be silently bypassed;
/// `coordinator_url` is where the CLI reaches coordinator HTTP (pass ""). If
/// `mode` is `PERMISSIONED`, only the `allowed` addresses (which the organizer can later
/// add to / remove from) may contribute; otherwise contributions are open and
/// `allowed` is ignored. `slot_duration_ms` must be positive and at most one hour; it sets the initial claim
/// window for this ceremony. The `OrganizerCap` is transferred to the sender.
public fun create_ceremony(
    phase1_digest: vector<u8>,
    r1cs_blob_id: ID,
    auditors: vector<address>,
    threshold: u64,
    coordinator_url: String,
    mode: u8,
    allowed: vector<address>,
    slot_duration_ms: u64,
    ctx: &mut TxContext,
) {
    // The digest is the only binding to the adopted phase-1 file; a shorter or
    // empty value would leave the ceremony without a phase-1 commitment for
    // auditors to check against. So lets force this.
    assert!(phase1_digest.length() == 64, EInvalidPhase1Digest);
    assert_unique(&auditors);
    assert!(threshold <= auditors.length(), EBadThreshold);
    assert!(threshold > 0 || auditors.is_empty(), EZeroThresholdWithAuditors);
    assert!(mode == PERMISSIONLESS || mode == PERMISSIONED, EBadAccessMode);
    check_url(&coordinator_url);
    assert!(slot_duration_ms > 0 && slot_duration_ms <= MAX_SLOT_DURATION_MS, EInvalidSlotDuration);
    let permissioned = mode == PERMISSIONED;
    let allowlist = if (permissioned) {
        assert_unique(&allowed);
        let mut set = vec_set::empty();
        let mut i = 0;
        let n = allowed.length();
        while (i < n) {
            set.insert(*allowed.borrow(i));
            i = i + 1;
        };
        option::some(set)
    } else {
        option::none()
    };
    let cer = Ceremony {
        id: object::new(ctx),
        phase: Phase::Setup,
        organizer: ctx.sender(),
        permissioned,
        phase1_digest,
        r1cs_blob_id,
        auditors,
        threshold,
        approvals: vector[],
        allowlist,
        chain: vector[],
        head_blob_id: object::id_from_address(@0x0), // set on start_phase_2
        slot: Slot::Open,
        slot_duration_ms,
        final_beacon: vector[],
        final_zkey_blob_id: object::id_from_address(@0x0),
        final_vkey_blob_id: object::id_from_address(@0x0),
        coordinator_url,
    };
    let ceremony = object::id(&cer);
    event::emit(PhaseAdvanced { ceremony, phase: Phase::Setup });
    transfer::share_object(cer);
    transfer::transfer(OrganizerCap { id: object::new(ctx), ceremony }, ctx.sender());
}

/// An auditor attests that `r1cs_blob_id` is the expected circuit. The auditor
/// resolves the SharedBlob to the content blob id (content-addressed) and checks
/// it off-chain before approving, attesting to the exact r1cs bytes.
public fun approve_r1cs(c: &mut Ceremony, ctx: &TxContext) {
    match (&c.phase) { Phase::Setup => (), _ => abort EWrongPhase };
    let who = ctx.sender();
    assert!(c.auditors.contains(&who), ENotAuditor);
    assert!(!c.approvals.contains(&who), EAlreadyApproved);
    c.approvals.push_back(who);
    event::emit(R1csApproved { auditor: who, count: c.approvals.length() });
}

/// Seed the phase-2 head with the genesis params and open contributions
/// (Setup -> Phase2Contribute). Requires `threshold` auditor approvals.
public fun start_phase_2(cap: &OrganizerCap, c: &mut Ceremony, genesis_blob_id: ID) {
    check_cap(cap, c);
    match (&c.phase) { Phase::Setup => (), _ => abort EWrongPhase };
    assert!(c.approvals.length() >= c.threshold, ENotApproved);
    c.head_blob_id = genesis_blob_id;
    c.phase = Phase::Phase2Contribute;
    event::emit(PhaseAdvanced { ceremony: object::id(c), phase: Phase::Phase2Contribute });
}

// === Phase 2: coordinator (OrganizerCap) ===

/// Verified off-chain: record the pending contribution and advance the head.
public fun accept(
    cap: &OrganizerCap, c: &mut Ceremony, expected_head_blob_id: ID,
    expected_pending_blob_id: ID, expected_pending_hash: vector<u8>, expected_who: address, clock: &Clock,
) {
    check_cap(cap, c);
    match (&c.phase) { Phase::Phase2Contribute => (), _ => abort EWrongPhase };
    let (who, blob_id, contribution_hash, name) = match (&c.slot) {
        Slot::Pending { who, blob_id, contribution_hash, name } => (*who, *blob_id, *contribution_hash, *name),
        _ => abort ENotPending,
    };
    assert!(c.head_blob_id == expected_head_blob_id, EHeadChanged);
    assert!(blob_id == expected_pending_blob_id && contribution_hash == expected_pending_hash && who == expected_who, EPendingChanged);
    c.head_blob_id = blob_id;
    c.chain.push_back(Contribution { contributor: who, blob_id, contribution_hash, name, ts_ms: clock.timestamp_ms() });
    c.slot = Slot::Open;
    event::emit(ContributionAccepted { who, blob_id, contribution_hash, index: c.chain.length() - 1 });
}

/// Failed verification: drop the pending contribution and reopen the slot.
public fun reject(cap: &OrganizerCap, c: &mut Ceremony, expected_pending_blob_id: ID, expected_pending_hash: vector<u8>, expected_who: address) {
    check_cap(cap, c);
    match (&c.phase) { Phase::Phase2Contribute => (), _ => abort EWrongPhase };
    let (who, blob_id, contribution_hash) = match (&c.slot) {
        Slot::Pending { who, blob_id, contribution_hash, .. } => (*who, *blob_id, *contribution_hash),
        _ => abort ENotPending,
    };
    assert!(blob_id == expected_pending_blob_id && contribution_hash == expected_pending_hash && who == expected_who, EPendingChanged);
    c.slot = Slot::Open;
    event::emit(ContributionRejected { who });
}

/// Draw the phase-2 final beacon and freeze the ceremony to contributors
/// (Phase2Contribute -> Phase2Beacon). Private + entry, per Sui's randomness rules.
entry fun finalize_phase2(cap: &OrganizerCap, c: &mut Ceremony, r: &Random, ctx: &mut TxContext) {
    check_cap(cap, c);
    match (&c.phase) { Phase::Phase2Contribute => (), _ => abort EWrongPhase };
    match (&c.slot) { Slot::Open => (), _ => abort ESlotNotOpen };
    let mut gen = random::new_generator(r, ctx);
    c.final_beacon = gen.generate_bytes(32);
    c.phase = Phase::Phase2Beacon;
    event::emit(PhaseAdvanced { ceremony: object::id(c), phase: Phase::Phase2Beacon });
}

/// The coordinator's final sealing contribution, made off-chain with
/// `final_beacon` as entropy. Appended directly (no slot dance), then the
/// ceremony is closed — the head is now final and immutable
/// (Phase2Beacon -> Closed).
public fun submit_final(
    cap: &OrganizerCap,
    c: &mut Ceremony,
    expected_head_blob_id: ID,
    blob_id: ID,
    contribution_hash: vector<u8>,
    final_zkey_blob_id: ID,
    final_vkey_blob_id: ID,
    name: String,
    clock: &Clock,
    ctx: &TxContext,
) {
    check_cap(cap, c);
    match (&c.phase) { Phase::Phase2Beacon => (), _ => abort EWrongPhase };
    check_contribution_hash(&contribution_hash);
    check_name(&name);
    assert!(c.head_blob_id == expected_head_blob_id, EHeadChanged);
    let who = ctx.sender();
    c.head_blob_id = blob_id;
    c.final_zkey_blob_id = final_zkey_blob_id;
    c.final_vkey_blob_id = final_vkey_blob_id;
    c.chain.push_back(Contribution { contributor: who, blob_id, contribution_hash, name, ts_ms: clock.timestamp_ms() });
    c.phase = Phase::Closed;
    event::emit(ContributionAccepted { who, blob_id, contribution_hash, index: c.chain.length() - 1 });
    event::emit(PhaseAdvanced { ceremony: object::id(c), phase: Phase::Closed });
}

/// Point contributors at a (new) coordinator host. Safe at any time.
public fun set_coordinator_url(cap: &OrganizerCap, c: &mut Ceremony, url: String) {
    check_cap(cap, c);
    check_url(&url);
    c.coordinator_url = url;
}

/// Change the duration used by future claims. Existing claim deadlines and
/// pending contributions are unchanged. Frozen ceremonies cannot be reconfigured.
/// The duration must be positive and at most one hour.
public fun set_slot_duration(cap: &OrganizerCap, c: &mut Ceremony, slot_duration_ms: u64) {
    check_cap(cap, c);
    match (&c.phase) { Phase::Setup => (), Phase::Phase2Contribute => (), _ => abort EWrongPhase };
    assert!(slot_duration_ms > 0 && slot_duration_ms <= MAX_SLOT_DURATION_MS, EInvalidSlotDuration);
    c.slot_duration_ms = slot_duration_ms;
    event::emit(SlotDurationChanged { ceremony: object::id(c), slot_duration_ms });
}

// === Permissioned allowlist (OrganizerCap) ===

/// Switch the ceremony between permissioned and permissionless. Allowed in
/// `Setup` and `Phase2Contribute`; once the final beacon is drawn contributions
/// are frozen and the mode is moot. Opening up keeps the allowlist in place so
/// the ceremony can be re-closed to the same set; closing a ceremony that was
/// created permissionless starts from an empty allowlist (add_contributors
/// then populates it). Only `claim` consults the allowlist, so closing gates
/// future claims: a slot already held by a now-unlisted address completes its
/// round (same as remove_contributors); use reject/expire to cut it short.
public fun set_access_mode(cap: &OrganizerCap, c: &mut Ceremony, mode: u8) {
    check_cap(cap, c);
    match (&c.phase) { Phase::Setup => (), Phase::Phase2Contribute => (), _ => abort EWrongPhase };
    assert!(mode == PERMISSIONLESS || mode == PERMISSIONED, EBadAccessMode);
    let permissioned = mode == PERMISSIONED;
    if (permissioned && c.allowlist.is_none()) c.allowlist.fill(vec_set::empty());
    c.permissioned = permissioned;
    event::emit(AccessModeChanged { ceremony: object::id(c), permissioned });
}

/// Add addresses to the contributor allowlist. Works in either mode: while the
/// ceremony is permissionless the list is staged and not enforced, so the
/// organizer can prepare it before closing with `set_access_mode`.
/// Idempotent: addresses already present are skipped.
public fun add_contributors(cap: &OrganizerCap, c: &mut Ceremony, addrs: vector<address>) {
    check_cap(cap, c);
    if (c.allowlist.is_none()) c.allowlist.fill(vec_set::empty());
    let set = c.allowlist.borrow_mut();
    let mut i = 0;
    let n = addrs.length();
    while (i < n) {
        let a = *addrs.borrow(i);
        if (!set.contains(&a)) set.insert(a);
        i = i + 1;
    };
    event::emit(ContributorsAdded { addrs });
}

/// Remove addresses from the contributor allowlist. Works in either mode, like
/// `add_contributors`. Idempotent: addresses not present are skipped.
public fun remove_contributors(cap: &OrganizerCap, c: &mut Ceremony, addrs: vector<address>) {
    check_cap(cap, c);
    if (c.allowlist.is_none()) c.allowlist.fill(vec_set::empty());
    let set = c.allowlist.borrow_mut();
    let mut i = 0;
    let n = addrs.length();
    while (i < n) {
        let a = *addrs.borrow(i);
        if (set.contains(&a)) set.remove(&a);
        i = i + 1;
    };
    event::emit(ContributorsRemoved { addrs });
}

// === Phase 2: contributors (sender-based; contributor holds gas + WAL) ===

/// Take the open slot. Holds it until `now + c.slot_duration_ms`.
public fun claim(c: &mut Ceremony, clock: &Clock, ctx: &TxContext) {
    match (&c.phase) { Phase::Phase2Contribute => (), _ => abort EWrongPhase };
    match (&c.slot) { Slot::Open => (), _ => abort ESlotNotOpen };
    let who = ctx.sender();
    if (c.permissioned) assert!(c.allowlist.borrow().contains(&who), ENotAllowed);
    let until_ms = clock.timestamp_ms().checked_add(c.slot_duration_ms)
        .destroy_or!(abort ESlotDeadlineOverflow);
    c.slot = Slot::Claimed { who, until_ms };
    event::emit(SlotClaimed { who });
}

/// Submit an uploaded contribution for verification (Claimed -> Pending).
public fun submit_contribution(
    c: &mut Ceremony, blob_id: ID, contribution_hash: vector<u8>, name: String,
    clock: &Clock, ctx: &TxContext,
) {
    match (&c.phase) { Phase::Phase2Contribute => (), _ => abort EWrongPhase };
    check_contribution_hash(&contribution_hash);
    check_name(&name);
    let who = ctx.sender();
    let until_ms = match (&c.slot) {
        Slot::Claimed { who: claimant, until_ms } => {
            assert!(*claimant == who, ENotClaimant);
            *until_ms
        },
        _ => abort ESlotNotOpen,
    };
    assert!(clock.timestamp_ms() <= until_ms, EExpired);
    c.slot = Slot::Pending { who, blob_id, contribution_hash, name };
    event::emit(ContributionSubmitted { who, blob_id, contribution_hash });
}

/// Anyone may reopen a slot whose claimant blew the deadline.
public fun expire(c: &mut Ceremony, clock: &Clock) {
    match (&c.phase) { Phase::Phase2Contribute => (), _ => abort EWrongPhase };
    let until_ms = match (&c.slot) {
        Slot::Claimed { until_ms, .. } => *until_ms,
        _ => abort ESlotNotOpen,
    };
    assert!(clock.timestamp_ms() > until_ms, ENotExpired);
    c.slot = Slot::Open;
}

// === Views ===

public fun slot_duration_ms(c: &Ceremony): u64 { c.slot_duration_ms }
public fun head(c: &Ceremony): ID { c.head_blob_id }
public fun cap_ceremony(cap: &OrganizerCap): ID { cap.ceremony }
public fun num_contributions(c: &Ceremony): u64 { c.chain.length() }
public fun r1cs_blob_id(c: &Ceremony): ID { c.r1cs_blob_id }
public fun phase1_digest(c: &Ceremony): vector<u8> { c.phase1_digest }
public fun num_approvals(c: &Ceremony): u64 { c.approvals.length() }
public fun is_permissioned(c: &Ceremony): bool { c.permissioned }
public fun is_allowed(c: &Ceremony, who: address): bool { if (c.permissioned) c.allowlist.borrow().contains(&who) else true }
// The stored set is retained while permissionless (so a re-close restores it); `is_allowed` is what is enforced.
public fun allowlist(c: &Ceremony): vector<address> { if (c.allowlist.is_some()) *c.allowlist.borrow().keys() else vector[] }
public fun is_phase2_started(c: &Ceremony): bool { match (&c.phase) { Phase::Setup => false, _ => true } }
public fun is_finalized(c: &Ceremony): bool { match (&c.phase) { Phase::Phase2Beacon => true, Phase::Closed => true, _ => false } }
public fun is_closed(c: &Ceremony): bool { match (&c.phase) { Phase::Closed => true, _ => false } }
public fun final_beacon(c: &Ceremony): vector<u8> { c.final_beacon }
public fun final_zkey_blob_id(c: &Ceremony): ID { c.final_zkey_blob_id }
public fun final_vkey_blob_id(c: &Ceremony): ID { c.final_vkey_blob_id }
public fun coordinator_url(c: &Ceremony): String { c.coordinator_url }
public fun organizer(c: &Ceremony): address { c.organizer }
