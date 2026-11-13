#[test_only]
module ceremony::ceremony_tests;

use ceremony::groth16_phase2::{Self, Ceremony, OrganizerCap};
use std::string;
use sui::clock;
use sui::random::{Self, Random};
use sui::test_scenario as ts;

const ADMIN: address = @0xA;
const AUDITOR: address = @0xAD;
const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const PERMISSIONLESS: u8 = 0;
const PERMISSIONED: u8 = 1;
const SLOT_DURATION_MS: u64 = 10 * 60 * 1000;

// Stand-in SharedBlob object ids (the contract stores `blob_id` as an `ID`).
const R1CS: address = @0x777;
const GENESIS: address = @0x100;
const BLOB1: address = @0x101;
const BLOB2: address = @0x102;
const FINAL: address = @0x103;
const FINAL_ZKEY: address = @0x104;
const FINAL_VKEY: address = @0x105;

// fun hash(b: u8): vector<u8> { vector[b] }
fun chash(b: u8): vector<u8> {
    let mut v = vector[];
    let mut i = 0u64;
    while (i < 64) {
        v.push_back(b);
        i = i + 1;
    };
    v
}
fun no_url(): string::String { string::utf8(b"") }
// An n-byte ASCII string, for exercising the on-chain length bounds.
fun long_str(n: u64): string::String {
    let mut v = vector[];
    let mut i = 0u64;
    while (i < n) {
        v.push_back(120u8); // 'x'
        i = i + 1;
    };
    string::utf8(v)
}
fun bid(a: address): ID { object::id_from_address(a) }

// Create the shared Random object, seeded deterministically. Only finalize_phase2
// needs it (the phase-2 beacon); create_ceremony no longer draws randomness.
fun setup_random(sc: &mut ts::Scenario) {
    sc.next_tx(@0x0);
    random::create_for_testing(sc.ctx());
    sc.next_tx(@0x0);
    let mut rnd = sc.take_shared<Random>();
    rnd.update_randomness_state_for_testing(0, x"0101010101010101010101010101010101010101010101010101010101010101", sc.ctx());
    ts::return_shared(rnd);
}

// A 1-of-1 ceremony (AUDITOR approves); transfers the cap to ADMIN, which we retrieve.
fun create(sc: &mut ts::Scenario): OrganizerCap {
    create_with_duration(sc, SLOT_DURATION_MS)
}

fun create_with_duration(sc: &mut ts::Scenario, duration_ms: u64): OrganizerCap {
    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(chash(9), bid(R1CS), vector[AUDITOR], 1, no_url(), PERMISSIONLESS, vector[], duration_ms, sc.ctx());
    sc.next_tx(ADMIN);
    sc.take_from_sender<OrganizerCap>()
}

// Like create(), but permissioned with the given initial allowlist.
fun create_permissioned(sc: &mut ts::Scenario, allowed: vector<address>): OrganizerCap {
    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(chash(9), bid(R1CS), vector[AUDITOR], 1, no_url(), PERMISSIONED, allowed, SLOT_DURATION_MS, sc.ctx());
    sc.next_tx(ADMIN);
    sc.take_from_sender<OrganizerCap>()
}

// Approve the r1cs and open phase 2 (head = GENESIS).
fun start(sc: &mut ts::Scenario, cap: &OrganizerCap) {
    sc.next_tx(AUDITOR);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::approve_r1cs(&mut cer, sc.ctx());
    ts::return_shared(cer);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::start_phase_2(cap, &mut cer, bid(GENESIS));
    ts::return_shared(cer);
}

// The full ceremony end to end: create + approve + start, two chained phase-2
// contributions, then finalize_phase2 -> beacon -> the organizer's sealing
// contribution (which closes it). Mirrors the on-chain run.
#[test]
fun full_lifecycle() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    setup_random(&mut sc);
    let cap = create(&mut sc);
    start(&mut sc, &cap);

    sc.next_tx(ADMIN);
    let cer = sc.take_shared<Ceremony>();
    assert!(groth16_phase2::is_phase2_started(&cer), 0);
    assert!(groth16_phase2::num_approvals(&cer) == 1 && groth16_phase2::phase1_digest(&cer) == chash(9), 1);
    assert!(groth16_phase2::head(&cer) == bid(GENESIS), 2);
    assert!(!groth16_phase2::is_permissioned(&cer), 3);
    ts::return_shared(cer);

    // Contribution 1 (Alice).
    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    groth16_phase2::submit_contribution(&mut cer, bid(BLOB1), chash(1), string::utf8(b"alice"), &clk, sc.ctx());
    ts::return_shared(cer);
    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::accept(&cap, &mut cer, bid(GENESIS), bid(BLOB1), chash(1), ALICE, &clk);
    assert!(groth16_phase2::head(&cer) == bid(BLOB1) && groth16_phase2::num_contributions(&cer) == 1, 3);
    ts::return_shared(cer);

    // Contribution 2 (Bob).
    sc.next_tx(BOB);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    groth16_phase2::submit_contribution(&mut cer, bid(BLOB2), chash(2), string::utf8(b"bob"), &clk, sc.ctx());
    ts::return_shared(cer);
    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::accept(&cap, &mut cer, bid(BLOB1), bid(BLOB2), chash(2), BOB, &clk);
    assert!(groth16_phase2::num_contributions(&cer) == 2, 4);

    // finalize_phase2 -> beacon, then the sealing contribution closes the ceremony.
    let rnd = sc.take_shared<Random>();
    groth16_phase2::finalize_phase2(&cap, &mut cer, &rnd, sc.ctx());
    ts::return_shared(rnd);
    assert!(groth16_phase2::is_finalized(&cer) && groth16_phase2::final_beacon(&cer).length() == 32, 5);
    groth16_phase2::submit_final(
        &cap,
        &mut cer,
        bid(BLOB2),
        bid(FINAL),
        chash(3),
        bid(FINAL_ZKEY),
        bid(FINAL_VKEY),
        string::utf8(b"beacon"),
        &clk,
        sc.ctx(),
    );
    assert!(groth16_phase2::head(&cer) == bid(FINAL) && groth16_phase2::num_contributions(&cer) == 3 && groth16_phase2::is_closed(&cer), 6);
    assert!(groth16_phase2::final_zkey_blob_id(&cer) == bid(FINAL_ZKEY), 7);
    assert!(groth16_phase2::final_vkey_blob_id(&cer) == bid(FINAL_VKEY), 8);
    ts::return_shared(cer);

    transfer::public_transfer(cap, ADMIN);
    clock::destroy_for_testing(clk);
    sc.end();
}

#[test, expected_failure(abort_code = groth16_phase2::EPendingChanged)]
fun accept_requires_expected_pending() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    let cap = create(&mut sc);
    start(&mut sc, &cap);

    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    groth16_phase2::submit_contribution(&mut cer, bid(BLOB1), chash(1), string::utf8(b"alice"), &clk, sc.ctx());
    ts::return_shared(cer);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::accept(&cap, &mut cer, bid(GENESIS), bid(BLOB2), chash(1), ALICE, &clk);
    abort 42
}

#[test, expected_failure(abort_code = groth16_phase2::EInvalidContributionHash)]
fun submit_contribution_requires_64_byte_hash() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    let cap = create(&mut sc);
    start(&mut sc, &cap);

    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    groth16_phase2::submit_contribution(&mut cer, bid(BLOB1), vector[1], string::utf8(b"alice"), &clk, sc.ctx());
    abort 42
}

#[test, expected_failure(abort_code = groth16_phase2::EHeadChanged)]
fun submit_final_requires_expected_head() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    setup_random(&mut sc);
    let cap = create(&mut sc);
    start(&mut sc, &cap);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    let rnd = sc.take_shared<Random>();
    groth16_phase2::finalize_phase2(&cap, &mut cer, &rnd, sc.ctx());
    ts::return_shared(rnd);

    groth16_phase2::submit_final(
        &cap,
        &mut cer,
        bid(BLOB1),
        bid(FINAL),
        chash(3),
        bid(FINAL_ZKEY),
        bid(FINAL_VKEY),
        string::utf8(b"beacon"),
        &clk,
        sc.ctx(),
    );
    abort 42
}

#[test]
fun reject_reopens_without_recording() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    let cap = create(&mut sc);
    start(&mut sc, &cap);

    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    groth16_phase2::submit_contribution(&mut cer, bid(@0x999), chash(9), string::utf8(b"bad"), &clk, sc.ctx());
    ts::return_shared(cer);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::reject(&cap, &mut cer, bid(@0x999), chash(9), ALICE);
    assert!(groth16_phase2::head(&cer) == bid(GENESIS), 0);  // head unchanged (genesis)
    assert!(groth16_phase2::num_contributions(&cer) == 0, 1);
    ts::return_shared(cer);

    // Slot is open again: Bob can now contribute.
    sc.next_tx(BOB);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    ts::return_shared(cer);

    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test]
fun expire_reopens_after_deadline() {
    let mut sc = ts::begin(ADMIN);
    let mut clk = clock::create_for_testing(sc.ctx());
    let cap = create(&mut sc);
    start(&mut sc, &cap);

    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    ts::return_shared(cer);

    // 11 min later Alice is still gone: anyone reopens.
    clk.increment_for_testing(11 * 60 * 1000);
    sc.next_tx(BOB);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::expire(&mut cer, &clk);
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());      // slot now Bob's
    ts::return_shared(cer);

    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test, expected_failure(abort_code = groth16_phase2::EWrongPhase)]
fun cannot_contribute_before_start() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    let _cap = create(&mut sc);

    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());      // not started -> abort
    abort 42
}

#[test, expected_failure(abort_code = groth16_phase2::ENotApproved)]
fun start_requires_approval() {
    let mut sc = ts::begin(ADMIN);
    let cap = create(&mut sc);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::start_phase_2(&cap, &mut cer, bid(GENESIS));   // no approval -> abort
    abort 42
}

#[test, expected_failure(abort_code = groth16_phase2::ENotAuditor)]
fun non_auditor_cannot_approve() {
    let mut sc = ts::begin(ADMIN);
    let _cap = create(&mut sc);

    sc.next_tx(BOB);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::approve_r1cs(&mut cer, sc.ctx());      // BOB not an auditor -> abort
    abort 42
}

#[test, expected_failure(abort_code = groth16_phase2::EBadThreshold)]
fun threshold_exceeds_auditors() {
    let mut sc = ts::begin(ADMIN);
    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(chash(0), bid(R1CS), vector[AUDITOR], 2, no_url(), PERMISSIONLESS, vector[], SLOT_DURATION_MS, sc.ctx());  // threshold 2 > 1 auditor
    abort 42
}

#[test, expected_failure(abort_code = groth16_phase2::EInvalidPhase1Digest)]
fun create_requires_64_byte_phase1_digest() {
    let mut sc = ts::begin(ADMIN);
    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(vector[9], bid(R1CS), vector[], 0, no_url(), PERMISSIONLESS, vector[], SLOT_DURATION_MS, sc.ctx());  // 1-byte digest -> abort
    abort 42
}

// A cap minted for ceremony B must not accept on ceremony A (check_cap is first).
#[test, expected_failure(abort_code = groth16_phase2::EWrongCeremony)]
fun foreign_cap_cannot_accept() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());

    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(chash(0), bid(@0xA), vector[], 0, no_url(), PERMISSIONLESS, vector[], SLOT_DURATION_MS, sc.ctx());  // ceremony A
    sc.next_tx(ADMIN);
    let cap_a = sc.take_from_sender<OrganizerCap>();
    let a_id = groth16_phase2::cap_ceremony(&cap_a);

    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(chash(0), bid(@0xB), vector[], 0, no_url(), PERMISSIONLESS, vector[], SLOT_DURATION_MS, sc.ctx());  // ceremony B (foreign cap)
    sc.next_tx(ADMIN);
    let cap_b = sc.take_from_sender<OrganizerCap>();

    sc.next_tx(ALICE);
    let mut a = ts::take_shared_by_id<Ceremony>(&sc, a_id);
    groth16_phase2::accept(&cap_b, &mut a, bid(GENESIS), bid(BLOB1), chash(1), ALICE, &clk); // wrong cap -> abort EWrongCeremony

    transfer::public_transfer(cap_a, ADMIN);
    transfer::public_transfer(cap_b, ADMIN);
    ts::return_shared(a);
    clock::destroy_for_testing(clk);
    sc.end();
}

#[test, expected_failure(abort_code = groth16_phase2::ENotClaimant)]
fun non_claimant_cannot_submit() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    let cap = create(&mut sc);
    start(&mut sc, &cap);

    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    ts::return_shared(cer);

    sc.next_tx(BOB);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::submit_contribution(&mut cer, bid(BLOB1), chash(1), string::utf8(b"bob"), &clk, sc.ctx());
    abort 42
}

#[test]
fun coordinator_url_set_and_rotated() {
    let mut sc = ts::begin(ADMIN);
    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(chash(0), bid(R1CS), vector[], 0, string::utf8(b"https://coord.one"), PERMISSIONLESS, vector[], SLOT_DURATION_MS, sc.ctx());
    sc.next_tx(ADMIN);
    let cap = sc.take_from_sender<OrganizerCap>();

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    assert!(groth16_phase2::coordinator_url(&cer) == string::utf8(b"https://coord.one"), 0);
    groth16_phase2::set_coordinator_url(&cap, &mut cer, string::utf8(b"https://coord.two"));
    assert!(groth16_phase2::coordinator_url(&cer) == string::utf8(b"https://coord.two"), 1);

    ts::return_shared(cer);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test]
fun permissioned_listed_can_claim() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    let cap = create_permissioned(&mut sc, vector[ALICE]);
    start(&mut sc, &cap);

    sc.next_tx(ADMIN);
    let cer = sc.take_shared<Ceremony>();
    assert!(groth16_phase2::is_permissioned(&cer), 0);
    assert!(groth16_phase2::is_allowed(&cer, ALICE) && !groth16_phase2::is_allowed(&cer, BOB), 1);
    ts::return_shared(cer);

    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());      // ALICE is listed -> ok
    ts::return_shared(cer);

    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test, expected_failure(abort_code = groth16_phase2::ENotAllowed)]
fun permissioned_unlisted_cannot_claim() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    let cap = create_permissioned(&mut sc, vector[ALICE]);
    start(&mut sc, &cap);

    sc.next_tx(BOB);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());      // BOB not listed -> abort
    abort 42
}

#[test]
fun organizer_adds_and_removes_contributors() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    let cap = create_permissioned(&mut sc, vector[ALICE]);
    start(&mut sc, &cap);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::add_contributors(&cap, &mut cer, vector[BOB]);       // add BOB
    groth16_phase2::remove_contributors(&cap, &mut cer, vector[ALICE]);  // remove ALICE
    assert!(groth16_phase2::is_allowed(&cer, BOB) && !groth16_phase2::is_allowed(&cer, ALICE), 0);
    assert!(groth16_phase2::allowlist(&cer).length() == 1, 1);
    ts::return_shared(cer);

    // BOB (added) can now claim.
    sc.next_tx(BOB);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    ts::return_shared(cer);

    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

// The organizer can stage the allowlist while the ceremony is open; it is not
// enforced until set_access_mode closes the ceremony.
#[test]
fun allowlist_staged_while_permissionless() {
    let mut sc = ts::begin(ADMIN);
    let cap = create(&mut sc);   // permissionless, no allowlist yet
    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::add_contributors(&cap, &mut cer, vector[ALICE, BOB]);
    groth16_phase2::remove_contributors(&cap, &mut cer, vector[BOB]);
    assert!(!groth16_phase2::is_permissioned(&cer), 0);
    assert!(groth16_phase2::is_allowed(&cer, BOB), 1);      // not enforced yet
    assert!(groth16_phase2::allowlist(&cer) == vector[ALICE], 2);
    groth16_phase2::set_access_mode(&cap, &mut cer, PERMISSIONED);
    assert!(groth16_phase2::is_allowed(&cer, ALICE), 3);
    assert!(!groth16_phase2::is_allowed(&cer, BOB), 4);     // staged list now enforced
    ts::return_shared(cer);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test]
fun remove_on_fresh_permissionless_is_noop() {
    let mut sc = ts::begin(ADMIN);
    let cap = create(&mut sc);
    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::remove_contributors(&cap, &mut cer, vector[ALICE]);
    assert!(groth16_phase2::allowlist(&cer) == vector[], 0);
    ts::return_shared(cer);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test, expected_failure(abort_code = groth16_phase2::EBadAccessMode)]
fun bad_access_mode_aborts() {
    let mut sc = ts::begin(ADMIN);
    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(chash(0), bid(R1CS), vector[], 0, no_url(), 2, vector[], SLOT_DURATION_MS, sc.ctx());  // mode 2 -> abort
    abort 42
}

#[test, expected_failure(abort_code = groth16_phase2::EDuplicateAddress)]
fun duplicate_auditor_aborts() {
    let mut sc = ts::begin(ADMIN);
    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(chash(0), bid(R1CS), vector[AUDITOR, AUDITOR], 1, no_url(), PERMISSIONLESS, vector[], SLOT_DURATION_MS, sc.ctx());  // dup auditor -> abort
    abort 42
}

#[test, expected_failure(abort_code = groth16_phase2::EDuplicateAddress)]
fun duplicate_allowed_aborts() {
    let mut sc = ts::begin(ADMIN);
    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(chash(0), bid(R1CS), vector[], 0, no_url(), PERMISSIONED, vector[ALICE, ALICE], SLOT_DURATION_MS, sc.ctx());  // dup allowlist -> abort
    abort 42
}

// === Length bounds on operator/contributor supplied strings ===

// 64 bytes is the documented maximum, so it must still be accepted; the chain
// entry keeps the full name.
#[test]
fun name_at_max_length_is_accepted() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    let cap = create(&mut sc);
    start(&mut sc, &cap);

    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    groth16_phase2::submit_contribution(&mut cer, bid(BLOB1), chash(1), long_str(64), &clk, sc.ctx());
    ts::return_shared(cer);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::accept(&cap, &mut cer, bid(GENESIS), bid(BLOB1), chash(1), ALICE, &clk);
    assert!(groth16_phase2::num_contributions(&cer) == 1, 0);
    ts::return_shared(cer);

    transfer::public_transfer(cap, ADMIN);
    clock::destroy_for_testing(clk);
    sc.end();
}

// The griefing case: an oversized name would otherwise be appended to `chain`
// forever, growing the shared object toward its size limit.
#[test, expected_failure(abort_code = groth16_phase2::EInvalidName)]
fun submit_contribution_rejects_oversized_name() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    let cap = create(&mut sc);
    start(&mut sc, &cap);

    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    groth16_phase2::submit_contribution(&mut cer, bid(BLOB1), chash(1), long_str(65), &clk, sc.ctx());
    abort 42
}

// The seal writes a chain entry too, so it carries the same bound.
#[test, expected_failure(abort_code = groth16_phase2::EInvalidName)]
fun submit_final_rejects_oversized_name() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    setup_random(&mut sc);
    let cap = create(&mut sc);
    start(&mut sc, &cap);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    let rnd = sc.take_shared<Random>();
    groth16_phase2::finalize_phase2(&cap, &mut cer, &rnd, sc.ctx());
    ts::return_shared(rnd);
    groth16_phase2::submit_final(
        &cap,
        &mut cer,
        bid(GENESIS),
        bid(FINAL),
        chash(3),
        bid(FINAL_ZKEY),
        bid(FINAL_VKEY),
        long_str(65),
        &clk,
        sc.ctx(),
    );
    abort 42
}

#[test, expected_failure(abort_code = groth16_phase2::EInvalidUrl)]
fun create_rejects_oversized_url() {
    let mut sc = ts::begin(ADMIN);
    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(chash(0), bid(R1CS), vector[], 0, long_str(257), PERMISSIONLESS, vector[], SLOT_DURATION_MS, sc.ctx());
    abort 42
}

#[test, expected_failure(abort_code = groth16_phase2::EInvalidUrl)]
fun set_coordinator_url_rejects_oversized_url() {
    let mut sc = ts::begin(ADMIN);
    let cap = create(&mut sc);
    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::set_coordinator_url(&cap, &mut cer, long_str(257));
    abort 42
}

// === Access-mode switching ===

// Opening up keeps the stored list (so it can be re-closed to the same set)
// but stops enforcing it: an unlisted address can claim.
#[test]
fun set_access_mode_opens_and_retains_allowlist() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    let cap = create_permissioned(&mut sc, vector[ALICE]);
    start(&mut sc, &cap);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::set_access_mode(&cap, &mut cer, PERMISSIONLESS);
    assert!(!groth16_phase2::is_permissioned(&cer), 0);
    assert!(groth16_phase2::is_allowed(&cer, BOB), 1);
    let list = groth16_phase2::allowlist(&cer);
    let alice = ALICE;
    assert!(list.length() == 1 && list.contains(&alice), 2);
    ts::return_shared(cer);

    sc.next_tx(BOB);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());      // BOB unlisted but permissionless -> ok
    ts::return_shared(cer);

    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test]
fun set_access_mode_recloses_to_retained_list() {
    let mut sc = ts::begin(ADMIN);
    let cap = create_permissioned(&mut sc, vector[ALICE]);
    start(&mut sc, &cap);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::set_access_mode(&cap, &mut cer, PERMISSIONLESS);
    groth16_phase2::set_access_mode(&cap, &mut cer, PERMISSIONED);
    assert!(groth16_phase2::is_permissioned(&cer), 0);
    assert!(groth16_phase2::is_allowed(&cer, ALICE) && !groth16_phase2::is_allowed(&cer, BOB), 1);
    ts::return_shared(cer);

    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

// A ceremony created permissionless has no stored set; closing it starts empty
// so nobody slips through until add_contributors populates it.
#[test]
fun set_access_mode_closes_permissionless_with_empty_list() {
    let mut sc = ts::begin(ADMIN);
    let cap = create(&mut sc);   // permissionless

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::set_access_mode(&cap, &mut cer, PERMISSIONED);
    assert!(groth16_phase2::is_permissioned(&cer), 0);
    assert!(groth16_phase2::allowlist(&cer).length() == 0, 1);
    assert!(!groth16_phase2::is_allowed(&cer, ALICE), 2);
    groth16_phase2::add_contributors(&cap, &mut cer, vector[ALICE]);
    assert!(groth16_phase2::is_allowed(&cer, ALICE), 3);
    ts::return_shared(cer);

    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test, expected_failure(abort_code = groth16_phase2::EBadAccessMode)]
fun set_access_mode_bad_mode_aborts() {
    let mut sc = ts::begin(ADMIN);
    let cap = create(&mut sc);
    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::set_access_mode(&cap, &mut cer, 2);  // mode 2 -> abort
    abort 42
}

// Once the beacon is drawn contributions are frozen; flipping the mode then is
// meaningless and refused.
#[test, expected_failure(abort_code = groth16_phase2::EWrongPhase)]
fun set_access_mode_after_beacon_aborts() {
    let mut sc = ts::begin(ADMIN);
    setup_random(&mut sc);
    let cap = create(&mut sc);
    start(&mut sc, &cap);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    let rnd = sc.take_shared<Random>();
    groth16_phase2::finalize_phase2(&cap, &mut cer, &rnd, sc.ctx());
    ts::return_shared(rnd);
    groth16_phase2::set_access_mode(&cap, &mut cer, PERMISSIONED);  // Phase2Beacon -> abort
    abort 42
}

#[test, expected_failure(abort_code = groth16_phase2::EWrongCeremony)]
fun set_access_mode_foreign_cap_aborts() {
    let mut sc = ts::begin(ADMIN);

    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(chash(0), bid(@0xA), vector[], 0, no_url(), PERMISSIONLESS, vector[], SLOT_DURATION_MS, sc.ctx());  // ceremony A
    sc.next_tx(ADMIN);
    let cap_a = sc.take_from_sender<OrganizerCap>();
    let a_id = groth16_phase2::cap_ceremony(&cap_a);

    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(chash(0), bid(@0xB), vector[], 0, no_url(), PERMISSIONLESS, vector[], SLOT_DURATION_MS, sc.ctx());  // ceremony B (foreign cap)
    sc.next_tx(ADMIN);
    let cap_b = sc.take_from_sender<OrganizerCap>();

    sc.next_tx(ADMIN);
    let mut a = ts::take_shared_by_id<Ceremony>(&sc, a_id);
    groth16_phase2::set_access_mode(&cap_b, &mut a, PERMISSIONED);  // wrong cap -> abort EWrongCeremony

    transfer::public_transfer(cap_a, ADMIN);
    transfer::public_transfer(cap_b, ADMIN);
    ts::return_shared(a);
    sc.end();
}

// Naming auditors with threshold 0 would look attested while requiring nothing.
#[test, expected_failure(abort_code = groth16_phase2::EZeroThresholdWithAuditors)]
fun zero_threshold_with_auditors_aborts() {
    let mut sc = ts::begin(ADMIN);
    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(chash(0), bid(R1CS), vector[AUDITOR], 0, no_url(), PERMISSIONLESS, vector[], SLOT_DURATION_MS, sc.ctx());  // 1 auditor, threshold 0 -> abort
    abort 42
}

// Pins the documented semantics: closing gates future claims only. A slot held
// by an unlisted address when the ceremony is re-closed still completes its round.
#[test]
fun set_access_mode_close_keeps_active_claim() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    let cap = create_permissioned(&mut sc, vector[ALICE]);
    start(&mut sc, &cap);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::set_access_mode(&cap, &mut cer, PERMISSIONLESS);
    ts::return_shared(cer);

    sc.next_tx(BOB);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());      // BOB claims while open
    ts::return_shared(cer);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::set_access_mode(&cap, &mut cer, PERMISSIONED);  // BOB not on the retained list
    assert!(!groth16_phase2::is_allowed(&cer, BOB), 0);
    ts::return_shared(cer);

    sc.next_tx(BOB);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::submit_contribution(&mut cer, bid(BLOB1), chash(1), string::utf8(b"bob"), &clk, sc.ctx());  // in-flight round completes
    ts::return_shared(cer);
    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::accept(&cap, &mut cer, bid(GENESIS), bid(BLOB1), chash(1), BOB, &clk);
    assert!(groth16_phase2::head(&cer) == bid(BLOB1), 1);
    ts::return_shared(cer);

    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

// === Zero-auditor mode ===

// No auditors, threshold 0: the approval gate is vacuous (0 >= 0), so the
// organizer opens phase 2 without anyone attesting to the r1cs. Rehearsal
// configuration; a public ceremony should list auditors.
fun create_no_auditors(sc: &mut ts::Scenario): OrganizerCap {
    sc.next_tx(ADMIN);
    groth16_phase2::create_ceremony(chash(9), bid(R1CS), vector[], 0, no_url(), PERMISSIONLESS, vector[], SLOT_DURATION_MS, sc.ctx());
    sc.next_tx(ADMIN);
    sc.take_from_sender<OrganizerCap>()
}

#[test]
fun zero_auditors_start_without_approval() {
    let mut sc = ts::begin(ADMIN);
    let clk = clock::create_for_testing(sc.ctx());
    let cap = create_no_auditors(&mut sc);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::start_phase_2(&cap, &mut cer, bid(GENESIS));   // no approve_r1cs -> ok
    assert!(groth16_phase2::is_phase2_started(&cer), 0);
    assert!(groth16_phase2::num_approvals(&cer) == 0, 1);
    assert!(groth16_phase2::head(&cer) == bid(GENESIS), 2);
    ts::return_shared(cer);

    // Phase 2 is genuinely open: a contributor can claim.
    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    ts::return_shared(cer);

    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

// With an empty auditor set nobody passes the membership check, so approvals
// can never be recorded (num_approvals stays 0 for the ceremony's lifetime).
#[test, expected_failure(abort_code = groth16_phase2::ENotAuditor)]
fun zero_auditors_nobody_can_approve() {
    let mut sc = ts::begin(ADMIN);
    let _cap = create_no_auditors(&mut sc);

    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::approve_r1cs(&mut cer, sc.ctx());      // empty auditor set -> abort
    abort 42
}

#[test]
#[expected_failure(abort_code = groth16_phase2::EInvalidSlotDuration)]
fun zero_slot_duration_rejected() {
    let mut sc = ts::begin(ADMIN);
    groth16_phase2::create_ceremony(chash(9), bid(R1CS), vector[], 0, no_url(), PERMISSIONLESS, vector[], 0, sc.ctx());
    sc.end();
}

#[test, expected_failure(abort_code = groth16_phase2::EInvalidSlotDuration)]
fun slot_duration_above_one_hour_rejected() {
    let mut sc = ts::begin(ADMIN);
    groth16_phase2::create_ceremony(chash(9), bid(R1CS), vector[], 0, no_url(), PERMISSIONLESS, vector[], 3600001, sc.ctx());
    sc.end();
}

// Exercise both sides of the former hardcoded window, including the minimum
// positive Move duration. Each ceremony keeps its independently chosen value.
fun submit_at_custom_deadline(duration_ms: u64, start_ms: u64) {
    let mut sc = ts::begin(ADMIN);
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.increment_for_testing(start_ms);
    let cap = create_with_duration(&mut sc, duration_ms);
    start(&mut sc, &cap);
    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    assert!(groth16_phase2::slot_duration_ms(&cer) == duration_ms, 0);
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    clk.increment_for_testing(duration_ms);
    groth16_phase2::submit_contribution(&mut cer, bid(BLOB1), chash(1), string::utf8(b"alice"), &clk, sc.ctx());
    ts::return_shared(cer);
    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test]
fun one_millisecond_claim_can_submit_at_deadline() {
    submit_at_custom_deadline(1, 100);
}

#[test]
fun fifteen_minute_claim_can_submit_at_deadline() {
    submit_at_custom_deadline(15 * 60 * 1000, 100);
}

#[test]
fun one_hour_claim_can_submit_at_deadline() {
    submit_at_custom_deadline(3600000, 100);
}

#[test]
#[expected_failure(abort_code = groth16_phase2::ENotExpired)]
fun custom_claim_cannot_expire_at_deadline() {
    let mut sc = ts::begin(ADMIN);
    let mut clk = clock::create_for_testing(sc.ctx());
    let cap = create_with_duration(&mut sc, 1500);
    start(&mut sc, &cap);
    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    clk.increment_for_testing(1500);
    groth16_phase2::expire(&mut cer, &clk);
    ts::return_shared(cer);
    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test]
#[expected_failure(abort_code = groth16_phase2::EExpired)]
fun custom_claim_cannot_submit_after_deadline() {
    let mut sc = ts::begin(ADMIN);
    let mut clk = clock::create_for_testing(sc.ctx());
    let cap = create_with_duration(&mut sc, 1500);
    start(&mut sc, &cap);
    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    clk.increment_for_testing(1501);
    groth16_phase2::submit_contribution(&mut cer, bid(BLOB1), chash(1), string::utf8(b"alice"), &clk, sc.ctx());
    ts::return_shared(cer);
    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test]
fun reopened_claim_gets_full_custom_duration() {
    let mut sc = ts::begin(ADMIN);
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.increment_for_testing(100);
    let cap = create_with_duration(&mut sc, 1500);
    start(&mut sc, &cap);
    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    ts::return_shared(cer);
    clk.increment_for_testing(1501);
    sc.next_tx(BOB);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::expire(&mut cer, &clk);
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    clk.increment_for_testing(1500);
    groth16_phase2::submit_contribution(&mut cer, bid(BLOB2), chash(2), string::utf8(b"bob"), &clk, sc.ctx());
    ts::return_shared(cer);
    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test]
fun claim_deadline_can_reach_u64_max() {
    submit_at_custom_deadline(3600000, std::u64::max_value!() - 3600000);
}

#[test]
#[expected_failure(abort_code = groth16_phase2::ESlotDeadlineOverflow)]
fun claim_deadline_overflow_rejected() {
    let mut sc = ts::begin(ADMIN);
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.increment_for_testing(std::u64::max_value!() - 3600000 + 1);
    let cap = create_with_duration(&mut sc, 3600000);
    start(&mut sc, &cap);
    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    ts::return_shared(cer);
    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test]
fun slot_duration_can_change_to_one_hour_during_setup() {
    let mut sc = ts::begin(ADMIN);
    let cap = create(&mut sc);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::set_slot_duration(&cap, &mut cer, 3600000);
    assert!(groth16_phase2::slot_duration_ms(&cer) == 3600000, 0);
    ts::return_shared(cer);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test, expected_failure(abort_code = groth16_phase2::EInvalidSlotDuration)]
fun set_slot_duration_rejects_zero() {
    let mut sc = ts::begin(ADMIN);
    let cap = create(&mut sc);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::set_slot_duration(&cap, &mut cer, 0);
    abort 42
}

#[test, expected_failure(abort_code = groth16_phase2::EInvalidSlotDuration)]
fun set_slot_duration_rejects_above_one_hour() {
    let mut sc = ts::begin(ADMIN);
    let cap = create(&mut sc);
    start(&mut sc, &cap);
    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::set_slot_duration(&cap, &mut cer, 3600001);
    abort 42
}

#[test, expected_failure(abort_code = groth16_phase2::EWrongCeremony)]
fun set_slot_duration_rejects_foreign_cap() {
    let mut sc = ts::begin(ADMIN);
    let cap_a = create(&mut sc);
    let cap_b = create(&mut sc);
    let mut a = ts::take_shared_by_id<Ceremony>(&sc, groth16_phase2::cap_ceremony(&cap_a));
    groth16_phase2::set_slot_duration(&cap_b, &mut a, 900000);
    abort 42
}

#[test]
fun shorter_duration_preserves_active_claim_and_pending_contribution() {
    let mut sc = ts::begin(ADMIN);
    let mut clk = clock::create_for_testing(sc.ctx());
    let cap = create_with_duration(&mut sc, 1500);
    start(&mut sc, &cap);
    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    ts::return_shared(cer);

    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::set_slot_duration(&cap, &mut cer, 100);
    ts::return_shared(cer);

    clk.increment_for_testing(1500);
    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    // Still allowed at the original deadline, despite the new shorter duration.
    groth16_phase2::submit_contribution(&mut cer, bid(BLOB1), chash(1), string::utf8(b"alice"), &clk, sc.ctx());
    ts::return_shared(cer);

    clk.increment_for_testing(10000);
    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::set_slot_duration(&cap, &mut cer, 200);
    // A duration update cannot evict a Pending contribution.
    groth16_phase2::accept(&cap, &mut cer, bid(GENESIS), bid(BLOB1), chash(1), ALICE, &clk);
    ts::return_shared(cer);

    sc.next_tx(BOB);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    clk.increment_for_testing(201);
    // The next claim uses 200ms, not the original 1500ms.
    groth16_phase2::expire(&mut cer, &clk);
    ts::return_shared(cer);
    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test]
fun longer_duration_does_not_extend_active_claim() {
    let mut sc = ts::begin(ADMIN);
    let mut clk = clock::create_for_testing(sc.ctx());
    let cap = create_with_duration(&mut sc, 100);
    start(&mut sc, &cap);
    sc.next_tx(ALICE);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    ts::return_shared(cer);
    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::set_slot_duration(&cap, &mut cer, 1500);
    clk.increment_for_testing(101);
    groth16_phase2::expire(&mut cer, &clk);
    ts::return_shared(cer);
    sc.next_tx(BOB);
    let mut cer = sc.take_shared<Ceremony>();
    groth16_phase2::claim(&mut cer, &clk, sc.ctx());
    clk.increment_for_testing(1500);
    groth16_phase2::submit_contribution(&mut cer, bid(BLOB2), chash(2), string::utf8(b"bob"), &clk, sc.ctx());
    ts::return_shared(cer);
    clock::destroy_for_testing(clk);
    transfer::public_transfer(cap, ADMIN);
    sc.end();
}

#[test, expected_failure(abort_code = groth16_phase2::EWrongPhase)]
fun set_slot_duration_rejected_after_beacon() {
    let mut sc = ts::begin(ADMIN);
    setup_random(&mut sc);
    let cap = create(&mut sc);
    start(&mut sc, &cap);
    sc.next_tx(ADMIN);
    let mut cer = sc.take_shared<Ceremony>();
    let rnd = sc.take_shared<Random>();
    groth16_phase2::finalize_phase2(&cap, &mut cer, &rnd, sc.ctx());
    ts::return_shared(rnd);
    groth16_phase2::set_slot_duration(&cap, &mut cer, 900000);
    abort 42
}
