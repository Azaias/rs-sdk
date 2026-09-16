import Environment from '#/util/Environment.js';
import { marketStore, positive } from '#/engine/market/MarketStore.js';
import { catalog, marketItem } from '#/engine/market/MarketCatalog.js';

const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=5' };
const snapshots = new Map<number, { at: number; rows: ReturnType<ReturnType<typeof marketStore>['overview']> }>();
function snapshot(days: number) {
    const now = Date.now(),
        cached = snapshots.get(days);
    if (cached && now - cached.at < 5000) return cached;
    const result = { at: now, rows: marketStore().overview(now - days * 86_400_000, now) };
    snapshots.set(days, result);
    return result;
}
function period(url: URL) {
    const days = integer(url, 'days', 7, 1, 90);
    if (![1, 7, 30, 90].includes(days)) throw new Error('Invalid days: use 1, 7, 30 or 90.');
    return days;
}
function integer(url: URL, key: string, fallback: number, min: number, max: number) {
    const raw = url.searchParams.get(key);
    const value = raw === null ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}: expected an integer from ${min} to ${max}.`);
    return value;
}
export function handleMarket(req: Request, url: URL): Response | null {
    const page = url.pathname === '/market' || url.pathname === '/market/';
    const status = url.pathname === '/api/market/status';
    if (!page && !status && url.pathname !== '/api/market' && !url.pathname.startsWith('/api/market/')) return null;
    const message = 'Grand Exchange is not available on this server.';
    if (status && req.method === 'GET') return Response.json(
        { enabled: Environment.GE_ENABLED, ...(!Environment.GE_ENABLED ? { message } : {}) },
        { headers: { ...headers, 'Cache-Control': 'no-store' } }
    );
    if (!Environment.GE_ENABLED) return Response.json(
        { error: message, reason: 'ge_unavailable' },
        { status: 503, headers: { ...headers, 'Cache-Control': 'no-store' } }
    );
    if (req.method !== 'GET') return Response.json({ error: 'Market data is read-only. Trade at Varrock west bank.' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
    if (page) return new Response(Bun.file('public/market.html'), { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' } });
    try {
        if (url.pathname === '/api/market/items') {
            const q = url.searchParams.get('q') ?? '';
            if (q.length > 80) throw new Error('Search is limited to 80 characters.');
            const limit = integer(url, 'limit', 25, 1, 100),
                offset = integer(url, 'offset', 0, 0, 100_000);
            const days = period(url),
                sort = url.searchParams.get('sort') ?? (q.trim() ? 'relevance' : 'name');
            if (!['relevance', 'name', 'name-desc', 'recent', 'rises', 'falls', 'marketCap', 'price', 'volume', 'value', 'buyValue', 'sellRecent'].includes(sort)) throw new Error('Invalid sort.');
            const data = snapshot(days),
                byId = new Map(data.rows.map(row => [row.item, row]));
            const empty = {
                bid: null,
                ask: null,
                buyQuantity: 0,
                buyValue: 0,
                sellQuantity: 0,
                sellValue: 0,
                lastSellAt: null,
                volume: 0,
                gross: 0,
                tax: 0,
                trades: 0,
                lastPrice: null,
                lastTradeAt: null,
                referencePrice: null,
                vwap: null,
                change: null,
                changePercent: null,
                marketCap: null
            };
            let matches = catalog(q, sort === 'name' || sort === 'name-desc' ? sort : 'relevance').map(i => ({ ...i, ...empty, item: i.id, ...byId.get(i.id) }));
            if (sort === 'rises') matches = matches.filter(i => i.changePercent !== null && i.changePercent > 0 && i.volume > 0);
            if (sort === 'falls') matches = matches.filter(i => i.changePercent !== null && i.changePercent < 0 && i.volume > 0);
            if (sort === 'marketCap') matches = matches.filter(i => i.marketCap !== null && i.marketCap > 0);
            if (sort === 'buyValue') matches = matches.filter(i => i.buyValue > 0);
            if (sort === 'sellRecent') matches = matches.filter(i => i.sellQuantity > 0 && i.lastSellAt !== null);
            if (sort === 'price') matches = matches.filter(i => i.lastPrice !== null);
            if (sort === 'recent') matches = matches.filter(i => i.lastTradeAt !== null);
            if (sort === 'volume' || sort === 'value') matches = matches.filter(i => i.volume > 0);
            const sortKeys = { recent: 'lastTradeAt', rises: 'changePercent', falls: 'changePercent', marketCap: 'marketCap', price: 'lastPrice', volume: 'volume', value: 'gross', buyValue: 'buyValue', sellRecent: 'lastSellAt' } as const;
            const key = sortKeys[sort as keyof typeof sortKeys];
            if (key) matches.sort((a, b) => ((b[key] ?? -Infinity) - (a[key] ?? -Infinity)) * (sort === 'falls' ? -1 : 1) || a.name.localeCompare(b.name) || a.id - b.id);
            const eligible = new Set(catalog().map(i => i.id)),
                active = data.rows.filter(i => eligible.has(i.item));
            const summary = { totalItems: eligible.size, volume: active.reduce((n, i) => n + i.volume, 0), gross: active.reduce((n, i) => n + i.gross, 0), activeItems: active.filter(i => i.volume > 0).length };
            const featured = [...active].filter(i => i.volume > 0).sort((a, b) => b.volume - a.volume)[0];
            return Response.json(
                { items: matches.slice(offset, offset + limit), total: matches.length, offset, limit, days, sort, updatedAt: data.at, summary, featured: featured ? { ...catalog().find(i => i.id === featured.item), ...featured } : null },
                { headers }
            );
        }
        const match = /^\/api\/market\/items\/(\d+)(\/history)?$/.exec(url.pathname);
        if (!match) return Response.json({ error: 'Not found' }, { status: 404, headers });
        const id = positive(Number(match[1]), 'Item');
        let item;
        try {
            item = marketItem(id);
        } catch {
            return Response.json({ error: 'Tradeable item not found' }, { status: 404, headers });
        }
        if (!match[2]) {
            const days = period(url),
                row = snapshot(days).rows.find(i => i.item === id);
            return Response.json({ id, name: item.name, basePrice: item.cost, ...marketStore().quote(id, Date.now() - days * 86_400_000), referencePrice: null, change: null, changePercent: null, marketCap: null, ...row }, { headers });
        }
        const now = Date.now();
        const from = integer(url, 'from', now - 30 * 86_400_000, 0, Number.MAX_SAFE_INTEGER);
        const to = integer(url, 'to', now, 1, Number.MAX_SAFE_INTEGER);
        const interval = integer(url, 'interval', 86_400_000, 3_600_000, 86_400_000);
        if (![3_600_000, 86_400_000].includes(interval) || to <= from || to - from > 366 * 86_400_000 || Math.ceil((to - from) / interval) > 1000)
            throw new Error('Use hour/day intervals, an increasing range up to 366 days, and at most 1000 buckets.');
        return Response.json({ item: id, from, to, interval, history: marketStore().history(id, from, to, interval) }, { headers });
    } catch (error) {
        if (error instanceof Error && /Invalid |Search is |Use hour|must be a whole/.test(error.message)) return Response.json({ error: error.message }, { status: 400, headers });
        console.error('[market] Read failed', error);
        return Response.json({ error: 'Market temporarily unavailable' }, { status: 503, headers: { ...headers, 'Cache-Control': 'no-store' } });
    }
}
