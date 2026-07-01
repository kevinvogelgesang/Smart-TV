# Live TV EPG "blank past first page" — Design (Route A: VirtualList)

**Date:** 2026-06-30
**Repo:** fork of `Moonfin-Client/Smart-TV` at tag `2.6.0`
**Branch:** `fix/livetv-epg-scroll`
**Scope:** personal build (not necessarily upstreamed)
**File under change:** `packages/app/src/views/LiveTV/LiveTV.js` (+ `LiveTV.module.less`)

## Problem

In the Live TV **Program Guide (EPG)**, scrolling (via TV remote d-pad) beyond the
first page of channels makes the whole guide grid **go completely blank**, and
focus dead-ends — you cannot navigate further or scroll back cleanly.

## Root cause

The guide uses a **hand-rolled vertical virtualization** that fights Tizen's
focus system:

- Only a slice of channels is mounted (`visibleChannels =
  filteredChannels.slice(channelWindowStart, windowEnd)`). Rows outside the
  window exist only as the height of top/bottom spacer divs — not in the DOM,
  not focusable.
- `channelWindowStart` advances **only** inside `handleScroll` (the
  `.guideContent` `onScroll`). On a d-pad TV there is no scrollbar drag: focus
  moves and `scrollIntoView` scrolls. If Tizen's WebKit delays/coalesces/drops
  scroll events during smooth scrolling, the mounted window falls behind; once
  the viewport reaches the bottom spacer, no rows are mounted there → **blank**,
  and Spotlight has no focusable element below → dead-end.
- Secondary: window shifts can unmount the focused row (Spotlight's current node
  goes stale); `CHANNEL_ROW_HEIGHT = 80` ignores `.channelRow`'s `+1px` border.

## Why virtualization must stay (design constraint)

Kevin's lineup is **~560 channels**. Rendering all rows (each a sticky channel
column + an absolute-positioned 6-hour program strip) is too heavy for the TV.
So we cannot "render all"; we must **keep virtualization but make it correct with
Spotlight**. Spotlight always chooses the next focus target from the
**currently-mounted DOM**, so any hand-rolled windowing races Tizen scroll timing
and React commit timing. The robust answer is to hand that problem to Enact's
purpose-built virtualization.

This diagnosis and the Route-A decision below were reviewed by Codex across four
consults (2026-06-30): it recommended `VirtualList` with the two axes split, over
extending the manual windowing, specifically because of the 560-channel scale.

## Chosen approach — Route A: Enact `VirtualList`, axes split

Replace the hand-rolled windowing with Enact `VirtualList`
(`@enact/sandstone/VirtualList`, already used in the repo), and **split the two
axes** so `VirtualList` only ever handles fixed-height vertical rows:

- **Vertical (channels):** `VirtualList` owns it. `dataSize =
  filteredChannels.length`, `itemSize={80}` (**raw px** — LiveTV uses raw px, not
  `ri.scale`, so this matches `.channelRow`'s CSS height), `direction="vertical"`,
  `horizontalScrollbar="hidden"` (horizontal scroll belongs to the wrapper),
  `spotlightId="program-grid"`. Its `itemRenderer({index, ...rest})` renders one
  channel row and **must spread `rest`** onto the row root (Sandstone injects
  `data-index` there, used for Spotlight restoration + index scroll/focus).
- **Horizontal (time):** a wrapper *outside* `VirtualList` owns it —
  `.guideHorizontalScroller` (`overflow-x: auto; overflow-y: hidden; flex: 1`)
  containing a wide surface (`width: channelColumnWidth + HOURS_TO_DISPLAY *
  PIXELS_PER_HOUR`, i.e. `200 + 3600 = 3800px`) that holds the `VirtualList`.
- **Time-header sync** moves from `guideContent.scrollLeft` to the horizontal
  wrapper's `scrollLeft` (`onScroll` on `.guideHorizontalScroller`).

`VirtualList` never handles horizontal scrolling — it only sees fixed-height rows.
The horizontal wrapper scrolls the wide row contents; the time header mirrors it.

Rejected — **Route B (fix the hand-rolled windowing to be focus-driven /
focus-safe):** achievable (buffer window around the focused index, restore focus
in `useLayoutEffect` after commits) but it stays a focus/scroll race tuned against
Tizen timing. Not robust enough at 560 channels. Only fall back to B if Route A
is blocked by an Enact API limitation discovered during implementation.

## Changes

### 1. Restructure the guide layout (LiveTV.js + LiveTV.module.less)
- Replace the both-axis `.guideContent` `ProgramGridContainer` with:
  `.guideHorizontalScroller` (ref `guideHorizontalRef`, `onScroll` →
  horizontal-sync handler) → `.guideWideSurface` (fixed 3800px width) →
  `<VirtualList>`.
- CSS: add `.guideHorizontalScroller { overflow-x:auto; overflow-y:hidden;
  flex:1; }`, `.guideWideSurface { width: <200 + 3600>px; height:100%; }`. Keep
  `.channelRow`, `.channelInfo`, `.programsContainer`, `.programCell` as-is; add
  `box-sizing: border-box` to `.channelRow` so its measured height is exactly 80.

### 2. `itemRenderer` renders one channel row
- Extract `renderChannelRow = useCallback(({index, key, ...rest}) => {...})`
  returning the existing row markup for `filteredChannels[index]` (channel column
  + program strip + current-time indicator). It must spread the Enact-provided
  props onto the row root and use the provided `key`.
- Program cells must keep the `currentTimePosition` indicator and
  `calculateProgramStyle` logic unchanged.

### 3. Stable Spotlight IDs
`VirtualList` recycles item DOM, so focus targets need stable IDs:
- Row container: `spotlightId={`ch-row-${channel.Id}`}` (already present).
- Channel-info element: add `spotlightId={`ch-info-${channel.Id}`}`.
- Program cells: add `spotlightId={`program-${channel.Id}-${program.Id}`}` (pass
  channel + program into `ProgramCell`).

### 4. Load-more without the old scroll math
Trigger paging from row **focus** (a real event, reliable on Tizen), not from a
render side-effect and not from container scrollTop:
- Primary: `onFocusCapture={() => handleChannelRowFocus(index)}` on each row; the
  handler calls `loadChannels()` when `shouldLoadMore({focusedIndex: index,
  loadedCount: filteredChannels.length, hasMore, isLoadingMore})` (threshold ≈ 10).
  Focus bubbles from the channel-info element and program cells to the row.
- Backup: `VirtualList`'s `onScrollStop` may also probe `shouldLoadMore` using the
  last rendered index, for pointer/wheel scroll. (Do **not** call `loadChannels`
  from inside `itemRenderer` — that is a render-time side effect.)
- **Add a dedicated append guard** `isLoadingMoreRef`: `isLoading` only wraps the
  initial/date-reset load, not appends, so concurrent triggers could double-fetch
  off the same `currentChannelIndexRef.current`. Set it (for append calls only) at
  the top of `loadChannels` and clear it in a `finally` (append calls only).

### 5. Channel-number quick-jump via VirtualList scroll-to
The old `scrollTop = index * CHANNEL_ROW_HEIGHT` cannot target a `VirtualList`.
Use `VirtualList`'s official scroll-to callback (confirmed present in installed
`@enact/sandstone` **2.9.13**, `VirtualList.js:135–164`):
- Set `cbScrollTo={fn => { scrollToRef.current = fn; }}` on the list.
- On a channel-number match, `scrollToRef.current({index: channelIndex,
  animate: false})`, then focus the inner channel element by spotlightId with a
  short retry (VirtualList's own `focus:true` targets the item node it tracks by
  `data-index` — the row *container*, a Spotlight container, not the spottable
  channel-info — so drive focus explicitly): `Spotlight.focus(`ch-info-${id}`)`,
  retrying every 50ms up to ~5 times because the target item may not be mounted
  the instant `scrollTo` is called.
- Delete `CHANNEL_ROW_HEIGHT` (no longer used).

### 6. Remove dead windowing code
Delete `channelWindowStart`/`channelWindowStartRef`/`setChannelWindowStart`, the
`windowEnd`/`visibleChannels`/`topSpacerHeight`/`bottomSpacerHeight` computation,
both spacer divs, the `channelWindowStartRef >= length` reset effect, the
window-advance block in `handleScroll`, and the constants `VISIBLE_ROWS`,
`OVERSCAN_ROWS` (and `CHANNEL_ROW_HEIGHT` after change 5).

## Implementation-time verifications (must resolve before/while coding)
These are unknowns that determine exact code; verify via a quick prototype:
1. ~~**Scroll-to API**~~ — RESOLVED: `cbScrollTo` → `scrollTo({index, animate,
   focus})` in sandstone 2.9.13 (see change 5).
2. **`position: sticky` inside a `VirtualList` item:** does the 200px channel
   column stay pinned-left while the wide surface scrolls horizontally? If sticky
   breaks inside recycled `VirtualList` DOM, fall back to a separate fixed
   channel-column overlay synchronized by row index. Try sticky first.
3. **`scrollIntoView` interaction:** confirm a focused program cell's
   `scrollIntoView({inline:'nearest'})` scrolls the **horizontal wrapper**, not
   the `VirtualList`'s internal vertical scroller (adjust to `block:'nearest'`
   vs `inline` as needed).

## Testing
- **Unit (TDD):** `shouldLoadMore({focusedIndex, loadedCount, hasMore,
  isLoadingMore, threshold})` pure helper in `packages/app/src/utils/`, tested
  with the repo runner (`enact test`). Boundaries: near end, `hasMore` false,
  already loading, empty list (`loadedCount<=0` → false).
- **Prototype (de-risk):** before wiring real data, stand up the split-axis
  layout with ~100 fake rows; confirm vertical d-pad scrolling never blanks,
  horizontal scroll + header sync works, and sticky channel column holds.
- **End-to-end (authoritative)** on the TV via Apps2Samsung: d-pad down **past
  100+ and toward all ~560** channels (no blank, focus retained, batches load);
  horizontal left/right across program cells; channel-number jump to a far index;
  focus return from guide controls (up/down interplay); favorites filter.
- **Perf:** confirm smooth scrolling at the full 560-channel lineup (the whole
  point of keeping virtualization).

## Build & deploy (no Tizen Studio)
- Node 18+ (local v24 is within `ilib >=8 <25`; fall back to Node 20/22 LTS if
  build tooling fails). `npm install` at repo root.
- Package with `npm run build:tizen -- --skip-tizen-cli` (unsigned zip fallback,
  `build-wgt.js`). `zip` is **not** on this Windows PATH and is not auto-
  substituted, so the build step must supply a `zip` binary OR run an explicit
  `Compress-Archive` over `packages/build-tizen/dist` (contents at archive root,
  `config.xml` at top level) to emit a valid `.wgt`.
- Install the unsigned `.wgt` via **Apps2Samsung** (handles dev-cert signing +
  push to TV).

## Out of scope
- `VirtualGridList` for the program cells (horizontal strip stays absolute-
  positioned within each row).
- Any change to Recordings, playback (AVPlay), or non-LiveTV views.
- Upstream PR formatting (personal build).
