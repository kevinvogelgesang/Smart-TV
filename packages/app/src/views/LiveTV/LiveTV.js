import {useState, useEffect, useCallback, useRef, useMemo} from 'react';
import Spottable from '@enact/spotlight/Spottable';
import SpotlightContainerDecorator from '@enact/spotlight/SpotlightContainerDecorator';
import Spotlight from '@enact/spotlight';
import VirtualList from '@enact/sandstone/VirtualList';
import Scroller from '@enact/sandstone/Scroller';
import $L from '@enact/i18n/$L';
import {useAuth} from '../../context/AuthContext';
import LoadingSpinner from '../../components/LoadingSpinner';
import {KEYS} from '../../utils/keys';
import {shouldLoadMore} from '../../utils/liveTvPaging';

import css from './LiveTV.module.less';

const SpottableDiv = Spottable('div');
const SpottableButton = Spottable('button');
const GuideControls = SpotlightContainerDecorator({enterTo: 'last-focused', restrict: 'self-first'}, 'div');
const ChannelRowContainer = SpotlightContainerDecorator({enterTo: 'last-focused'}, 'div');
const PopupContainer = SpotlightContainerDecorator({
	enterTo: 'default-element',
	preserveId: true
}, 'div');

const HOURS_TO_DISPLAY = 6;
const PIXELS_PER_HOUR = 600;
const CHANNEL_COLUMN_WIDTH = 200; // matches @channel-column-width in the .less
const ROW_HEIGHT = 80;            // matches @row-height (raw px, not ri.scale)
const MINUTES_PER_PIXEL = 60 / PIXELS_PER_HOUR;
const CHANNELS_PER_BATCH = 50;
const GUIDE_CONTROL_IDS = ['prev-day', 'next-day', 'today', 'filter', 'recordings'];
const FOCUSED_ROW_BOTTOM_LEAD = ROW_HEIGHT + 48; // one row + affordance

const guideCache = {
	channels: null,
	programs: null,
	currentChannelIndex: 0,
	hasMoreChannels: true,
	showFavoritesOnly: false,
	currentDateISO: null,
	lastFocusedChannelId: null,
	lastFocusedIndex: 0,
	horizontalScrollLeft: 0
};

const ProgramCell = ({program, channel, style, isCurrent, onProgramClick, onProgramFocus, dataIndex}) => {
	const handleClick = useCallback(() => {
		onProgramClick(program, channel);
	}, [program, channel, onProgramClick]);

	const handleFocus = useCallback(() => {
		onProgramFocus(parseFloat(style.left) || 0);
	}, [onProgramFocus, style.left]);

	return (
		<SpottableDiv
			className={`${css.programCell} ${isCurrent ? css.current : ''}`}
			style={style}
			onClick={handleClick}
			onFocus={handleFocus}
			data-program-id={program.Id}
			data-index={dataIndex}
			spotlightId={`program-${channel.Id}-${program.Id}`}
		>
			<div className={css.programTime}>
				{new Date(program.StartDate).toLocaleTimeString(undefined, {
					hour: 'numeric',
					minute: '2-digit',
					hour12: true
				})}
			</div>
			<div className={css.programTitle}>{program.Name}</div>
			{program.EpisodeTitle && (
				<div className={css.programEpisode}>{program.EpisodeTitle}</div>
			)}
		</SpottableDiv>
	);
};

const LiveTV = ({onPlayChannel, onRecordings, backHandlerRef}) => {
	const {api, serverUrl} = useAuth();
	const [channels, setChannels] = useState(() => guideCache.channels || []);
	const [programs, setPrograms] = useState(() => guideCache.programs || {});
	const filteredChannelsRef = useRef([]);
	const [currentDate, setCurrentDate] = useState(() => (guideCache.currentDateISO ? new Date(guideCache.currentDateISO) : new Date()));
	const [isLoading, setIsLoading] = useState(() => !(guideCache.channels && guideCache.channels.length));
	const [showFavoritesOnly, setShowFavoritesOnly] = useState(() => guideCache.showFavoritesOnly);
	const [selectedProgram, setSelectedProgram] = useState(null);
	const [channelNumberBuffer, setChannelNumberBuffer] = useState('');

	const scrollToRef = useRef(null);
	const timeSlotsRef = useRef(null);
	const channelNumberTimeoutRef = useRef(null);
	const currentChannelIndexRef = useRef(guideCache.currentChannelIndex || 0);
	const hasMoreChannelsRef = useRef(guideCache.hasMoreChannels !== false);
	const isLoadingMoreRef = useRef(false);
	const horizScrollToRef = useRef(null);
	const horizontalScrollLeftRef = useRef(guideCache.horizontalScrollLeft || 0);
	const didRestoreRef = useRef(false);
	const latestStateRef = useRef(null);

	const getGuideStartTime = useCallback(() => {
		const start = new Date(currentDate);
		const currentHour = new Date().getHours();
		start.setHours(currentHour, 0, 0, 0);
		return start;
	}, [currentDate]);

	const getGuideEndTime = useCallback(() => {
		const end = new Date(getGuideStartTime());
		end.setHours(end.getHours() + HOURS_TO_DISPLAY);
		return end;
	}, [getGuideStartTime]);

	const getCurrentTimePosition = useCallback(() => {
		const startTime = getGuideStartTime();
		const now = new Date();
		const minutesSinceStart = (now - startTime) / (1000 * 60);
		return minutesSinceStart / MINUTES_PER_PIXEL;
	}, [getGuideStartTime]);

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

		try {
			const result = await api.getLiveTvChannels(currentChannelIndexRef.current, CHANNELS_PER_BATCH);
			const newChannels = result.Items || [];

			if (newChannels.length === 0) {
				hasMoreChannelsRef.current = false;
				return;
			}

			const startTime = getGuideStartTime();
			const endTime = getGuideEndTime();
			const channelIds = newChannels.map(ch => ch.Id);

			const programsResult = await api.getLiveTvPrograms(channelIds, startTime, endTime);
			const allPrograms = programsResult.Items || [];

			const programsByChannel = {};
			allPrograms.forEach(program => {
				const channelId = program.ChannelId;
				if (!programsByChannel[channelId]) {
					programsByChannel[channelId] = [];
				}
				programsByChannel[channelId].push(program);
			});

			setChannels(prev => reset ? newChannels : [...prev, ...newChannels]);
			setPrograms(prev => ({...prev, ...programsByChannel}));

			currentChannelIndexRef.current += newChannels.length;
			if (newChannels.length < CHANNELS_PER_BATCH) {
				hasMoreChannelsRef.current = false;
			}
		} catch (err) {
			console.error('Failed to load channels:', err);
		} finally {
			if (isAppend) isLoadingMoreRef.current = false;
		}
	}, [api, getGuideStartTime, getGuideEndTime]);

	const isFirstLoadEffectRef = useRef(true);

	useEffect(() => {
		if (isFirstLoadEffectRef.current) {
			isFirstLoadEffectRef.current = false;
			if (guideCache.channels && guideCache.channels.length) {
				return;
			}
		}

		const init = async () => {
			setIsLoading(true);
			await loadChannels(true);
			setIsLoading(false);
		};
		init();
	}, [loadChannels, currentDate]);

	const handleChannelNumber = useCallback((digit) => {
		if (channelNumberTimeoutRef.current) {
			clearTimeout(channelNumberTimeoutRef.current);
		}

		setChannelNumberBuffer(prev => prev + digit);

		channelNumberTimeoutRef.current = setTimeout(() => {
			const channelNum = channelNumberBuffer + digit;
			const channelIndex = filteredChannelsRef.current.findIndex(ch => ch.ChannelNumber === channelNum);
			if (channelIndex >= 0 && scrollToRef.current) {
				const target = filteredChannelsRef.current[channelIndex];
				scrollToRef.current({index: channelIndex, animate: false});

				let attempts = 0;
				const focusChannel = () => {
					if (Spotlight.focus(`ch-info-${target.Id}`)) return;
					if (attempts++ < 5) setTimeout(focusChannel, 50);
				};
				setTimeout(focusChannel, 0);
			}
			setChannelNumberBuffer('');
		}, 1500);
	}, [channelNumberBuffer]);

	useEffect(() => {
		if (!backHandlerRef) return;
		backHandlerRef.current = () => {
			if (selectedProgram) {
				setSelectedProgram(null);
				return true;
			}
			return false;
		};
		return () => { if (backHandlerRef) backHandlerRef.current = null; };
	}, [backHandlerRef, selectedProgram]);

	useEffect(() => {
		const handleKeyDown = (e) => {
			const keyCode = e.keyCode;

			if (selectedProgram) return;

			if (keyCode >= KEYS.NUM_0 && keyCode <= KEYS.NUM_9) {
				e.preventDefault();
				handleChannelNumber(String.fromCharCode(keyCode));
				return;
			}

			const focused = Spotlight.getCurrent();
			const focusedId = focused?.id || '';

			if (keyCode === KEYS.UP && GUIDE_CONTROL_IDS.includes(focusedId)) {
				e.preventDefault();
				Spotlight.focus('navbar');
				return;
			}

			if (keyCode === KEYS.DOWN && GUIDE_CONTROL_IDS.includes(focusedId)) {
				e.preventDefault();
				Spotlight.focus('program-grid');
			}
		};

		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [selectedProgram, handleChannelNumber]);

	const handleHorizontalScroll = useCallback(({scrollLeft = 0}) => {
		horizontalScrollLeftRef.current = scrollLeft;
		if (timeSlotsRef.current) {
			timeSlotsRef.current.scrollLeft = scrollLeft;
		}
	}, []);

	const handleChannelInfoFocus = useCallback(() => {
		horizScrollToRef.current?.({position: {x: 0}, animate: false});
	}, []);

	const handleProgramFocus = useCallback((leftPx) => {
		const x = Math.max(0, leftPx - 24);
		horizScrollToRef.current?.({position: {x}, animate: false});
	}, []);

	const invalidateGuideCache = useCallback(() => {
		guideCache.channels = null;
		guideCache.programs = null;
		guideCache.currentChannelIndex = 0;
		guideCache.hasMoreChannels = true;
		guideCache.lastFocusedChannelId = null;
		guideCache.lastFocusedIndex = 0;
		guideCache.horizontalScrollLeft = 0;
		didRestoreRef.current = true;
	}, []);

	const changeDay = useCallback((days) => {
		invalidateGuideCache();
		setCurrentDate(prev => {
			const newDate = new Date(prev);
			newDate.setDate(newDate.getDate() + days);
			return newDate;
		});
	}, [invalidateGuideCache]);

	const goToToday = useCallback(() => {
		invalidateGuideCache();
		setCurrentDate(new Date());
	}, [invalidateGuideCache]);

	const toggleFavorites = useCallback(() => {
		setShowFavoritesOnly(prev => !prev);
	}, []);

	const handleProgramClick = useCallback((program, channel) => {
		setSelectedProgram({program, channel});
		setTimeout(() => {
			Spotlight.focus('livetv-popup');
		}, 100);
	}, []);

	const handleWatchChannel = useCallback(() => {
		if (selectedProgram?.channel) {
			onPlayChannel?.(selectedProgram.channel);
		}
	}, [selectedProgram, onPlayChannel]);

	const handlePrevDay = useCallback(() => {
		changeDay(-1);
	}, [changeDay]);

	const handleNextDay = useCallback(() => {
		changeDay(1);
	}, [changeDay]);

	const handleClosePopup = useCallback(() => {
		setSelectedProgram(null);
	}, []);

	const formatDate = useCallback((date) => {
		const options = {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'};
		return date.toLocaleDateString(undefined, options);
	}, []);

	const timeSlots = useMemo(() => {
		const slots = [];
		const startTime = getGuideStartTime();
		const totalSlots = HOURS_TO_DISPLAY * 2;

		for (let i = 0; i < totalSlots; i++) {
			const slotTime = new Date(startTime);
			slotTime.setMinutes(slotTime.getMinutes() + (i * 30));
			slots.push({
				time: slotTime,
				label: slotTime.toLocaleTimeString(undefined, {
					hour: 'numeric',
					minute: '2-digit',
					hour12: true
				})
			});
		}
		return slots;
	}, [getGuideStartTime]);

	const filteredChannels = useMemo(() => {
		if (!showFavoritesOnly) return channels;
		return channels.filter(ch => ch.UserData?.IsFavorite);
	}, [channels, showFavoritesOnly]);
	filteredChannelsRef.current = filteredChannels;

	latestStateRef.current = {
		channels,
		programs,
		showFavoritesOnly,
		currentDate
	};

	const calculateProgramStyle = useCallback((program) => {
		const startTime = getGuideStartTime();
		const guideEndTime = getGuideEndTime();
		const programStart = new Date(program.StartDate);
		const programEnd = new Date(program.EndDate);

		if (programEnd <= startTime || programStart >= guideEndTime) return null;

		const minutesFromStart = (programStart - startTime) / (1000 * 60);
		const durationMinutes = (programEnd - programStart) / (1000 * 60);

		let left = minutesFromStart / MINUTES_PER_PIXEL;
		let width = durationMinutes / MINUTES_PER_PIXEL;

		if (left < 0) {
			width = width + left;
			left = 0;
		}

		if (width < 10) return null;

		return {
			left: `${left}px`,
			width: `${width - 6}px`
		};
	}, [getGuideStartTime, getGuideEndTime]);

	const isCurrentProgram = useCallback((program) => {
		const now = new Date();
		const start = new Date(program.StartDate);
		const end = new Date(program.EndDate);
		return now >= start && now < end;
	}, []);

	const currentTimePosition = useMemo(() => {
		const pos = getCurrentTimePosition();
		return pos >= 0 && pos <= HOURS_TO_DISPLAY * PIXELS_PER_HOUR ? pos : null;
	}, [getCurrentTimePosition]);

	const nudgeFocusedRowIntoView = useCallback((index, rowNode) => {
		if (!scrollToRef.current || !rowNode) return;
		const listNode = rowNode.closest(`.${css.channelVirtualList}`);
		if (!listNode) return;
		const rowRect = rowNode.getBoundingClientRect();
		const listRect = listNode.getBoundingClientRect();
		if (rowRect.bottom > listRect.bottom - FOCUSED_ROW_BOTTOM_LEAD) {
			scrollToRef.current({index, stickTo: 'end', offset: FOCUSED_ROW_BOTTOM_LEAD, disallowNegativeOffset: true, animate: false});
		}
	}, []);

	const handleChannelRowFocus = useCallback((index, e) => {
		guideCache.lastFocusedIndex = index;
		guideCache.lastFocusedChannelId = filteredChannels[index]?.Id || null;

		if (shouldLoadMore({
			focusedIndex: index,
			loadedCount: filteredChannels.length,
			hasMore: hasMoreChannelsRef.current,
			isLoadingMore: isLoadingMoreRef.current
		})) {
			loadChannels();
		}

		const rowNode = e?.currentTarget;
		window.requestAnimationFrame(() => nudgeFocusedRowIntoView(index, rowNode));
	}, [filteredChannels, loadChannels, nudgeFocusedRowIntoView]);

	const renderChannelRow = useCallback(({index, ...rest}) => {
		const channel = filteredChannels[index];
		if (!channel) return null;

		return (
			<ChannelRowContainer
				{...rest}
				className={css.channelRow}
				data-channel-id={channel.Id}
				spotlightId={`ch-row-${channel.Id}`}
				onFocusCapture={(e) => handleChannelRowFocus(index, e)} // eslint-disable-line react/jsx-no-bind
			>
				<SpottableDiv
					className={css.channelInfo}
					onClick={() => onPlayChannel?.(channel)} // eslint-disable-line react/jsx-no-bind
					onFocus={handleChannelInfoFocus}
					data-channel-id={channel.Id}
					data-index={rest['data-index']}
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
								onProgramFocus={handleProgramFocus}
								dataIndex={rest['data-index']}
							/>
						);
					})}
				</div>
			</ChannelRowContainer>
		);
	}, [filteredChannels, programs, serverUrl, currentTimePosition, calculateProgramStyle, isCurrentProgram, handleProgramClick, onPlayChannel, handleChannelRowFocus, handleChannelInfoFocus, handleProgramFocus]);

	useEffect(() => {
		return () => {
			const latest = latestStateRef.current;
			if (!latest) return;

			guideCache.channels = latest.channels;
			guideCache.programs = latest.programs;
			guideCache.currentChannelIndex = currentChannelIndexRef.current;
			guideCache.hasMoreChannels = hasMoreChannelsRef.current;
			guideCache.showFavoritesOnly = latest.showFavoritesOnly;
			guideCache.currentDateISO = latest.currentDate.toISOString();
			guideCache.horizontalScrollLeft = horizontalScrollLeftRef.current;
		};
	}, []);

	useEffect(() => {
		if (didRestoreRef.current || !(guideCache.channels && guideCache.channels.length) || !scrollToRef.current || filteredChannels.length === 0) return;

		const cachedIndex = filteredChannels.findIndex(ch => ch.Id === guideCache.lastFocusedChannelId);
		const targetIndex = cachedIndex >= 0 ? cachedIndex : Math.min(guideCache.lastFocusedIndex || 0, filteredChannels.length - 1);
		const target = filteredChannels[targetIndex];

		scrollToRef.current({index: targetIndex, animate: false});
		horizScrollToRef.current?.({position: {x: guideCache.horizontalScrollLeft || 0}, animate: false});

		setTimeout(() => {
			if (target) Spotlight.focus(`ch-info-${target.Id}`);
		}, 50);

		didRestoreRef.current = true;
	}, [filteredChannels]);

	if (isLoading && channels.length === 0) {
		return (
			<div className={css.page}>
				<div className={css.loadingContainer}>
					<LoadingSpinner />
					<p>{$L('Loading TV Guide...')}</p>
				</div>
			</div>
		);
	}

	return (
		<div className={css.page}>
			<div className={css.guideContainer}>
				<div className={css.guideHeader}>
					<div className={css.guideTitle}>{$L('Live TV Guide')}</div>
					<GuideControls className={css.guideControls} spotlightId="livetv-guide">
						<SpottableButton
							className={css.guideBtn}
							onClick={handlePrevDay}
							spotlightId="prev-day"
						>
							{$L('◀ Previous Day')}
						</SpottableButton>
						<div className={css.guideDate}>{formatDate(currentDate)}</div>
						<SpottableButton
							className={css.guideBtn}
							onClick={handleNextDay}
							spotlightId="next-day"
						>
							{$L('Next Day ▶')}
						</SpottableButton>
						<SpottableButton
							className={css.guideBtn}
							onClick={goToToday}
							spotlightId="today"
						>
							{$L('Today')}
						</SpottableButton>
						<SpottableButton
							className={`${css.guideBtn} ${showFavoritesOnly ? css.active : ''}`}
							onClick={toggleFavorites}
							spotlightId="filter"
						>
							{showFavoritesOnly ? $L('All Channels') : $L('Favorites')}
						</SpottableButton>
						<SpottableButton
							className={`${css.guideBtn} ${css.recordingsBtn}`}
							onClick={onRecordings}
							spotlightId="recordings"
						>
							{$L('Recordings')}
						</SpottableButton>
					</GuideControls>
				</div>

				<div className={css.guideGridContainer}>
					<div className={css.timeHeader}>
						<div className={css.channelColumnSpacer} />
						<div className={css.timeSlots} ref={timeSlotsRef}>
							{timeSlots.map((slot, idx) => (
								<div
									key={idx}
									className={css.timeSlot}
									style={{width: `${PIXELS_PER_HOUR / 2}px`}}
								>
									{slot.label}
								</div>
							))}
						</div>
					</div>

					<Scroller
						className={css.guideHorizontalScroller}
						direction="horizontal"
						horizontalScrollbar="hidden"
						verticalScrollbar="hidden"
						onScroll={handleHorizontalScroll}
						cbScrollTo={fn => { horizScrollToRef.current = fn; }} // eslint-disable-line react/jsx-no-bind
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
									horizontalScrollbar="hidden"
									verticalScrollbar="auto"
									spotlightId="program-grid"
									cbScrollTo={fn => { scrollToRef.current = fn; }} // eslint-disable-line react/jsx-no-bind
								/>
							)}
						</div>
					</Scroller>
				</div>
			</div>

			{channelNumberBuffer && (
				<div className={css.channelNumberOverlay}>
					{channelNumberBuffer}
				</div>
			)}

			{selectedProgram && (
				<div className={css.programPopup}>
				<PopupContainer className={css.popupContent} spotlightId="livetv-popup">
						<div className={css.popupHeader}>
							<div className={css.popupTitle}>
								{selectedProgram.program.Name}
								{selectedProgram.program.ParentIndexNumber && selectedProgram.program.IndexNumber && (
									<span> - S{selectedProgram.program.ParentIndexNumber}E{selectedProgram.program.IndexNumber}</span>
								)}
							</div>
							{selectedProgram.program.EpisodeTitle && (
								<div className={css.popupSubtitle}>{selectedProgram.program.EpisodeTitle}</div>
							)}
							<div className={css.popupTime}>
								{new Date(selectedProgram.program.StartDate).toLocaleTimeString(undefined, {
									hour: 'numeric',
									minute: '2-digit',
									hour12: true
								})}
								{' - '}
								{new Date(selectedProgram.program.EndDate).toLocaleTimeString(undefined, {
									hour: 'numeric',
									minute: '2-digit',
									hour12: true
								})}
							</div>
						</div>

						<div className={css.popupBody}>
							{(selectedProgram.program.ImageTags?.Primary || selectedProgram.program.SeriesId) && (
								<div className={css.popupImageContainer}>
									<img
										src={`${serverUrl}/Items/${selectedProgram.program.ImageTags?.Primary ? selectedProgram.program.Id : selectedProgram.program.SeriesId}/Images/Primary?maxWidth=300&quality=90`}
										alt=""
									/>
								</div>
							)}
							<div className={css.popupInfo}>
								<div className={css.popupOverview}>
									{selectedProgram.program.Overview || $L('No description available.')}
								</div>
								<div className={css.popupMetadata}>
									<div className={css.metadataItem}>
										<span className={css.metadataLabel}>{$L('Channel:')}</span>
										<span className={css.metadataValue}>{selectedProgram.channel.Name}</span>
									</div>
									{selectedProgram.program.ProductionYear && (
										<div className={css.metadataItem}>
											<span className={css.metadataLabel}>{$L('Year:')}</span>
											<span className={css.metadataValue}>{selectedProgram.program.ProductionYear}</span>
										</div>
									)}
									{selectedProgram.program.OfficialRating && (
										<div className={css.metadataItem}>
											<span className={css.metadataLabel}>{$L('Rating:')}</span>
											<span className={css.metadataValue}>{selectedProgram.program.OfficialRating}</span>
										</div>
									)}
									{selectedProgram.program.Genres?.length > 0 && (
										<div className={css.metadataItem}>
											<span className={css.metadataLabel}>{$L('Genres:')}</span>
											<span className={css.metadataValue}>{selectedProgram.program.Genres.join(', ')}</span>
										</div>
									)}
								</div>
							</div>
						</div>

						<div className={css.popupActions}>
							{isCurrentProgram(selectedProgram.program) && (
								<SpottableButton
									className={`${css.popupBtn} spottable-default`}
									onClick={handleWatchChannel}
									spotlightId="popup-watch"
								>
									{$L('Watch Now')}
								</SpottableButton>
							)}
							<SpottableButton
								className={`${css.popupBtn} ${!isCurrentProgram(selectedProgram.program) ? 'spottable-default' : ''}`}
								onClick={handleClosePopup}
								spotlightId="popup-close"
							>
								{$L('Close')}
							</SpottableButton>
						</div>
					</PopupContainer>
				</div>
			)}
		</div>
	);
};

export default LiveTV;
