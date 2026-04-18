import { API } from './api';
import type { Record, CategoryMap } from './types';
import { queryCache } from './query-cache';

/**
 * Data Specs define the "query keys" and "fetch functions" for our data.
 * This pattern keeps data fetching logic predictable and reusable.
 */

export interface DataSpec<T> {
    key: string;
    fetch: () => Promise<T>;
}

export const DataSpecs = {
    // Current Month's Records
    MonthlyRecords: (year: number, month: number): DataSpec<Record[]> => ({
        key: `records-${year}-${month}`,
        fetch: () => API.loadRecords(year, month)
    }),

    // All Records (for Transaction view)
    AllRecords: (): DataSpec<Record[]> => ({
        key: 'records-all',
        fetch: () => API.loadRecords()
    }),

    // Categories
    Categories: (): DataSpec<{ CATS: CategoryMap, INCOME_CATS: CategoryMap }> => ({
        key: 'categories',
        fetch: () => API.loadCategories()
    }),

    // Category List (raw)
    CategoryList: (): DataSpec<any[]> => ({
        key: 'category-list',
        fetch: () => API.loadCategoryList()
    }),

    // Pool Data for a specific year
    Pools: (year: number): DataSpec<any[]> => ({
        key: `pools-${year}`,
        fetch: () => API.loadPools(year)
    }),

    // User Profile
    User: (): DataSpec<any> => ({
        key: 'user',
        fetch: () => API.getUser()
    })
};

/**
 * Trigger a prefetch for a data spec.
 * Usually called on hover.
 */
export function prewarm(spec: DataSpec<any>) {
    queryCache.prefetchQuery(spec);
}

/**
 * Fetch data and use cache if available.
 * This is the primary way to consume data in page components.
 */
export async function useData<T>(spec: DataSpec<T>): Promise<T> {
    return queryCache.fetchQuery(spec);
}
