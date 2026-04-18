/**
 * Simple client-side cache for JSON responses.
 * Used to implement the "snappy" data prefetching pattern.
 */

class QueryCache {
    private cache = new Map<string, { data: any; timestamp: number }>();
    private TTL = 1000 * 60 * 5; // 5 minutes default TTL

    set(key: string, data: any) {
        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }

    get<T>(key: string): T | null {
        const item = this.cache.get(key);
        if (!item) return null;

        if (this.isExpired(key)) {
            this.cache.delete(key);
            return null;
        }

        return item.data as T;
    }

    async prefetchQuery<T>(spec: { key: string; fetch: () => Promise<T> }): Promise<void> {
        // Only fetch if not already in cache or expired
        if (this.has(spec.key)) return;

        try {
            const data = await spec.fetch();
            this.set(spec.key, data);
        } catch (e) {
            console.warn(`Prefetch failed for key: ${spec.key}`, e);
        }
    }

    async fetchQuery<T>(spec: { key: string; fetch: () => Promise<T> }): Promise<T> {
        const cached = this.get<T>(spec.key);
        if (cached !== null) return cached;

        const data = await spec.fetch();
        this.set(spec.key, data);
        return data;
    }

    has(key: string): boolean {
        return this.cache.has(key) && !this.isExpired(key);
    }

    private isExpired(key: string): boolean {
        const item = this.cache.get(key);
        if (!item) return true;
        return Date.now() - item.timestamp > this.TTL;
    }

    clear() {
        this.cache.clear();
    }
}

export const queryCache = new QueryCache();
