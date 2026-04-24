/**
 * Generic Polymarket event discovery by Gamma tag / URL.
 *
 * Unlike weatherDiscovery.ts, this parser does NOT require a "temperature
 * in <city> on <date>" title format or numeric bucket outcome labels. It
 * fetches arbitrary active events from Gamma and returns them as
 * WeatherEvent-shaped stubs so the downstream MM engine works unchanged.
 *
 * The stub has:
 *   - city = event title (used only for logging / dashboard)
 *   - date = event.endDate (or eventDate, or today+30d if both missing)
 *   - markets[].temperatureC = 0.5 (dummy; caller must set BYPASS_FORECAST=true)
 *   - markets[].isLowTail / isHighTail = false
 *
 * Callers MUST set BYPASS_FORECAST=true when using this discovery — the
 * fair-value CDF assumes temperature-like buckets and will produce garbage
 * for arbitrary outcomes.
 */

import { WeatherEvent, WeatherMarket } from "../types.js";

interface GammaEvent {
  id?: string | number;
  title?: string;
  slug?: string;
  eventDate?: string;
  endDate?: string;
  markets?: GammaMarket[];
}

interface GammaMarket {
  conditionId?: string;
  question?: string;
  groupItemTitle?: string;
  clobTokenIds?: unknown;
  outcomes?: unknown;
  outcomePrices?: unknown;
  volume24hr?: string | number;
  volume24hrClob?: string | number;
  enableOrderBook?: boolean;
  closed?: boolean;
  resolved?: boolean;
}

export interface GenericDiscoveryOptions {
  /** Full Gamma /events URL, including query string. */
  gammaUrl: string;
  maxEvents: number;
  maxOutcomesPerEvent: number;
  minMarketVolumeUsdc: number;
  fetchImpl?: typeof fetch;
}

export async function findGenericEvents(options: GenericDiscoveryOptions): Promise<WeatherEvent[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.gammaUrl);
  if (!response.ok) {
    throw new Error(`Gamma discovery failed: ${response.status} ${response.statusText}`);
  }
  const raw = (await response.json()) as GammaEvent[];
  return parseGenericEvents(raw, options);
}

export function parseGenericEvents(rawEvents: GammaEvent[], options: GenericDiscoveryOptions): WeatherEvent[] {
  const parsed: WeatherEvent[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const rawEvent of rawEvents) {
    const title = rawEvent.title ?? "untitled";
    const date =
      rawEvent.eventDate?.slice(0, 10) ??
      rawEvent.endDate?.slice(0, 10) ??
      // Some events have no date — assume 30 days out so the horizon-scaled
      // sigma handles it gracefully. (Irrelevant when bypassForecast=true.)
      new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    if (date <= today) continue;

    const markets = (rawEvent.markets ?? [])
      .map((m, idx) => parseGenericMarket(m, idx))
      .filter((m): m is WeatherMarket => m !== null)
      .filter((m) => m.enableOrderBook && !m.closed && !m.resolved)
      .filter((m) => m.volume24hr >= options.minMarketVolumeUsdc)
      .slice(0, options.maxOutcomesPerEvent);

    if (markets.length === 0) continue;

    parsed.push({
      id: String(rawEvent.id ?? rawEvent.slug ?? title),
      title,
      slug: rawEvent.slug,
      city: title.slice(0, 50),
      date,
      markets
    });
    if (parsed.length >= options.maxEvents) break;
  }

  return parsed;
}

function parseGenericMarket(raw: GammaMarket, idx: number): WeatherMarket | null {
  const conditionId = raw.conditionId;
  const tokenIds = normalizeStringArray(raw.clobTokenIds);
  if (!conditionId || tokenIds.length < 2) return null;
  const question = raw.question ?? raw.groupItemTitle ?? `outcome-${idx}`;
  const label = raw.groupItemTitle ?? question;
  const prices = normalizeStringArray(raw.outcomePrices).map(Number);
  const yesPrice = prices[0];
  const noPrice = prices[1];

  return {
    conditionId,
    question,
    outcomeLabel: label.slice(0, 60),
    // Dummy temperature: fair value is skipped in generic mode, so these
    // values don't affect quoting. They're here only because WeatherMarket
    // requires them for type compatibility.
    temperatureC: 0.5,
    binWidthC: 1,
    isLowTail: false,
    isHighTail: false,
    rawUnit: "C",
    yesTokenId: tokenIds[0] ?? "",
    noTokenId: tokenIds[1] ?? "",
    volume24hr: Number(raw.volume24hrClob ?? raw.volume24hr ?? 0),
    enableOrderBook: raw.enableOrderBook === true,
    closed: raw.closed === true,
    resolved: raw.resolved === true,
    bestBid: typeof yesPrice === "number" && Number.isFinite(yesPrice) ? yesPrice : undefined,
    bestAsk: typeof noPrice === "number" && Number.isFinite(noPrice) ? 1 - noPrice : undefined
  };
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

/**
 * Prebuilt Gamma URLs for common Polymarket categories. Users can override
 * via GAMMA_EVENTS_URL env; these are the defaults per category.
 *
 * tag_id values are from Polymarket's public Gamma tag taxonomy as of
 * 2025-Q2. If a tag has been renumbered, the URL still works as long as
 * the tag exists — set GAMMA_EVENTS_URL directly for anything unusual.
 */
export const GAMMA_PRESETS = {
  weather:
    "https://gamma-api.polymarket.com/events?tag_id=84&active=true&closed=false&limit=100&order=volume24hr&ascending=false",
  politics:
    "https://gamma-api.polymarket.com/events?tag_id=2&active=true&closed=false&limit=100&order=volume24hr&ascending=false",
  sports:
    "https://gamma-api.polymarket.com/events?tag_id=1&active=true&closed=false&limit=100&order=volume24hr&ascending=false",
  crypto:
    "https://gamma-api.polymarket.com/events?tag_id=21&active=true&closed=false&limit=100&order=volume24hr&ascending=false",
  entertainment:
    "https://gamma-api.polymarket.com/events?tag_id=596&active=true&closed=false&limit=100&order=volume24hr&ascending=false"
} as const;

export type DiscoveryPreset = keyof typeof GAMMA_PRESETS;
