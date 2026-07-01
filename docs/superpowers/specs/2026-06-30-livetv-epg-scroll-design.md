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
- Remove the now-dead windowing constants `VISIBLE_ROWS`, `OVERSCAN_ROWS`, and
  `CHANNEL_ROW_HEIGHT` (change 3 switches the last consumer to `offsetTop`).

### 2. Decouple "load more" from onScroll alone
`onScroll` reliability on Tizen is itself suspect, so infinite loading must not
depend solely on it:
- **Primary trigger:** add `onFocusCapture={() => handleChannelRowFocus(index)}`
  to each `ChannelRowContainer` (LiveTV.js:458, inside the `filteredChannels.map`
  at :457). React focus **bubbles** from both the `.channelInfo` element and the
  descendant `ProgramCell`s (:489), so this fires on focus anywhere in the row —
  no need to add stable `spotlightId`s to program cells. `handleChannelRowFocus`
  calls `loadChannels()` when `index >= loadedCount - THRESHOLD` (THRESHOLD ≈ 10).
- **Keep** the existing scroll-position trigger in `handleScroll` as a secondary
  path (covers pointer/scroll; harmless).
- **Add a dedicated append in-flight guard.** `isLoading` only wraps the
  initial/date-reset load (LiveTV.js:150) — it does **not** guard append calls, so
  the focus trigger and the scroll trigger could fire `loadChannels()`
  concurrently and both read the same `currentChannelIndexRef.current` (:114),
  double-appending or skipping a batch. Introduce `isLoadingMoreRef` set at the
  **top of `loadChannels`** (for non-reset calls) and cleared in a `finally`;
  bail early if already set. Preserve the existing `hasMoreChannelsRef` and
  `CHANNELS_PER_BATCH` guards.

### 3. Fix the row-height mismatch
Since we no longer use spacer math, `CHANNEL_ROW_HEIGHT`-based pixel math
disappears. The one remaining consumer is the channel-number quick-jump
(`handleChannelNumber` at LiveTV.js:173 sets `guideContent.scrollTop` from
`index * CHANNEL_ROW_HEIGHT`, which drifts because `.channelRow` is `height:80px`
**plus** a `1px` border under `content-box`, LiveTV.module.less:132). Because all
loaded rows are now mounted, switch the jump to query the target row element and
use its **`offsetTop`** — robust to any future height/border change — and delete
`CHANNEL_ROW_HEIGHT`.

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

- **Unit (optional, TDD where it fits):** the load-more decision is pure logic —
  optionally extract a thin helper
  `shouldLoadMore({focusedIndex, loadedCount, hasMore, isLoadingMore, threshold})`
  and unit-test it with the repo's existing runner. Boundary cases: focus on last
  row, `hasMore` false, already loading, empty list. Keep it thin — do not
  overbuild scroll math around it; the authoritative test is on-device d-pad
  navigation.
- **End-to-end (authoritative):** build `.wgt`, install via Apps2Samsung, open
  Live TV, and d-pad scroll well past the first page. Confirm: rows keep
  rendering, focus is retained, no blank region, and additional batches load.
- **Regression:** favorites filter toggle still works (list shrinks/grows without
  blanking); channel-number quick-jump still scrolls to the right channel.
- **Perf check:** verify smooth scrolling at 50 / 100 / 200+ loaded channels. If
  unacceptable, revisit (Enact `VirtualList`) — but only then.

## Build & deploy (no Tizen Studio)

- Node 18+ (local is v24). v24 is within the dependency range (`ilib` requires
  `>=8 <25`), so it should build. If the build tooling fails, fall back to Node
  20/22 LTS (via nvm) — don't pre-solve this; discover at build time.
- `npm install` at repo root (npm workspaces).
- Build + package with `npm run build:tizen -- --skip-tizen-cli` (package.json:11),
  which uses `build-wgt.js`'s **zip fallback** (produces an *unsigned* `.wgt`).
  **Caveat:** the fallback shells out to an external `zip` binary
  (build-wgt.js:84) and hard-fails if it's missing (build-wgt.js:463). Windows
  has no `zip` by default and `Compress-Archive` is **not** substituted
  automatically. So the build step must first check for `zip`; if absent, either
  (a) provide a `zip` on PATH, or (b) run an explicit `Compress-Archive` (or Node)
  step over the built `dist/` to emit a byte-valid `.wgt`. This is a build-time
  action item, not a code change to the repo.
- Install the unsigned `.wgt` via **Apps2Samsung**, which handles the developer
  certificate/signing and pushes to the TV.

## Out of scope
- `VirtualList` migration.
- Any change to Recordings, playback (AVPlay), or non-LiveTV views.
- Upstream PR formatting (personal build).
