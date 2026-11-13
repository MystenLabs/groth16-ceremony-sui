// Public, in-memory observations only. Never expose run files, funding receipts,
// private URLs, or raw exceptions through the monitor.
export class AttestorStatus {
  constructor({ network, ceremonyId, pollMs, now = Date.now }) {
    this.network = network;
    this.ceremonyId = ceremonyId;
    this.now = now;
    this.pollGraceMs = Math.max(30_000, pollMs * 3);
    this.startedAt = now();
    this.lastChainReadAt = null;
    this.ceremony = null;
    this.error = null;
    this.activity('starting', 'Checking base artifacts');
  }

  activity(state, detail, graceMs = this.pollGraceMs) {
    this.state = state;
    this.detail = detail;
    this.activityAt = this.now();
    this.staleAt = this.activityAt + graceMs;
  }

  observe(j) {
    const chain = j.chain || [];
    const slot = j.slot || {};
    const who = slot.who?.toLowerCase();
    // Before submission, the slot has no name. Use the name from an earlier contribution.
    const earlierName = !slot.name && who ? chain.findLast((c) => c.contributor?.toLowerCase() === who)?.name || '' : '';
    this.lastChainReadAt = this.now();
    this.error = null;
    this.ceremony = {
      phase: j.phase?.['@variant'] || 'Setup',
      permissioned: j.permissioned,
      chainLength: chain.length,
      headBlobId: j.head_blob_id,
      slot: {
        state: slot['@variant'] || 'Open', address: slot.who || null,
        name: slot.name || '', reportedName: earlierName, until: slot.until_ms == null ? null : Number(slot.until_ms),
      },
      recent: chain.slice(-20).reverse().map((c, i) => ({
        index: chain.length - i, name: c.name, address: c.contributor,
        acceptedAt: Number(c.ts_ms), blobId: c.blob_id,
      })),
    };
    this.activity('waiting', this.ceremony.phase === 'Phase2Contribute'
      ? 'Waiting for a submission' : `Monitoring ceremony phase: ${this.ceremony.phase}`);
  }

  fail(message, { stopped = false } = {}) {
    this.error = message;
    this.activity(stopped ? 'stopped' : 'error', message);
  }

  snapshot() {
    const now = this.now();
    const stale = now >= this.staleAt;
    const ok = !!this.ceremony && !this.error && this.state !== 'starting' && !stale;
    return {
      ok, asOf: now, network: this.network, ceremonyId: this.ceremonyId,
      attestor: {
        state: this.state, detail: this.detail, stale,
        startedAt: this.startedAt, activityAt: this.activityAt,
        staleAt: this.staleAt, lastChainReadAt: this.lastChainReadAt,
        error: this.error,
      },
      ceremony: this.ceremony,
    };
  }
}
