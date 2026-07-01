# Live TV EPG "blank past first page" — Design

**Date:** 2026-06-30
**Repo:** fork of `Moonfin-Client/Smart-TV` at tag `2.6.0`
**Branch:** `fix/livetv-epg-scroll`
**Scope:** personal build (not necessarily upstreamed)
**File under change:** `packages/app/src/views/LiveTV/LiveTV.js` (+ `LiveTV.module.less`)

## Problem

In the Live TV **Program Guide (EPG)**, scrolling (via TV remote d-pad) beyond the
first page of channels makes the whole guide grid **go completely blank**. Focus
also dead-ends — you cannot navigate further down or scroll back up cleanly.

## Root cause

The guide uses a **hand-rolled vertical virtualization** that fights the Tizen
focus system:

- Only a slice of channels is mounted:
  `visibleChannels = filteredChannels.slice(channelWindowStart, windowEnd)`
  (`windowEnd = channelWindowStart + VISIBLE_ROWS(16) + OVERSCAN_ROWS(6)*2`).
  Rows outside the window exist only as the **height of top/bottom spacer divs** —
  they are not in the DOM and are not focusable.
- `channelWindowStart` advances **only** inside `handleScroll` (the
  `.guideContent` container's `onScroll`), via `firstVisibleIndex = scrollTop / 80`.
- On a d-pad TV there is no scrollbar drag. Focus moves between rows and
  `scrollIntoView({behavior: 'smooth'})` scrolls the container. If Tizen's WebKit
  delays, coalesces, or drops scroll events during smooth scrolling, the mounted
  window **falls behind** the viewport. Once the viewport reaches the bottom
  spacer, there are no mounted rows there → **blank**, and Spotlight has no
  focusable element below → navigation dead-ends.

Contributing/secondary issues:
- When the window shifts, the currently focused row can be **unmounted** (React
  recycles the slice), so Spotlight's current node goes stale. Program cells have
  no stable `spotlightId` (only `data-program-id`), making recovery harder.
- Row-height math assumes `CHANNEL_ROW_HEIGHT = 80`, but `.channelRow` is
  `height: 80px` **plus** `border-bottom: 1px` under default `content-box` sizing,
  so the spacer/index math drifts ~1px per row.

This diagnosis and the chosen direction were reviewed by Codex (peer consult,
2026-06-30), which ranked the same causes and recommended the targeted fix below
over a `VirtualList` migration.

## Chosen approach — remove vertical windowing, render all loaded channels

Delete the manual vertical virtualization entirely and render **all currently
loaded** `filteredChannels`. Keep the existing paged API loading (50 channels per
batch). Rationale:

- Kills the failure mode at the source: every loaded row is mounted and
  focusable, so there is no unmounted region to go blank and no focus dead-end.
- Small, low-risk diff for a personal build. No dependency on `onScroll` timing
  for *rendering* correctness.
- Live TV channel counts are modest (tens to a few hundred). Each row still only
  renders the handful of program cells that fall inside the fixed 6-hour window,
  so per-row cost is bounded.

Rejected (Codex-concurred): migrating to Enact `VirtualList`/`VirtualGridList`.
It is the right long-term tool and is already used elsewhere in the app
(Favorites, Library, Jellyseerr, Genres), but this EPG is a **two-axis** grid
(vertical channels × horizontal absolute-positioned program cells, sticky channel
column, synced time header). Adapting it is a real rewrite with focus-integration
risk — out of scope for fixing this bug.

## Changes

### 1. Render all loaded channels (remove windowing)
`LiveTV.js`:
- Remove `channelWindowStart`, `channelWindowStartRef`, `setChannelWindowStart`,
  the `windowEnd`/`visibleChannels`/`topSpacerHeight`/`bottomSpacerHeight`
  computation, the two spacer `<div>`s, and the `channelWindowStartRef >= length`
  reset effect.
- Map over `filteredChannels` directly to render channel rows.
- Remove the windowing constants that become dead (`VISIBLE_ROWS`,
  `OVERSCAN_ROWS`). Keep `CHANNEL_ROW_HEIGHT` only if the quick-jump still needs
  it (see change 3); if change 3 switches to `offsetTop`, remove it too.

### 2. Decouple "load more" from onScroll alone
`onScroll` reliability on Tizen is itself suspect, so infinite loading must not
depend solely on it:
- **Primary trigger:** when a channel near the end of the loaded list gains focus
  (e.g. within the last N rows), call `loadChannels()`. This is driven by
  Spotlight focus, which always fires, rather than by native scroll events.
- **Keep** the existing scroll-position trigger in `handleScroll` as a secondary
  path (harmless, and covers mouse/pointer scroll).
- Preserve the existing guards: `hasMoreChannelsRef`, the in-flight/`isLoading`
  check, and `CHANNELS_PER_BATCH`. Ensure re-entrancy is safe (no duplicate
  concurrent fetches for the same offset).

### 3. Fix the row-height mismatch
Since we no longer use spacer math, `CHANNEL_ROW_HEIGHT`-based pixel math largely
disappears. For the one remaining consumer — the channel-number quick-jump
(`handleChannelNumber` sets `guideContent.scrollTop` from `index * CHANNEL_ROW_HEIGHT`) —
make row height authoritative:
- Add `box-sizing: border-box` to `.channelRow` so its real height is exactly
  `80px` (border included), OR compute scroll offset from the actual element via
  `element.offsetTop`. Prefer `offsetTop` of the target row (robust to any future
  height change); fall back to `box-sizing: border-box` if simpler.

### 4. Keep the time-header horizontal sync
`handleScroll` still syncs `timeSlotsRef.scrollLeft = guideContent.scrollLeft`.
That behavior is unrelated to the bug and stays.

## Diagnostic step (before finalizing)
Before committing the fix as final, confirm the root cause on-device with a
temporary logging build (guarded, removed before final):
- Log `scrollTop`, focused channel id/index, and whether `document.activeElement`
  stays connected after scrolling.
- Temporarily set `scrollIntoView` `behavior: 'auto'` to test whether smooth-scroll
  event lag is implicated.
If disabling windowing makes the blank disappear, the diagnosis is confirmed.

## Testing

- **Unit (TDD where it fits):** the load-more decision is pure logic — extract a
  small helper `shouldLoadMore({focusedIndex, loadedCount, hasMore, isLoading})`
  (and/or the scroll-position variant) and unit-test it with jest (the repo's
  existing test runner). Boundary cases: focus on last row, hasMore false,
  already loading, empty list.
- **End-to-end (authoritative):** build `.wgt`, install via Apps2Samsung, open
  Live TV, and d-pad scroll well past the first page. Confirm: rows keep
  rendering, focus is retained, no blank region, and additional batches load.
- **Regression:** favorites filter toggle still works (list shrinks/grows without
  blanking); channel-number quick-jump still scrolls to the right channel.
- **Perf check:** verify smooth scrolling at 50 / 100 / 200+ loaded channels. If
  unacceptable, revisit (Enact `VirtualList`) — but only then.

## Build & deploy (no Tizen Studio)

- Node 18+ (local is v24 — watch for build-tool incompatibility; fall back to an
  LTS Node via nvm if the build breaks).
- `npm install` at repo root (npm workspaces).
- Build + package the Tizen `.wgt` using the repo's `build-wgt.js`
  `--skip-tizen-cli` **zip fallback** (produces an unsigned `.wgt`). If the `zip`
  CLI is unavailable on Windows, substitute an equivalent zip step
  (PowerShell `Compress-Archive` or a Node zip) that yields a byte-valid `.wgt`.
- Install the unsigned `.wgt` via **Apps2Samsung**, which handles the developer
  certificate/signing and pushes to the TV.

## Out of scope
- `VirtualList` migration.
- Any change to Recordings, playback (AVPlay), or non-LiveTV views.
- Upstream PR formatting (personal build).
