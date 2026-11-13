export function formatQueueActivity(waitingCount, { minutesPerContribution = 10, running = false } = {}) {
  if (!Number.isSafeInteger(waitingCount) || waitingCount < 0) return null;
  if (!Number.isFinite(minutesPerContribution) || minutesPerContribution <= 0) return null;
  const minutes = waitingCount * minutesPerContribution;
  if (minutes > 60) return `About ${waitingCount} contributors are waiting. The ceremony is busy.${running ? '' : ' Try again in a few hours.'}`;
  return `About ${waitingCount} contributors are waiting (roughly ${minutes} minutes).`;
}

// Each waiting contributor can hold the slot for up to one claim window, so
// estimate with the ceremony's on-chain window when the caller knows it.
export async function reportQueueActivity(baseUrl, ceremonyId, log, { slotDurationMs } = {}) {
  if (!baseUrl) return;
  try {
    const url = new URL('/queue', baseUrl);
    url.searchParams.set('ceremonyId', ceremonyId);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const minutesPerContribution = slotDurationMs > 0 ? Math.ceil(slotDurationMs / 60_000) : undefined;
    const message = formatQueueActivity((await response.json()).waitingCount, { running: true, minutesPerContribution });
    if (message) log(message);
  } catch { /* Activity reporting never gates contribution. */ }
}
