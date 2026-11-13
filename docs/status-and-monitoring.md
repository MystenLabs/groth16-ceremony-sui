# Status page and monitoring

This document describes the public HTTP endpoints of the coordinator:
the status page, the health endpoint, and the contribution activity count.

## Ceremony status page

With the attestor's HTTP server enabled (`--port 8090`), `/status` shows the
ceremony phase, accepted contribution count, slot and claim deadline, approximate
waiting count, latest 20 accepted contributions, and attestor activity. It
refreshes every 30 seconds. Names come from on-chain submissions; a first-time
claimant's name is not yet available. The accepted count includes the final beacon
contribution once the ceremony is closed.

`GET /status.json` returns HTTP 200 for fresh, healthy attestor activity or HTTP
503 during startup, after a loop failure, or when activity becomes stale. It uses
the existing loop's observations, without additional Sui requests per viewer.
Polling gets at least 30 seconds of grace (or three polling intervals);
downloads and verdict transactions get two minutes; isolated verification gets
its configured timeout plus one minute. These are activity deadlines, not proof
that every operation is making progress. Long synchronous downloads can also
temporarily prevent the HTTP server from responding. Connection failures leave
the page's previous data visible with an explicit outdated-data warning.

Serve the static assets with Caddy so the page remains reachable when the attestor
is down. An example configuration is in `coordinator/Caddyfile.example`:

```bash
sudo install -d -m 755 /var/www/zkceremony-status
sudo install -m 644 coordinator/src/status_page.html coordinator/src/status_page.js /var/www/zkceremony-status/
# Merge the example's /status and /status.js routes into your Caddyfile.
# Keep /status.json proxied to the attestor, along with the existing API routes.
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Only these two public files belong in the static directory. The status API
exposes public ceremony data and operational timestamps, not private funding
URLs, wallet state, raw errors, or telemetry logs. `/healthz` remains the Caddy
connectivity check. For an attestor health check from a script, use
`curl --fail --show-error --max-time 10 https://zkceremony.sui.io/status.json`.
Restart the attestor after installing the backend changes to activate monitoring.
The contributor CLI checks this endpoint immediately before claiming or resuming
a slot, including when a slot becomes available after waiting. It requires a
healthy response for the same ceremony/network and stops with same-workdir retry
guidance on failure, before any claim transaction or contribution computation.
Chain contributions therefore require a configured public coordinator URL and
an attestor exposing `/status.json`; older servers without this endpoint must be
updated. Automatic funding, if needed, happens before this readiness check.

## Approximate contribution activity

The coordinator serves `GET /queue?ceremonyId=<Sui object ID>`:

```json
{"waitingCount":5,"asOf":"2026-09-11T15:00:00.000Z"}
```

`waitingCount` counts distinct contributor addresses reporting `waiting_for_slot`
through `POST /heartbeat`, scoped to the ceremony. The CLI reports this state only
when funded and eligible to claim, while another contributor holds the slot or
awaits verification. Funding/approval waits and the active contributor are excluded.
Heartbeats run every 30 seconds; entries expire after 90 seconds without a refresh.
State changes are reported immediately, best effort. The endpoint requires a valid
ceremony ID (otherwise HTTP 400), returns `Cache-Control: no-store`, and exposes
no contributor identities.

This is self-reported activity, not an ordered queue or a guaranteed wait time.
Clients without reporting are invisible; disconnected clients can remain counted
until expiry. Counts reset on coordinator restart and describe this server's
clients only. An empty count does not establish that the on-chain slot is open.

Consumers can estimate activity as `waitingCount` times the ceremony's on-chain claim
window, `slot_duration_ms` (15 minutes by default), which bounds how long each waiting
contributor can hold the slot. Up to 60 minutes, display e.g. “About 5 contributors waiting · roughly 50
minutes of contribution activity.” Above 60 minutes: “The ceremony is busy. Try
checking back in a few hours.” Include “Estimates are approximate; availability
may change.” The CLI shows activity once when it begins waiting and tells users
they can leave it running; it continues trying to claim regardless of this endpoint.
The shared CLI formatter in `cli/src/queue-activity.js` supports both messages.
