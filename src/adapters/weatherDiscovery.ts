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
  const outcomeLabel = extractOutcomeLabel(question, raw.groupItemTitle);
  const temperatureC = parseTemperature(outcomeLabel);
  if (!Number.isFinite(temperatureC)) return null;

  const prices = normalizeStringArray(raw.outcomePrices).map(Number);
  const yesPrice = prices[0];
  const noPrice = prices[1];

  return {
    conditionId,
    question,
    outcomeLabel,
    temperatureC,
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

function extractOutcomeLabel(question: string, groupItemTitle?: string): string {
  const source = groupItemTitle || question;
  const celsius = source.match(/(-?\d+(?:\.\d+)?).*?C/i);
  if (celsius?.[1]) return `${Number(celsius[1])}C`;
  const quoted = source.match(/["']([^"']+)["']/);
  return quoted?.[1] ?? source;
}

function parseTemperature(label: string): number {
  const match = label.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}
