# Live TV EPG Blank-on-Scroll Fix — Implementation Plan (Route A: VirtualList)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Live TV Program Guide going blank when scrolling past the first page, robustly at ~560 channels, by replacing the hand-rolled virtualization with Enact `VirtualList` (axes split: `VirtualList` = vertical channels; an outer wrapper = horizontal time).

**Architecture:** The guide is a 2-axis grid (channels × time). `VirtualList` (`@enact/sandstone/VirtualList`) owns **only** vertical virtualization of fixed-height (80px) channel rows — its ideal case, and the case Spotlight focus is designed to traverse. A `.guideHorizontalScroller` wrapper *outside* the list owns horizontal time scrolling over a fixed-width (3800px) surface; the time header syncs from that wrapper. This removes the unmounted-row/blank failure entirely because `VirtualList` mounts the rows Spotlight needs.

**Tech Stack:** React hooks + Enact/Sandstone + Enact Spotlight; `@enact/sandstone/VirtualList` 2.9.13; `@enact/cli` (`enact test` = jest, `enact lint`); Less modules. Jellyfin API in `packages/app/src/services/jellyfinApi.js`.

## Global Constraints

- **Only touch** `packages/app/src/views/LiveTV/LiveTV.js`, `packages/app/src/views/LiveTV/LiveTV.module.less`, and a new `packages/app/src/utils/liveTvPaging.js` (+ its test). Do **not** modify Recordings, playback/AVPlay, or other views.
- **Keep virtualization** — do NOT render all 560 rows. `VirtualList` mounts only what's near the viewport.
- **Raw pixels, not `ri.scale`** — LiveTV.js/less use raw px throughout (`PIXELS_PER_HOUR=600`, row `80px`, channel column `200px`). Keep it raw so JS constants and CSS agree. `itemSize={80}`, not `ri.scale(80)`.
- **Match existing file style:** tab indentation, single quotes, semicolons, `useCallback`/`useRef` patterns already in `LiveTV.js`.
- **Node 18+** (local v24 built fine; if tooling later fails, use Node 20/22 LTS via nvm).
- **Build the `.wgt` without Tizen Studio:** `npm run build:tizen -- --skip-tizen-cli`. `zip` is not on this Windows PATH, so archive `packages/build-tizen/dist` contents with `Compress-Archive` (config.xml at root) to emit the `.wgt`. Install via **Apps2Samsung** (handles signing).
- **Commit after every task.** Before each commit run `git status` and stage only that task's files (never blind `git add -A` except the final housekeeping commit). Author: `Kevin Vogelgesang <kevin@enrollmentresources.com>`.

---

### Task 1: `shouldLoadMore` paging helper (TDD)

Pure decision logic for "fetch the next channel batch?", TDD'd in isolation, colocated with the other util tests.

**Files:**
- Create: `packages/app/src/utils/liveTvPaging.js`
- Test: `packages/app/src/utils/liveTvPaging.test.js`

**Interfaces:**
- Produces: `shouldLoadMore({focusedIndex, loadedCount, hasMore, isLoadingMore, threshold})` → `boolean`. `true` iff `hasMore && !isLoadingMore && loadedCount > 0 && focusedIndex >= loadedCount - threshold`. `threshold` defaults to `10`.

- [ ] **Step 1: Write the failing test** — create `packages/app/src/utils/liveTvPaging.test.js`:

```javascript
import {shouldLoadMore} from './liveTvPaging';

const base = {focusedIndex: 45, loadedCount: 50, hasMore: true, isLoadingMore: false};

describe('shouldLoadMore', () => {
	test('loads when focus is within threshold of the end', () => {
		expect(shouldLoadMore({...base, focusedIndex: 45})).toBe(true);
	});
	test('does not load when focus is far from the end', () => {
		expect(shouldLoadMore({...base, focusedIndex: 20})).toBe(false);
	});
	test('does not load when there is no more to fetch', () => {
		expect(shouldLoadMore({...base, hasMore: false})).toBe(false);
	});
	test('does not load when a fetch is already in flight', () => {
		expect(shouldLoadMore({...base, isLoadingMore: true})).toBe(false);
	});
	test('loads at the exact boundary', () => {
		expect(shouldLoadMore({...base, focusedIndex: 40, loadedCount: 50, threshold: 10})).toBe(true);
	});
	test('does not load for an empty mounted list', () => {
		expect(shouldLoadMore({focusedIndex: 0, loadedCount: 0, hasMore: true, isLoadingMore: false})).toBe(false);
	});
	test('respects a custom threshold', () => {
		expect(shouldLoadMore({...base, focusedIndex: 47, loadedCount: 50, threshold: 2})).toBe(true);
		expect(shouldLoadMore({...base, focusedIndex: 45, loadedCount: 50, threshold: 2})).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd packages/app && npm test -- liveTvPaging` → FAIL (module not found).

- [ ] **Step 3: Implement** — create `packages/app/src/utils/liveTvPaging.js`:

```javascript
/**
 * Decide whether to fetch the next batch of Live TV channels.
 * @returns {boolean}
 */
export const shouldLoadMore = ({focusedIndex, loadedCount, hasMore, isLoadingMore, threshold = 10}) => {
	if (!hasMore || isLoadingMore) return false;
	if (loadedCount <= 0) return false;
	return focusedIndex >= loadedCount - threshold;
};
```

- [ ] **Step 4: Run test to verify it passes** — `cd packages/app && npm test -- liveTvPaging` → PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/utils/liveTvPaging.js packages/app/src/utils/liveTvPaging.test.js
git commit -m "feat(livetv): add shouldLoadMore paging helper with tests"
```

---

### Task 2: Concurrent-append guard in `loadChannels`

`isLoading` only wraps the initial/date-reset load, so once focus + scroll both trigger paging, two `loadChannels()` calls could read the same offset and double-append. Add a ref guard scoped to append calls only.

**Files:** Modify `packages/app/src/views/LiveTV/LiveTV.js` (refs ~line 81; `loadChannels` ~103–148).

**Interfaces:** Produces `isLoadingMoreRef` (`useRef(false)`), read by Task 5's focus trigger.

- [ ] **Step 1: Add the ref** — after `const hasMoreChannelsRef = useRef(true);` (~line 81):

```javascript
	const isLoadingMoreRef = useRef(false);
```

- [ ] **Step 2: Guard the append path** — replace the head of `loadChannels` (lines ~103–111, the `if (reset) {...}` block through `if (!hasMoreChannelsRef.current) return;`):

```javascript
	const loadChannels = useCallback(async (reset = false) => {
		const isAppend = !reset;

		if (reset) {
			currentChannelIndexRef.current = 0;
			hasMoreChannelsRef.current = true;
			setChannels([]);
			setPrograms({});
		}

		if (!hasMoreChannelsRef.current) return;
		if (isAppend && isLoadingMoreRef.current) return;
		if (isAppend) isLoadingMoreRef.current = true;
```

- [ ] **Step 3: Clear in `finally` (append only)** — turn the existing `try { ... } catch (err) {...}` tail into:

```javascript
		} catch (err) {
			console.error('Failed to load channels:', err);
		} finally {
			if (isAppend) isLoadingMoreRef.current = false;
		}
	}, [api, getGuideStartTime, getGuideEndTime]);
```

- [ ] **Step 4: Lint** — `cd packages/app && npm run lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/views/LiveTV/LiveTV.js
git commit -m "fix(livetv): guard against concurrent channel append fetches"
```

---

### Task 3: Add split-axis layout CSS

**Files:** Modify `packages/app/src/views/LiveTV/LiveTV.module.less`.

- [ ] **Step 1: Add horizontal-scroller + wide-surface classes** — after the existing `.guideContent { ... }` rule (~line 130), add:

```less
.guideHorizontalScroller {
	flex: 1;
	overflow-x: auto;
	overflow-y: hidden;
	position: relative;
}

.guideWideSurface {
	height: 100%;
}

.channelVirtualList {
	width: 100%;
	height: 100%;
}
```

- [ ] **Step 2: Make row height exact** — add `box-sizing: border-box;` to `.channelRow` (so the `80px` height includes the `1px` border and matches `itemSize={80}`):

```less
.channelRow {
	display: flex;
	height: @row-height;
	box-sizing: border-box;
	border-bottom: 1px solid @border-color;

	&:last-child {
		border-bottom: none;
	}
}
```

- [ ] **Step 3: Lint** — `cd packages/app && npm run lint` → PASS (LESS compiles).

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/views/LiveTV/LiveTV.module.less
git commit -m "style(livetv): add split-axis scroller classes, exact row box-sizing"
```

---

### Task 4: Move the row into a `VirtualList` itemRenderer; remove hand-rolled windowing

The core structural change. Extract the row body into `renderChannelRow({index})`, render it via `VirtualList` inside the horizontal scroller, and delete all manual windowing.

**Files:** Modify `packages/app/src/views/LiveTV/LiveTV.js`.

**Interfaces:**
- Consumes: `filteredChannels`, `programs`, `serverUrl`, `calculateProgramStyle`, `isCurrentProgram`, `currentTimePosition`, `handleProgramClick`, `onPlayChannel`.
- Produces: `renderChannelRow` itemRenderer; `guideHorizontalRef`; `scrollToRef` (for Task 7).

- [ ] **Step 1: Add imports** — with the other imports (top of file):

```javascript
import VirtualList from '@enact/sandstone/VirtualList';
```

- [ ] **Step 2: Add constants + refs** — near the existing constants (~line 22) add the channel column width, and remove the windowing constants (`VISIBLE_ROWS`, `OVERSCAN_ROWS`; `CHANNEL_ROW_HEIGHT` is removed in Task 7):

```javascript
const CHANNEL_COLUMN_WIDTH = 200; // matches @channel-column-width in the .less
const ROW_HEIGHT = 80;            // matches @row-height (raw px, not ri.scale)
```

Add refs near the others (~line 77):

```javascript
	const guideHorizontalRef = useRef(null);
	const scrollToRef = useRef(null);
```

Delete the window state/ref (~lines 68–69): `channelWindowStart`, `setChannelWindowStart`, `channelWindowStartRef`.

- [ ] **Step 3: Delete windowing computation + effect** — remove:
  - the `channelWindowStartRef.current >= filteredChannels.length` reset effect (~lines 323–329),
  - the `windowEnd`/`visibleChannels`/`topSpacerHeight`/`bottomSpacerHeight` block (~lines 331–337),
  - the window-advance block inside `handleScroll` (`firstVisibleIndex`/`nextWindowStart`/`setChannelWindowStart`, ~lines 239–244).

- [ ] **Step 4: Rewrite `handleScroll` as the horizontal sync handler** — the old vertical concerns move to `VirtualList`; this now only mirrors horizontal scroll to the time header. Replace `handleScroll` with:

```javascript
	const handleHorizontalScroll = useCallback(() => {
		const scroller = guideHorizontalRef.current;
		if (scroller && timeSlotsRef.current) {
			timeSlotsRef.current.scrollLeft = scroller.scrollLeft;
		}
	}, []);
```

- [ ] **Step 5: Add `renderChannelRow`** — near the other memoized render logic (after `currentTimePosition`, ~line 376), add the itemRenderer built from the existing row body. It renders `filteredChannels[index]`:

```javascript
	const renderChannelRow = useCallback(({index, ...rest}) => {
		const channel = filteredChannels[index];
		if (!channel) return null;

		return (
			<ChannelRowContainer
				{...rest}
				key={channel.Id}
				className={css.channelRow}
				data-channel-id={channel.Id}
				spotlightId={`ch-row-${channel.Id}`}
				onFocusCapture={() => handleChannelRowFocus(index)} // eslint-disable-line react/jsx-no-bind
			>
				<SpottableDiv
					className={css.channelInfo}
					onClick={() => onPlayChannel?.(channel)} // eslint-disable-line react/jsx-no-bind
					data-channel-id={channel.Id}
					spotlightId={`ch-info-${channel.Id}`}
				>
					<div className={css.channelNumber}>{channel.ChannelNumber}</div>
					<div className={css.channelName}>{channel.Name}</div>
					{channel.ImageTags?.Primary && (
						<img
							className={css.channelLogo}
							src={`${serverUrl}/Items/${channel.Id}/Images/Primary?maxWidth=120&quality=90`}
							alt=""
						/>
					)}
				</SpottableDiv>
				<div
					className={css.programsContainer}
					style={{width: `${HOURS_TO_DISPLAY * PIXELS_PER_HOUR}px`}}
				>
					{currentTimePosition !== null && (
						<div className={css.currentTimeIndicator} style={{left: `${currentTimePosition}px`}} />
					)}
					{(programs[channel.Id] || []).map(program => {
						const style = calculateProgramStyle(program);
						if (!style) return null;
						return (
							<ProgramCell
								key={program.Id}
								program={program}
								channel={channel}
								style={style}
								isCurrent={isCurrentProgram(program)}
								onProgramClick={handleProgramClick}
							/>
						);
					})}
				</div>
			</ChannelRowContainer>
		);
	}, [filteredChannels, programs, serverUrl, currentTimePosition, calculateProgramStyle, isCurrentProgram, handleProgramClick, onPlayChannel, handleChannelRowFocus]);
```

(`handleChannelRowFocus` is defined in Task 5. If implementing tasks in order, add a temporary `const handleChannelRowFocus = () => {};` now and replace it in Task 5, or implement Task 5 Step 1–2 before this step.)

- [ ] **Step 6: Replace the render body** — swap the `ProgramGridContainer` block (the `<ProgramGridContainer ...> ... </ProgramGridContainer>`, ~lines 450–516) for the split-axis structure:

```javascript
					<div
						className={css.guideHorizontalScroller}
						ref={guideHorizontalRef}
						onScroll={handleHorizontalScroll}
					>
						<div
							className={css.guideWideSurface}
							style={{width: `${CHANNEL_COLUMN_WIDTH + HOURS_TO_DISPLAY * PIXELS_PER_HOUR}px`}}
						>
							{filteredChannels.length === 0 ? (
								<div className={css.empty}>
									{showFavoritesOnly ? $L('No favorite channels') : $L('No channels available')}
								</div>
							) : (
								<VirtualList
									className={css.channelVirtualList}
									dataSize={filteredChannels.length}
									itemSize={ROW_HEIGHT}
									itemRenderer={renderChannelRow}
									direction="vertical"
									spotlightId="program-grid"
									cbScrollTo={fn => { scrollToRef.current = fn; }}
								/>
							)}
						</div>
					</div>
```

- [ ] **Step 7: Clean up now-unused symbols** — `ProgramGridContainer` (the `SpotlightContainerDecorator` at ~line 15) is no longer used as a JSX wrapper (the row uses `ChannelRowContainer`); remove it if lint flags it unused. Remove the `VISIBLE_ROWS`/`OVERSCAN_ROWS` constants. Confirm `useMemo` is still used (yes: `timeSlots`, `filteredChannels`, `currentTimePosition`).

- [ ] **Step 8: Lint** — `cd packages/app && npm run lint` → PASS. Grep to confirm no dangling refs:

```bash
grep -nE "channelWindowStart|visibleChannels|topSpacerHeight|bottomSpacerHeight|VISIBLE_ROWS|OVERSCAN_ROWS" packages/app/src/views/LiveTV/LiveTV.js
```
Expected: no output.

- [ ] **Step 9: Visual smoke check (dev serve)** — `cd packages/app && npm run serve`, open in a desktop browser, go to Live TV. Confirm rows render inside the list and vertical scroll works (mouse). (This is a sanity check; the real test is on-TV in Task 8.) Stop the server after.

- [ ] **Step 10: Commit**

```bash
git add packages/app/src/views/LiveTV/LiveTV.js
git commit -m "fix(livetv): render guide via VirtualList (vertical) + horizontal scroller, drop manual windowing"
```

---

### Task 5: Focus-driven load-more + Spotlight IDs on program cells

**Files:** Modify `packages/app/src/views/LiveTV/LiveTV.js`.

**Interfaces:** Consumes `shouldLoadMore` (Task 1), `isLoadingMoreRef` (Task 2). Produces `handleChannelRowFocus`.

- [ ] **Step 1: Import the helper** — with the util imports:

```javascript
import {shouldLoadMore} from '../../utils/liveTvPaging';
```

- [ ] **Step 2: Add the focus handler** — near the other `useCallback`s (before `renderChannelRow`), replace any temporary stub with:

```javascript
	const handleChannelRowFocus = useCallback((index) => {
		if (shouldLoadMore({
			focusedIndex: index,
			loadedCount: filteredChannels.length,
			hasMore: hasMoreChannelsRef.current,
			isLoadingMore: isLoadingMoreRef.current
		})) {
			loadChannels();
		}
	}, [filteredChannels.length, loadChannels]);
```

(`renderChannelRow` from Task 4 already wires `onFocusCapture={() => handleChannelRowFocus(index)}` on the row and lists `handleChannelRowFocus` in its deps.)

- [ ] **Step 3: Add stable spotlightId to program cells** — in `ProgramCell` (the component at ~line 31), add a `spotlightId` to the `SpottableDiv` so recycled cells keep identity:

```javascript
		<SpottableDiv
			className={`${css.programCell} ${isCurrent ? css.current : ''}`}
			style={style}
			onClick={handleClick}
			onFocus={handleFocus}
			data-program-id={program.Id}
			spotlightId={`program-${channel.Id}-${program.Id}`}
		>
```

- [ ] **Step 4: Lint** — `cd packages/app && npm run lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/views/LiveTV/LiveTV.js
git commit -m "fix(livetv): load more on row focus proximity; stable program-cell spotlight IDs"
```

---

### Task 6: Channel-number quick-jump via VirtualList `scrollTo`

**Files:** Modify `packages/app/src/views/LiveTV/LiveTV.js` (`handleChannelNumber` ~159–183; constant ~24).

- [ ] **Step 1: Replace the scroll math with `scrollTo({index, focus})`** — inside `handleChannelNumber`, replace the `if (channelIndex >= 0) { ... }` block (the part that set `guideContent.scrollTop` and did the `setTimeout` focus) with:

```javascript
			if (channelIndex >= 0 && scrollToRef.current) {
				scrollToRef.current({index: channelIndex, animate: false, focus: true});
			}
```

(`scrollTo` with `focus: true` scrolls the `VirtualList` to that channel and focuses it — confirmed API in `@enact/sandstone` 2.9.13, `VirtualList.js:135–164`. No manual `querySelector`/`.focus()` needed.)

- [ ] **Step 2: Delete `CHANNEL_ROW_HEIGHT`** — remove `const CHANNEL_ROW_HEIGHT = 80;` (~line 24). Confirm no references remain:

```bash
grep -n CHANNEL_ROW_HEIGHT packages/app/src/views/LiveTV/LiveTV.js
```
Expected: no output.

- [ ] **Step 3: Lint + full test suite** — `cd packages/app && npm run lint && npm test` → PASS (existing util tests + `liveTvPaging`).

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/views/LiveTV/LiveTV.js
git commit -m "fix(livetv): channel-number jump via VirtualList scrollTo; drop CHANNEL_ROW_HEIGHT"
```

---

### Task 7: Resolve the two layout unknowns (sticky column + horizontal focus scroll)

`VirtualList` positions items with transforms, which can break `position: sticky` and can capture `scrollIntoView`. Verify and, if needed, apply the documented fallbacks. Do this on the dev serve first, then confirm on-device in Task 8.

**Files:** Possibly modify `packages/app/src/views/LiveTV/LiveTV.js` / `LiveTV.module.less`.

- [ ] **Step 1: Check the sticky channel column** — dev serve, Live TV, scroll horizontally. Expected: the 200px channel column stays pinned left while program cells scroll under the time header.
  - If sticky holds: no change.
  - If sticky breaks inside `VirtualList`: implement the fallback — render the channel column as a separate fixed-left overlay column (outside the horizontal scroller) driven by the same `filteredChannels`/`VirtualList` vertical position, OR keep the column non-sticky but ensure horizontal scroll starts at `left:0` so channel info is visible at rest. Prefer the overlay only if sticky truly fails; document what you did in the commit message.

- [ ] **Step 2: Check horizontal focus scrolling** — dev serve; d-pad/arrow to a program cell far to the right. Expected: `.guideHorizontalScroller` scrolls right to reveal it (the time header follows), and vertical position is unchanged.
  - If a focused cell instead scrolls the wrong axis or nothing, adjust `ProgramCell`'s `handleFocus` `scrollIntoView` options (currently `{behavior:'smooth', block:'nearest', inline:'nearest'}`) — e.g. drop `block` or set `behavior:'auto'` — so only the horizontal wrapper scrolls.

- [ ] **Step 3: Lint (if changed) + commit (if changed)**

```bash
git add packages/app/src/views/LiveTV/LiveTV.js packages/app/src/views/LiveTV/LiveTV.module.less
git commit -m "fix(livetv): keep sticky channel column and horizontal focus scroll working inside VirtualList"
```
(If no change was needed, skip the commit and note "sticky + horizontal focus verified, no change" when reporting the task.)

---

### Task 8: Build the `.wgt` and verify on-device via Apps2Samsung

The authoritative test. Deps are already installed (`npm install` done during planning).

**Files:** none (build + manual verification).

- [ ] **Step 1: Build (unsigned)** — repo root: `npm run build:tizen -- --skip-tizen-cli`. Expected: app bundles; the script attempts the zip fallback and reports it cannot find `zip`.

- [ ] **Step 2: Package the `.wgt`** — `zip` is absent, so archive the build output dir (`packages/build-tizen/dist`, into which the script already copied `config.xml`, `index.html`, `main.js`, resources, icons). In PowerShell:

```powershell
Set-Location packages\build-tizen\dist
Compress-Archive -Path * -DestinationPath ..\..\..\Moonfin_Tizen_Regular_2.6.0.wgt -Force
Set-Location ..\..\..
```

Verify the archive root (files at top level, NOT under `dist/`):

```powershell
Expand-Archive -Path Moonfin_Tizen_Regular_2.6.0.wgt -DestinationPath _wgtcheck -Force
Get-ChildItem _wgtcheck   # must list config.xml, index.html, main.js, resources, icons directly
Remove-Item _wgtcheck -Recurse -Force
```

(Alternative: put a `zip` binary on PATH — e.g. `winget install GnuWin32.Zip` or Git's `usr\bin\zip.exe` — and re-run Step 1; then this step is unnecessary. The `.wgt` filename is arbitrary for a custom Apps2Samsung install.)

- [ ] **Step 3: Install via Apps2Samsung** — open Apps2Samsung, Settings → custom `.wgt`, point it at `Moonfin_Tizen_Regular_2.6.0.wgt`, select your TV, install. Apps2Samsung handles the dev certificate/signing.

- [ ] **Step 4: Verify on the TV** — open Live TV and confirm ALL:
  - **The bug is fixed:** d-pad DOWN past the first page and continue well past 100 channels toward all ~560 — the guide **never goes blank**, rows keep rendering, focus is always retained (no dead-end, no jump-to-top).
  - Additional channel batches load as you approach the end; no duplicated/skipped channels.
  - Horizontal navigation across program cells scrolls smoothly; the time header stays in sync.
  - Channel-number quick-jump (type a number) scrolls to and focuses the correct channel, including a far index.
  - Focus returns correctly between guide controls and the grid (up/down interplay).
  - Favorites filter toggles without blanking and still loads more underlying channels.
  - **Perf:** scrolling through the full 560-channel lineup stays smooth.

- [ ] **Step 5: Diagnostics (only if something misbehaves)** — temporarily log focused index / `document.activeElement.isConnected`, and try `behavior:'auto'` for `scrollIntoView`; read via the Tizen Web Inspector. Remove before the final commit.

- [ ] **Step 6: Final housekeeping + push**

```bash
git status                 # ensure only intended files
git add -A                 # (final task: fine to add any leftover diagnostics removal)
git commit -m "chore(livetv): remove temporary EPG diagnostics" || echo "nothing to commit"
git push -u origin fix/livetv-epg-scroll
```

---

## Self-Review

**Spec coverage:**
- VirtualList (vertical) + horizontal wrapper split → Tasks 3, 4. ✅
- itemRenderer renders one row → Task 4 Step 5. ✅
- Stable Spotlight IDs (row/channel-info/program) → Task 4 Step 5 + Task 5 Step 3. ✅
- Load-more via focus proximity + append guard → Tasks 5, 2. ✅
- Channel-number jump via `cbScrollTo`/`scrollTo({index, focus})` → Task 6. ✅
- Time-header sync from horizontal wrapper → Task 4 Step 4. ✅
- Remove dead windowing → Task 4 Steps 2,3,7. ✅
- Layout unknowns (sticky, horizontal focus scroll) → Task 7. ✅
- `shouldLoadMore` unit seam → Task 1. ✅
- Build without Tizen Studio + Apps2Samsung → Task 8. ✅
- Perf at 560 channels → Task 8 Step 4. ✅

**Placeholder scan:** No TBD/TODO. The only forward reference is `handleChannelRowFocus` (Task 4 Step 5 uses it, Task 5 defines it) — called out explicitly with a stub instruction. Fix if implementing strictly in order by doing Task 5 Steps 1–2 before Task 4 Step 5.

**Type consistency:** `shouldLoadMore({focusedIndex, loadedCount, hasMore, isLoadingMore, threshold})` defined in Task 1, called with those keys in Task 5. `isLoadingMoreRef` (Task 2) read in Task 5. `scrollToRef` set in Task 4 Step 6, used in Task 6. `renderChannelRow`/`guideHorizontalRef`/`handleHorizontalScroll` all defined in Task 4. `ROW_HEIGHT`/`CHANNEL_COLUMN_WIDTH` defined in Task 4 Step 2, used in Task 4 Steps 6. ✅
