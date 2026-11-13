import { normalizeSuiAddress } from '@mysten/sui/utils';
import { validatePublicCoordinatorUrl } from './funding.js';

// A responsive HTTP server alone does not prove the attestor loop is running.
export async function requireAttestorHealthy(baseUrl, ceremonyId, network, { fetchFn = fetch } = {}) {
  if (!baseUrl) throw new Error('cannot check attestor health: no coordinator URL is configured; ask the organizer to set it or pass --coordinator-url');
  validatePublicCoordinatorUrl(baseUrl);
  const retry = 'rerun with the same workdir once the organizer restores the attestor';
  let response;
  try {
    response = await fetchFn(new URL('/status.json', baseUrl), {
      method: 'GET', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(`attestor unavailable (connection failed or timed out); ${retry}`);
  }
  if (!response.ok) throw new Error(`attestor unavailable (health check returned HTTP ${response.status}); ${retry}`);
  let status;
  try { status = await response.json(); }
  catch { throw new Error(`attestor health check returned an invalid response; ${retry}`); }
  if (status?.ok !== true || status.attestor?.stale !== false ||
      !['waiting', 'polling', 'verifying', 'accepting', 'rejecting'].includes(status.attestor?.state)) {
    throw new Error(`attestor unavailable (health check did not report a healthy loop); ${retry}`);
  }
  if (status.network !== network || typeof status.ceremonyId !== 'string' ||
      normalizeSuiAddress(status.ceremonyId) !== normalizeSuiAddress(ceremonyId)) {
    throw new Error('attestor health response is for a different ceremony or network; ask the organizer to correct the coordinator URL, then rerun with the same workdir');
  }
}
