/**
 * Decide whether to fetch the next batch of Live TV channels.
 * @returns {boolean}
 */
export const shouldLoadMore = ({focusedIndex, loadedCount, hasMore, isLoadingMore, threshold = 10}) => {
	if (!hasMore || isLoadingMore) return false;
	if (loadedCount <= 0) return false;
	return focusedIndex >= loadedCount - threshold - 1;
};
