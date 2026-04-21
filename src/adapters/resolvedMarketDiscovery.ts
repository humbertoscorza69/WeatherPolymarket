/**
 * Gamma discovery for RESOLVED (closed + settled) Polymarket events.
 *
 * Unlike genericDiscovery.ts (which returns ACTIVE markets for live quoting),
 * this adapter fetches markets whose binary condition has already settled.
 * We use these for the resolution-taker backtest, where we need to know
 * which outcome ended up paying $1 so we can compute realized PnL.
 *
 * Gamma's `/events` endpoint accepts `closed=true`. For each returned event's
 * markets we extract:
 *   - conditionId + per-token IDs (yes/no)
 *   - the resolved `outcomePrices` → `[1, 0]` or `[0, 1]` tells us which
 *     token won. We tag each token with `tokenResolutionValue ∈ {0, 1}`
 *     so the backtest doesn't have to look it up again.
 *   - `endDate` or event-level `endDate` as the resolution timestamp proxy
 *     (Gamma doesn't expose the exact settlement UNIX sec — end_date is the
 *     nominal close time, which is what retail sees anyway).
 */

export interface ResolvedGammaEvent {
  id?: string | number;
  title?: string;
  slug?: string;
  endDate?: string;
  markets?: ResolvedGammaMarket[];
  tags?: { slug?: string; label?: string }[];
}

export interface ResolvedGammaMarket {
  conditionId?: string;
  question?: string;
  groupItemTitle?: string;
  slug?: string;
  endDate?: string;
  clobTokenIds?: unknown;
  outcomes?: unknown;
  outcomePrices?: unknown;
  volume?: string | number;
  volume24hr?: string | number;
  volumeClob?: string | number;
  enableOrderBook?: boolean;
  closed?: boolean;
  resolved?: boolean;
}

export interface ResolvedMarketInfo {
  /** Unique ID for this virtual-market (token-level). */
  id: string;
  conditionId: string;
  tokenId: string;
  /** YES or NO side of the binary. */
  side: "YES" | "NO";
  /** 1 if this token paid out $1 at resolution, 0 otherwise. */
  tokenResolutionValue: 0 | 1;
  /** UNIX seconds at which the market's reported endDate landed. */
  resolutionTs: number;
  title: string;
  question: string;
  slug?: string;
  eventSlug?: string;
  category?: string;
  volumeUsdc: number;
}

export interface ResolvedMarketDiscoveryOptions {
  /** Full Gamma URL including `closed=true` + tag + limit + ordering. */
  gammaUrl: string;
  /** Skip markets whose total volume is below this (filter out dead books). */
  minVolumeUsdc: number;
  /** Only include markets whose endDate is between these two bounds (ISO strings). */
  endDateAfter?: string;
  endDateBefore?: string;
  /** Maximum number of resolved events to return; Gamma caps at 500. */
  maxEvents: number;
  fetchImpl?: typeof fetch;
}

export async function findResolvedMarkets(
  options: ResolvedMarketDiscoveryOptions
): Promise<ResolvedMarketInfo[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.gammaUrl);
  if (!response.ok) {
    throw new Error(`Resolved-market discovery failed: ${response.status} ${response.statusText}`);
  }
  const raw = (await response.json()) as ResolvedGammaEvent[];
  return parseResolvedEvents(raw, options);
}

export function parseResolvedEvents(
  raw: ResolvedGammaEvent[],
  options: ResolvedMarketDiscoveryOptions
): ResolvedMarketInfo[] {
  const out: ResolvedMarketInfo[] = [];
  const afterMs = options.endDateAfter ? Date.parse(options.endDateAfter) : 0;
  const beforeMs = options.endDateBefore ? Date.parse(options.endDateBefore) : Infinity;

  for (const event of raw) {
    const eventSlug = event.slug;
    const eventCategory =
      event.tags?.find((t) => typeof t.slug === "string" && t.slug!.length > 0)?.slug ??
      event.tags?.[0]?.label ??
      undefined;

    for (const m of event.markets ?? []) {
      if (!m.conditionId) continue;
      if (m.closed !== true) continue; // gamma is inconsistent — double-check

      const endDateStr = m.endDate ?? event.endDate;
      if (!endDateStr) continue;
      const endMs = Date.parse(endDateStr);
      if (!Number.isFinite(endMs)) continue;
      if (endMs < afterMs || endMs > beforeMs) continue;

      const tokenIds = normalizeStringArray(m.clobTokenIds);
      const outcomePrices = normalizeStringArray(m.outcomePrices).map(Number);
      if (tokenIds.length < 2 || outcomePrices.length < 2) continue;
      // After resolution, outcomePrices are [1,0] or [0,1]. If neither, the
      // market didn't cleanly resolve (void / refund / still-pending) — skip.
      const yesPrice = outcomePrices[0];
      const noPrice = outcomePrices[1];
      if (!isResolved01(yesPrice, noPrice)) continue;

      const volume = Number(m.volumeClob ?? m.volume ?? m.volume24hr ?? 0);
      if (volume < options.minVolumeUsdc) continue;

      const resolutionTs = Math.floor(endMs / 1000);
      const title = event.title ?? m.question ?? m.conditionId;
      const question = m.question ?? m.groupItemTitle ?? title;

      // Emit BOTH tokens as separate virtual markets — the backtest will
      // decide which side to buy based on its entry band.
      out.push({
        id: `${m.conditionId}-YES`,
        conditionId: m.conditionId,
        tokenId: tokenIds[0]!,
        side: "YES",
        tokenResolutionValue: yesPrice === 1 ? 1 : 0,
        resolutionTs,
        title,
        question,
        slug: m.slug,
        eventSlug,
        category: eventCategory,
        volumeUsdc: volume
      });
      out.push({
        id: `${m.conditionId}-NO`,
        conditionId: m.conditionId,
        tokenId: tokenIds[1]!,
        side: "NO",
        tokenResolutionValue: noPrice === 1 ? 1 : 0,
        resolutionTs,
        title,
        question,
        slug: m.slug,
        eventSlug,
        category: eventCategory,
        volumeUsdc: volume
      });

      if (out.length / 2 >= options.maxEvents) break;
    }
    if (out.length / 2 >= options.maxEvents) break;
  }
  return out;
}

function isResolved01(yes: number | undefined, no: number | undefined): boolean {
  if (yes === undefined || no === undefined) return false;
  // Allow for float noise around the canonical [1,0]/[0,1] shape.
  const isOne = (x: number) => Math.abs(x - 1) < 1e-6;
  const isZero = (x: number) => Math.abs(x) < 1e-6;
  return (isOne(yes) && isZero(no)) || (isZero(yes) && isOne(no));
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** Gamma URL templates for fetching CLOSED markets by category tag. The 90-day
 *  window is a compromise: enough markets to grid-search, recent enough to
 *  represent current retail-flow conditions. */
export function buildResolvedUrl(
  tagId: number,
  lookbackDays: number,
  limit: number
): string {
  const after = new Date(Date.now() - lookbackDays * 86400_000).toISOString();
  return (
    `https://gamma-api.polymarket.com/events` +
    `?tag_id=${tagId}` +
    `&closed=true` +
    `&limit=${limit}` +
    `&end_date_min=${after}` +
    `&order=endDate` +
    `&ascending=false`
  );
}

export const RESOLVED_PRESETS: Record<string, (lookbackDays: number, limit: number) => string> = {
  weather: (d, l) => buildResolvedUrl(84, d, l),
  politics: (d, l) => buildResolvedUrl(2, d, l),
  sports: (d, l) => buildResolvedUrl(1, d, l),
  crypto: (d, l) => buildResolvedUrl(21, d, l),
  entertainment: (d, l) => buildResolvedUrl(596, d, l),
  all: (d, l) =>
    `https://gamma-api.polymarket.com/events?closed=true&limit=${l}&end_date_min=${new Date(
      Date.now() - d * 86400_000
    ).toISOString()}&order=endDate&ascending=false`
};
