# Live TV EPG Blank-on-Scroll Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Live TV Program Guide (EPG) from going blank when scrolling past the first page on a Tizen TV, by removing the hand-rolled vertical windowing and rendering all loaded channels.

**Architecture:** The EPG (`packages/app/src/views/LiveTV/LiveTV.js`) currently mounts only a sliced window of channel rows and advances the window from the container's `onScroll`. On a d-pad TV, focus can only reach mounted rows and `onScroll` is unreliable during smooth focus scrolling, so past the first window the viewport shows an empty spacer. Fix: render **all currently loaded** channels (no vertical slice/spacers), keep the 50-per-batch paged API loading, and drive "load more" from row **focus proximity** (which always fires) with a scroll trigger as backup — guarded against concurrent appends.

**Tech Stack:** React (hooks) + Enact/Sandstone + Enact Spotlight; `@enact/cli` (`enact test` = jest, `enact lint`); Less modules. Jellyfin API via `packages/app/src/services/jellyfinApi.js`.

## Global Constraints

- **Only touch** `packages/app/src/views/LiveTV/LiveTV.js`, `packages/app/src/views/LiveTV/LiveTV.module.less` (if needed), and a new `packages/app/src/utils/liveTvPaging.js` (+ its test). Do **not** modify Recordings, playback/AVPlay, or other views.
- **No `VirtualList`/`VirtualGridList` migration** — explicitly out of scope.
- **Match existing file style:** tab indentation, single quotes, semicolons, `useCallback`/`useRef` patterns already in `LiveTV.js`.
- **Node 18+** (local v24 is within the `ilib >=8 <25` range and should build; if build tooling fails, use Node 20/22 LTS via nvm).
- **Build the `.wgt` without Tizen Studio:** `npm run build:tizen -- --skip-tizen-cli` (unsigned zip fallback). `zip` is **not** on this Windows PATH, so the fallback (`build-wgt.js:86`) will fail — supply a `zip` binary or run an explicit `Compress-Archive` substitute over the built output to emit a valid `.wgt`. Install via **Apps2Samsung** (handles dev-cert signing + push to TV).
- **Commit after every task.** Before each commit run `git status` and stage **only** the files that task touched (the tree may already be dirty from build artifacts/logs — never blind `git add -A` except the final housekeeping commit). Author: `Kevin Vogelgesang <kevin@enrollmentresources.com>`.

---

### Task 1: Extract and unit-test the `shouldLoadMore` helper

Pure decision logic for "should we fetch the next channel batch?", so it can be TDD'd in isolation. Lives beside the other LiveTV/list utils that already have colocated tests.

**Files:**
- Create: `packages/app/src/utils/liveTvPaging.js`
- Test: `packages/app/src/utils/liveTvPaging.test.js`

**Interfaces:**
- Produces: `shouldLoadMore({focusedIndex, loadedCount, hasMore, isLoadingMore, threshold})` → `boolean`. Returns `true` iff `hasMore && !isLoadingMore && focusedIndex >= loadedCount - threshold`. `threshold` defaults to `10`.

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/utils/liveTvPaging.test.js`:

```javascript
import {shouldLoadMore} from './liveTvPaging';

const base = {focusedIndex: 45, loadedCount: 50, hasMore: true, isLoadingMore: false};

describe('shouldLoadMore', () => {
	test('loads when focus is within threshold of the end', () => {
		expect(shouldLoadMore({...base, focusedIndex: 45})).toBe(true); // 45 >= 50 - 10
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

Note on the empty-list case: an empty mounted list must **not** trigger a load probe from `shouldLoadMore` (the initial load is owned by the mount effect, not this helper), so the implementation short-circuits when `loadedCount <= 0`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/app && npm test -- liveTvPaging`
Expected: FAIL — `Cannot find module './liveTvPaging'` (or `shouldLoadMore is not a function`).

- [ ] **Step 3: Write the minimal implementation**

Create `packages/app/src/utils/liveTvPaging.js`:

```javascript
/**
 * Decide whether to fetch the next batch of Live TV channels.
 *
 * @param {Object}  params
 * @param {number}  params.focusedIndex  Index of the currently focused channel row.
 * @param {number}  params.loadedCount   Number of channels currently loaded.
 * @param {boolean} params.hasMore       Whether the server has more channels.
 * @param {boolean} params.isLoadingMore Whether an append fetch is already in flight.
 * @param {number}  [params.threshold=10] How close to the end (in rows) triggers a load.
 * @returns {boolean}
 */
export const shouldLoadMore = ({focusedIndex, loadedCount, hasMore, isLoadingMore, threshold = 10}) => {
	if (!hasMore || isLoadingMore) return false;
	if (loadedCount <= 0) return false;
	return focusedIndex >= loadedCount - threshold;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/app && npm test -- liveTvPaging`
Expected: PASS — all 7 assertions green.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/utils/liveTvPaging.js packages/app/src/utils/liveTvPaging.test.js
git commit -m "feat(livetv): add shouldLoadMore paging helper with tests"
```

---

### Task 2: Add an append in-flight guard inside `loadChannels`

`isLoading` only wraps the initial/date-reset load, so nothing prevents two concurrent append fetches (once we add a focus trigger alongside the scroll trigger) from reading the same `currentChannelIndexRef.current` and double-appending/skipping a batch. Add a dedicated ref guard.

**Files:**
- Modify: `packages/app/src/views/LiveTV/LiveTV.js` (the `loadChannels` callback, ~lines 81, 103–148)

**Interfaces:**
- Produces: `isLoadingMoreRef` (a `useRef(false)`) readable by later tasks for the focus-proximity trigger.

- [ ] **Step 1: Add the ref**

Next to the other refs (after `const hasMoreChannelsRef = useRef(true);`, ~line 81), add:

```javascript
	const isLoadingMoreRef = useRef(false);
```

- [ ] **Step 2: Guard the append path in `loadChannels`**

Replace the top of `loadChannels` (the `if (reset) {...}` block through the `if (!hasMoreChannelsRef.current) return;` line, ~lines 103–111) with. Note the guard is set **only for append calls** (`isAppend`), so a `reset` load never touches the append guard:

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

- [ ] **Step 3: Clear the guard in a `finally` (append calls only)**

The existing body ends with a `try { ... } catch (err) { console.error('Failed to load channels:', err); }` (~lines 113–147). Add a `finally` that clears the guard **only when it was an append**, so a concurrent `reset` cannot wipe an append's in-flight flag:

```javascript
		} catch (err) {
			console.error('Failed to load channels:', err);
		} finally {
			if (isAppend) isLoadingMoreRef.current = false;
		}
	}, [api, getGuideStartTime, getGuideEndTime]);
```

> Optional hardening (not required for a personal build): add a monotonically-increasing "generation" ref bumped on every `reset`, capture it at the top of an append, and discard the append's results if the generation changed before it resolved — prevents a slow append from appending stale channels after a day/filter switch.

- [ ] **Step 4: Lint**

Run: `cd packages/app && npm run lint`
Expected: PASS (no new errors in `LiveTV.js`).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/views/LiveTV/LiveTV.js
git commit -m "fix(livetv): guard against concurrent channel append fetches"
```

---

### Task 3: Remove vertical windowing — render all loaded channels

This is the core fix. Delete the manual slice/spacer machinery and render every loaded (filtered) channel, so no row region is ever unmounted/blank and Spotlight can always reach the next row.

**Files:**
- Modify: `packages/app/src/views/LiveTV/LiveTV.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: renders `filteredChannels` directly; `visibleChannels`, `channelWindowStart`, spacers, and the windowing constants no longer exist.

- [ ] **Step 1: Delete windowing constants**

Remove these two constants (~lines 25–26). **Keep** `HOURS_TO_DISPLAY`, `PIXELS_PER_HOUR`, `MINUTES_PER_PIXEL`, `CHANNELS_PER_BATCH`, `GUIDE_CONTROL_IDS`:

```javascript
// DELETE these lines:
const OVERSCAN_ROWS = 6;
const VISIBLE_ROWS = 16;
```

- [ ] **Step 2: Delete window state and ref**

Remove (~lines 68–69):

```javascript
// DELETE:
	const [channelWindowStart, setChannelWindowStart] = useState(0);
	const channelWindowStartRef = useRef(0);
```

- [ ] **Step 3: Remove the window-advance block from `handleScroll`**

In `handleScroll`, delete the block that computes `firstVisibleIndex`/`nextWindowStart` and calls `setChannelWindowStart` (~lines 239–244). **Keep** the load-more scroll trigger (the `scrollPosition >= scrollHeight - 500 ...` block) and the time-header sync (`timeSlotsRef.current.scrollLeft = ...`). After editing, `handleScroll` reads:

```javascript
	const handleScroll = useCallback(() => {
		const guideContent = guideContentRef.current;
		if (!guideContent) return;

		const scrollPosition = guideContent.scrollTop + guideContent.clientHeight;
		const scrollHeight = guideContent.scrollHeight;

		if (scrollPosition >= scrollHeight - 500 && hasMoreChannelsRef.current && !isLoading) {
			loadChannels();
		}

		if (timeSlotsRef.current) {
			timeSlotsRef.current.scrollLeft = guideContent.scrollLeft;
		}
	}, [loadChannels, isLoading]);
```

- [ ] **Step 4: Delete the window-reset effect**

Remove the effect that reset the window when the filtered list shrank (~lines 323–329):

```javascript
// DELETE the entire useEffect that begins:
//   if (channelWindowStartRef.current >= filteredChannels.length) { ... }
```

- [ ] **Step 5: Delete the slice/spacer computation**

Remove (~lines 331–337):

```javascript
// DELETE:
	const windowEnd = Math.min(filteredChannels.length, channelWindowStart + VISIBLE_ROWS + OVERSCAN_ROWS * 2);
	const visibleChannels = useMemo(
		() => filteredChannels.slice(channelWindowStart, windowEnd),
		[filteredChannels, channelWindowStart, windowEnd]
	);
	const topSpacerHeight = channelWindowStart * CHANNEL_ROW_HEIGHT;
	const bottomSpacerHeight = Math.max(0, (filteredChannels.length - windowEnd) * CHANNEL_ROW_HEIGHT);
```

- [ ] **Step 6: Render all filtered channels and drop the spacer divs**

In the `ProgramGridContainer` (~lines 450–516): remove the top spacer div (`{topSpacerHeight > 0 && ...}`) and bottom spacer div (`{bottomSpacerHeight > 0 && ...}`), and change the map source from `visibleChannels` to `filteredChannels`. The opening of the mapped list becomes:

```javascript
					<ProgramGridContainer
						className={css.guideContent}
						ref={guideContentRef}
						onScroll={handleScroll}
						spotlightId="program-grid"
					>
						{filteredChannels.map(channel => (
							<ChannelRowContainer
								key={channel.Id}
								className={css.channelRow}
								data-channel-id={channel.Id}
								spotlightId={`ch-row-${channel.Id}`}
							>
```

…and the end of the list (after the row `.map(...)` closes) drops the bottom spacer, keeping only the empty-state:

```javascript
						))}

						{filteredChannels.length === 0 && (
							<div className={css.empty}>
								{showFavoritesOnly ? $L('No favorite channels') : $L('No channels available')}
							</div>
						)}
					</ProgramGridContainer>
```

- [ ] **Step 7: Remove the now-unused `useMemo` import if orphaned**

Check whether `useMemo` is still used (it still is — `timeSlots`, `filteredChannels`, `currentTimePosition`). Leave the import as-is. Only remove imports that lint flags as unused.

- [ ] **Step 8: Lint**

Run: `cd packages/app && npm run lint`
Expected: PASS. If lint flags an unused variable (e.g. `useState` if no longer used — it is still used for other state, so it should stay), remove only what it flags.

- [ ] **Step 9: Commit**

```bash
git add packages/app/src/views/LiveTV/LiveTV.js
git commit -m "fix(livetv): render all loaded channels, remove blank-inducing row windowing"
```

---

### Task 4: Drive "load more" from row focus proximity

With windowing gone, appending still happens on scroll — but `onScroll` is unreliable on Tizen. Add a focus-driven trigger: whenever any element in a channel row gains focus, if that row is near the end of the loaded list, fetch the next batch. React focus bubbles from the channel-info element and descendant program cells, so a single `onFocusCapture` on the row container covers both.

**Files:**
- Modify: `packages/app/src/views/LiveTV/LiveTV.js`

**Interfaces:**
- Consumes: `shouldLoadMore` (Task 1), `isLoadingMoreRef` (Task 2), `loadChannels`, `filteredChannels`, `hasMoreChannelsRef`.

- [ ] **Step 1: Import the helper**

With the other util imports (near `import {KEYS} from '../../utils/keys';`, ~line 8) add:

```javascript
import {shouldLoadMore} from '../../utils/liveTvPaging';
```

- [ ] **Step 2: Add the row-focus handler**

Near the other `useCallback` handlers (e.g. after `handleScroll`), add:

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

- [ ] **Step 3: Wire it to each row with the row index**

Change the map from Task 3 to include the index and add `onFocusCapture`:

```javascript
						{filteredChannels.map((channel, index) => (
							<ChannelRowContainer
								key={channel.Id}
								className={css.channelRow}
								data-channel-id={channel.Id}
								spotlightId={`ch-row-${channel.Id}`}
								onFocusCapture={() => handleChannelRowFocus(index)} // eslint-disable-line react/jsx-no-bind
							>
```

- [ ] **Step 4: Lint**

Run: `cd packages/app && npm run lint`
Expected: PASS. (The `eslint-disable-line react/jsx-no-bind` mirrors the existing pattern already used on `onClick` in this file at the `channelInfo` element.)

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/views/LiveTV/LiveTV.js
git commit -m "fix(livetv): load more channels on row focus proximity (Tizen scroll-event backup)"
```

---

### Task 5: Make the channel-number quick-jump height-independent

`handleChannelNumber` scrolls using `channelIndex * CHANNEL_ROW_HEIGHT`, but `.channelRow` is `80px` **plus** a `1px` border (`content-box`), so the math drifts. Since all rows are now mounted, query the target row element and use its real `offsetTop`. Then delete `CHANNEL_ROW_HEIGHT`.

**Files:**
- Modify: `packages/app/src/views/LiveTV/LiveTV.js` (`handleChannelNumber`, ~lines 159–183; constant at ~line 24)

- [ ] **Step 1: Replace the scroll math with `offsetTop`**

In `handleChannelNumber`, replace the block that sets `guideContent.scrollTop` (~lines 169–179) with a lookup of the actual row element (which now always exists because every channel is rendered):

```javascript
			if (channelIndex >= 0) {
				const channel = filteredChannelsRef.current[channelIndex];
				const guideContent = guideContentRef.current;
				const row = document.querySelector(`.${css.channelRow}[data-channel-id="${channel.Id}"]`);
				if (guideContent && row) {
					guideContent.scrollTop = Math.max(0, row.offsetTop - guideContent.clientHeight / 2);
				}
				setTimeout(() => {
					const spottable = row && row.querySelector('[tabindex]');
					if (spottable) spottable.focus();
				}, 100);
			}
```

(Both the `ChannelRowContainer` **and** the inner `channelInfo` carry `data-channel-id`. Qualifying the selector with `.${css.channelRow}` guarantees we match the row container — whose `offsetTop` relative to the `position: relative` `.guideContent` is what we scroll to — not the inner element.)

- [ ] **Step 2: Delete the `CHANNEL_ROW_HEIGHT` constant**

Remove (~line 24):

```javascript
// DELETE:
const CHANNEL_ROW_HEIGHT = 80;
```

- [ ] **Step 3: Lint**

Run: `cd packages/app && npm run lint`
Expected: PASS, and no remaining references to `CHANNEL_ROW_HEIGHT` (grep to confirm: `grep -n CHANNEL_ROW_HEIGHT packages/app/src/views/LiveTV/LiveTV.js` → no output).

- [ ] **Step 4: Run the full app test suite (nothing should regress)**

Run: `cd packages/app && npm test`
Expected: PASS (existing util tests + the new `liveTvPaging` tests).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/views/LiveTV/LiveTV.js
git commit -m "fix(livetv): jump to channel by measured offsetTop; drop CHANNEL_ROW_HEIGHT"
```

---

### Task 6: Build the `.wgt` and verify on-device via Apps2Samsung

The only authoritative test for this bug is on the TV. Build an unsigned `.wgt` and install it with Apps2Samsung, then confirm the guide behaves.

**Files:** none (build + manual verification).

- [ ] **Step 1: Install dependencies**

Run (repo root): `npm install`
Expected: completes without fatal errors. If build tooling errors on Node v24, switch to Node 20/22 LTS (nvm) and re-run.

- [ ] **Step 2: Build the Tizen package (unsigned)**

Run (repo root): `npm run build:tizen -- --skip-tizen-cli`
Expected: app bundles and the script attempts the zip fallback.

- [ ] **Step 3: Handle the missing `zip` binary**

`zip` is not on this Windows PATH, so Step 2's fallback (`packages/build-tizen/scripts/build-wgt.js:86`) will report failure to create the `.wgt`. Produce the `.wgt` from the built output directory instead. The script zips the **`DIST` directory** = `packages/build-tizen/dist` (`build-wgt.js:23`, via `zipDirToFile(DIST, finalWgt)` at `:463`), into which it has already copied `config.xml` (`:380`), `index.html`, `main.js`, resources, and icons. So archive the **contents** of that dir (not the folder itself). From repo root in PowerShell:

```powershell
Set-Location packages\build-tizen\dist
Compress-Archive -Path * -DestinationPath ..\..\..\Moonfin_Tizen_Regular_2.6.0.wgt -Force
Set-Location ..\..\..
```

Then confirm the archive root is correct (files at top level, **not** nested under `dist/`):

```powershell
Expand-Archive -Path Moonfin_Tizen_Regular_2.6.0.wgt -DestinationPath _wgtcheck -Force
Get-ChildItem _wgtcheck   # must list config.xml, index.html, main.js, resources, icons directly
Remove-Item _wgtcheck -Recurse -Force
```

A plain zip is exactly what the script's own fallback produces, and Apps2Samsung handles signing; no special `mimetype`/signature file is needed on this path. (Alternative: install a `zip` binary — e.g. `winget install GnuWin32.Zip`, or use Git's bundled `usr\bin\zip.exe` — put it on PATH and re-run Step 2; then this manual step is unnecessary.)

- [ ] **Step 4: Install via Apps2Samsung**

Open Apps2Samsung, point it at the `.wgt` produced in Step 3 (Settings → custom `.wgt`), select your TV, and install. Apps2Samsung handles the developer certificate/signing.

- [ ] **Step 5: Verify the fix on the TV**

On the TV, open **Live TV** and confirm all of:
- Scroll (d-pad DOWN) well past the first ~28 channels — rows keep rendering, **no blank area**.
- Focus is retained after each new batch loads (no dead-end, no focus jump to top).
- Continued scrolling loads further batches; no duplicated or skipped channels.
- Toggle **Favorites** near the end of the list — filter still works and can still load more underlying channels.
- Channel-number quick-jump (type a channel number) scrolls to and focuses the correct channel.
- The time-header stays horizontally synced when scrolling the grid sideways.

- [ ] **Step 6 (optional diagnostic, only if the blank persists):** temporarily add `console.log` of `scrollTop`, focused channel id/index, and `document.activeElement.isConnected` in `handleChannelRowFocus`/`handleScroll`; and set `ProgramCell`'s `scrollIntoView` `behavior` to `'auto'`. Read logs via the Tizen Web Inspector. Remove diagnostics before the final commit.

- [ ] **Step 7: Final housekeeping**

If any diagnostics were added in Step 6, remove them and commit:

```bash
git add -A
git commit -m "chore(livetv): remove temporary EPG scroll diagnostics"
```

Push the branch to your fork:

```bash
git push -u origin fix/livetv-epg-scroll
```

---

## Self-Review

**Spec coverage:**
- Remove vertical windowing / render all loaded channels → Task 3. ✅
- Decouple load-more from onScroll (focus proximity) → Task 4. ✅
- Append in-flight guard (`isLoadingMoreRef`) → Task 2. ✅
- Row-height fix via `offsetTop`, drop `CHANNEL_ROW_HEIGHT` → Task 5. ✅
- Keep time-header horizontal sync → Task 3 Step 3 (retained). ✅
- Optional `shouldLoadMore` unit seam → Task 1. ✅
- Diagnostic step before finalizing → Task 6 Step 6. ✅
- Build without Tizen Studio (skip-tizen-cli + Compress-Archive) + Apps2Samsung install → Task 6. ✅
- Perf check at 50/100/200+ channels → Task 6 Step 5 (scroll past first page repeatedly). Add explicit note: if scrolling is janky at high counts, that is the signal to reconsider `VirtualList` (out of scope here).

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows concrete code. ✅

**Type consistency:** `shouldLoadMore({focusedIndex, loadedCount, hasMore, isLoadingMore, threshold})` is defined in Task 1 and called with exactly those keys in Task 4. `isLoadingMoreRef` defined in Task 2, read in Task 4. ✅
