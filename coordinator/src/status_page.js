const $ = (id) => document.getElementById(id);
const text = (id, value) => { $(id).textContent = value; };
const duration = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
};
const utc = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
let latest = null;
let receivedAt = 0;
let unavailable = false;
let loading = false;
let timer;

function render() {
  const state = latest?.attestor;
  // Use the server's clock for activity ages, even if the browser clock differs.
  const now = latest ? latest.asOf + Date.now() - receivedAt : Date.now();
  // The loop can progress between page refreshes; only the server can judge it stale.
  const stale = state?.stale;
  const unhealthy = unavailable || !latest?.ok || stale;
  $('monitor').classList.toggle('data-stale', !!unhealthy);
  $('health').dataset.tone = unhealthy ? 'bad' : 'good';
  const labels = { starting: 'Attestor starting', waiting: 'Attestor online', polling: 'Attestor online', verifying: 'Verifying a contribution', accepting: 'Accepting a contribution', rejecting: 'Rejecting a contribution', error: 'Attestor needs attention', stopped: 'Attestor stopped' };
  text('health-title', unavailable ? 'Attestor not reachable' : stale && !state?.error ? 'Attestor activity is stale' : labels[state?.state] || 'Status unavailable');
  text('health-detail', unavailable
    ? 'The status endpoint did not respond successfully. The attestor may be down, starting, or slow to respond.'
    : state?.error || state?.detail || 'Monitoring is not configured on this attestor.');
  text('health-time', unavailable
    ? latest ? `Showing the last response, received ${duration(Date.now() - receivedAt)} ago. Ceremony data may be outdated.` : 'No ceremony data has been received yet. Retrying automatically.'
    : state ? `Current activity started ${duration(now - state.activityAt)} ago${unhealthy ? ' · ceremony data may be outdated' : ''}.` : '');
  if (!latest) return;
  text('network', latest.network);
  text('ceremony-id', latest.ceremonyId);
  text('uptime', unavailable ? '—' : duration(now - state.startedAt));
  text('chain-read', state.lastChainReadAt == null ? 'No chain observation yet' : `Last successful chain read ${duration(now - state.lastChainReadAt)} ago`);
  text('refresh-time', `Last response received ${duration(Date.now() - receivedAt)} ago · refresh every 30s`);
  const c = latest.ceremony;
  if (!c) return;
  text('count', c.chainLength);
  text('count-note', c.phase === 'Closed' ? 'Includes the final beacon contribution' : 'Recorded on Sui');
  text('access', c.permissioned ? 'Permissioned' : 'Permissionless');
  const active = c.phase === 'Phase2Contribute';
  text('slot', active ? c.slot.state : 'Inactive');
  text('slot-note', active ? c.slot.state === 'Pending' ? 'Submitted; awaiting a verdict' : c.slot.state === 'Claimed' ? 'Contribution in progress' : 'Ready for a contributor' : 'Contributions are not open');
  text('queue', unavailable ? '—' : latest.queue?.waitingCount ?? '—');
  const reported = c.slot.reportedName ? `${c.slot.reportedName} (reported)` : 'Name not reported yet';
  text('contributor', active && c.slot.address ? c.slot.name || reported : 'No active contributor');
  text('contributor-address', active ? c.slot.address || '' : '');
  text('deadline', active && c.slot.until != null ? `Claim deadline: ${utc(c.slot.until)} UTC (Sui clock)` : '');
  const phases = [...$('phases').children];
  const phaseIndex = phases.findIndex((item) => item.dataset.phase === c.phase);
  phases.forEach((item, index) => {
    item.classList.toggle('active', index === phaseIndex);
    item.classList.toggle('done', index < phaseIndex);
    if (index === phaseIndex) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
}

async function refresh() {
  if (loading) return;
  loading = true;
  clearTimeout(timer);
  try {
    const response = await fetch('/status.json', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (response.status !== 200 && response.status !== 503) throw new Error('Status unavailable');
    const status = await response.json();
    if (!status.attestor || !Number.isFinite(status.asOf)) throw new Error('Monitoring unavailable');
    latest = status;
    receivedAt = Date.now();
    unavailable = false;
    // Use textContent for all names and addresses, including untrusted names.
    $('recent').replaceChildren();
    for (const contribution of status.ceremony?.recent || []) {
      const row = document.createElement('tr');
      for (const [i, value] of [contribution.index, contribution.name || 'Unnamed', contribution.address, utc(contribution.acceptedAt)].entries()) {
        const cell = document.createElement('td');
        cell.textContent = value;
        if (i === 2) { cell.className = 'mono address-cell'; }
        row.append(cell);
      }
      $('recent').append(row);
    }
    $('empty').hidden = !!status.ceremony?.recent.length;
  } catch {
    unavailable = true;
  } finally {
    loading = false;
    render();
    timer = setTimeout(refresh, 30_000);
  }
}
$('refresh').addEventListener('click', refresh);
setInterval(() => { if (latest || unavailable) render(); }, 1000);
refresh();
