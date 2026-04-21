import { WeatherEvent, WeatherMarket } from "../types.js";

interface GammaEvent {
  id?: string | number;
  title?: string;
  slug?: string;
  eventDate?: string;
  markets?: GammaMarket[];
}

interface GammaMarket {
  conditionId?: string;
  question?: string;
  groupItemTitle?: string;
  outcomes?: unknown;
  outcomePrices?: unknown;
  clobTokenIds?: unknown;
  volume24hr?: string | number;
  volume24hrClob?: string | number;
  enableOrderBook?: boolean;
  closed?: boolean;
  resolved?: boolean;
  acceptingOrders?: boolean;
}

export interface DiscoveryOptions {
  maxEvents: number;
  maxOutcomesPerEvent: number;
  minMarketVolumeUsdc: number;
  fetchImpl?: typeof fetch;
}

const GAMMA_WEATHER_URL =
  "https://gamma-api.polymarket.com/events?tag_id=84&active=true&closed=false&limit=100&order=volume24hr&ascending=false";

export async function findActiveWeatherEvents(options: DiscoveryOptions): Promise<WeatherEvent[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(GAMMA_WEATHER_URL);
  if (!response.ok) {
    throw new Error(`Gamma weather discovery failed: ${response.status} ${response.statusText}`);
  }

  const raw = (await response.json()) as GammaEvent[];
  return parseWeatherEvents(raw, options);
}

export function parseWeatherEvents(rawEvents: GammaEvent[], options: DiscoveryOptions): WeatherEvent[] {
  const parsed: WeatherEvent[] = [];

  for (const rawEvent of rawEvents) {
    const title = rawEvent.title ?? "";
    const meta = parseWeatherTitle(title, rawEvent.eventDate);
    if (!meta) continue;
    if (meta.date <= todayIso()) continue;

    const markets = (rawEvent.markets ?? [])
      .map((market) => parseMarket(market))
      .filter((market): market is WeatherMarket => market !== null)
      .filter((market) => market.enableOrderBook && !market.closed && !market.resolved)
      .filter((market) => market.volume24hr >= options.minMarketVolumeUsdc)
      .slice(0, options.maxOutcomesPerEvent);

    if (markets.length === 0) continue;

    parsed.push({
      id: String(rawEvent.id ?? rawEvent.slug ?? title),
      title,
      slug: rawEvent.slug,
      city: meta.city,
      date: meta.date,
      markets
    });

    if (parsed.length >= options.maxEvents) break;
  }

  return parsed;
}

export function parseWeatherTitle(title: string, eventDate?: string): { city: string; date: string } | null {
  const match = title.match(/temperature in (.+?) on ([A-Za-z]+ \d{1,2})\??$/i);
  if (!match?.[1] || !match[2]) return null;
  const year = new Date().getUTCFullYear();
  const date = new Date(`${match[2]}, ${year} UTC`);
  if (Number.isNaN(date.getTime())) return null;
  return { city: match[1].trim(), date: eventDate?.slice(0, 10) ?? date.toISOString().slice(0, 10) };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseMarket(raw: GammaMarket): WeatherMarket | null {
  const conditionId = raw.conditionId;
  const tokenIds = normalizeStringArray(raw.clobTokenIds);
  if (!conditionId || tokenIds.length < 2) return null;

  const question = raw.question ?? raw.groupItemTitle ?? "";
  const sourceLabel = raw.groupItemTitle ?? question;
  const parsed = parseOutcomeBucket(sourceLabel);
  if (!parsed) return null;

  const prices = normalizeStringArray(raw.outcomePrices).map(Number);
  const yesPrice = prices[0];
  const noPrice = prices[1];

  return {
    conditionId,
    question,
    outcomeLabel: parsed.outcomeLabel,
    temperatureC: parsed.temperatureC,
    binWidthC: parsed.binWidthC,
    isLowTail: parsed.isLowTail,
    isHighTail: parsed.isHighTail,
    rawUnit: parsed.rawUnit,
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
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export interface ParsedBucket {
  outcomeLabel: string;
  temperatureC: number;
  binWidthC: number;
  isLowTail: boolean;
  isHighTail: boolean;
  rawUnit: "F" | "C";
}

/**
 * Parse a Polymarket weather outcome label into a normalized bucket.
 *
 * Supported shapes (via regex on the source text):
 *   "31°F or below"        → low tail, unit=F, pick 31 as the closed edge
 *   "50°F or higher"       → high tail, unit=F, pick 50 as the closed edge
 *   "32-33°F"              → 2°F range bin, centre=32.5°F, width=2°F
 *   "17°C"                 → point bin, unit=C, centre=17°C, width=1°C
 *   "17.5°C"               → point bin, unit=C, centre=17.5°C, width=1°C
 *   "Below 5°C" / "5°C or colder" → low tail
 *   "Above 30°C" / "30°C or hotter" → high tail
 *
 * Everything is normalized to Celsius for `temperatureC` and `binWidthC` so
 * the fair-value CDF works regardless of source unit.
 */
export function parseOutcomeBucket(source: string): ParsedBucket | null {
  if (!source) return null;
  const s = source.trim();

  // Detect unit: prefer °F if present, else default to °C
  const hasF = /°?\s*F\b|fahrenheit/i.test(s);
  const hasC = /°?\s*C\b|celsius/i.test(s);
  const rawUnit: "F" | "C" = hasF && !hasC ? "F" : "C";

  // Detect tails
  const lowTailRe = /(?:or below|or colder|or less|below|<=|≤)/i;
  const highTailRe = /(?:or higher|or hotter|or more|or above|above|>=|≥)/i;
  const isLow = lowTailRe.test(s);
  const isHigh = highTailRe.test(s);

  const unitWidth = rawUnit === "F" ? 5 / 9 : 1; // °C per 1 unit of rawUnit

  // Range bucket first: look for "<num>-<num>" (or "<num>–<num>", "<num> to <num>")
  // BEFORE falling back to generic number extraction so the '-' separator isn't
  // misread as a negative sign on the second number.
  const rangeMatch = s.match(/(-?\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(-?\d+(?:\.\d+)?)/i);
  if (rangeMatch && !isLow && !isHigh) {
    const a = Number(rangeMatch[1]);
    const b = Number(rangeMatch[2]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const centre = (lo + hi) / 2;
    const width = hi - lo + 1; // inclusive range width in raw units (32-33 inclusive = 2)
    return {
      outcomeLabel: s,
      temperatureC: rawUnit === "F" ? fahrenheitToCelsius(centre) : centre,
      binWidthC: width * unitWidth,
      isLowTail: false,
      isHighTail: false,
      rawUnit
    };
  }

  // Non-range: extract the first number in the label.
  const firstMatch = s.match(/-?\d+(?:\.\d+)?/);
  if (!firstMatch) return null;
  const centreRaw = Number(firstMatch[0]);
  return {
    outcomeLabel: s,
    temperatureC: rawUnit === "F" ? fahrenheitToCelsius(centreRaw) : centreRaw,
    // Tails are open-ended: width is treated as 1 raw-unit for the Gaussian
    // integration boundary; the CDF helper treats isLowTail/isHighTail
    // specially so the width is only used for the closed edge.
    binWidthC: unitWidth,
    isLowTail: isLow,
    isHighTail: isHigh,
    rawUnit
  };
}

export function fahrenheitToCelsius(f: number): number {
  return ((f - 32) * 5) / 9;
}
