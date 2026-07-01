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
