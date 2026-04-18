import { queryCache } from './query-cache';
import type { DataSpec } from './app.data';

/**
 * Utility to "pre-fetch" data before a page is actually loaded.
 * This is triggered on events like mouseenter/hover.
 */

const pendingFetches = new Map<string, Promise<any>>();

export async function prewarm<T>(spec: DataSpec<T>) {
    // If it's already in cache and not expired, skip
    if (queryCache.has(spec.key)) return;

    // If there's already a pending fetch for this key, return it
    if (pendingFetches.has(spec.key)) return pendingFetches.get(spec.key);

    // Otherwise, start fetching
    const fetchPromise = spec.fetch().then(data => {
        queryCache.set(spec.key, data);
        pendingFetches.delete(spec.key);
        return data;
    }).catch(err => {
        console.warn(`Prewarm failed for ${spec.key}:`, err);
        pendingFetches.delete(spec.key);
    });

    pendingFetches.set(spec.key, fetchPromise);
    return fetchPromise;
}

/**
 * Attach prewarm logic to an element (Vanilla JS helper)
 */
export function attachPrewarm<T>(element: HTMLElement | null, spec: DataSpec<T>) {
    if (!element) return;
    
    element.addEventListener('mouseenter', () => {
        prewarm(spec);
    }, { once: true }); // Only prewarm once per mounting
}
