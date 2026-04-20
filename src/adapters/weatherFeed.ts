import { CITY_COORDS } from "../cityCoords.js";
import { Forecast, WeatherEvent } from "../types.js";

interface OpenMeteoDaily {
  time?: string[];
  temperature_2m_max?: number[];
}

interface OpenMeteoResponse {
  daily?: OpenMeteoDaily;
}

export async function fetchOpenMeteoForecast(
  event: WeatherEvent,
  fetchImpl: typeof fetch = fetch
): Promise<Forecast> {
  const coords = CITY_COORDS[event.city];
  if (!coords) throw new Error(`No coordinates configured for city: ${event.city}`);

  const params = new URLSearchParams({
    latitude: String(coords.lat),
    longitude: String(coords.lon),
    daily: "temperature_2m_max",
    timezone: coords.tz,
    forecast_days: "7"
  });

  const response = await fetchImpl(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Open-Meteo forecast failed for ${event.city}: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as OpenMeteoResponse;
  const times = json.daily?.time ?? [];
  const temps = json.daily?.temperature_2m_max ?? [];
  const index = times.indexOf(event.date);
  if (index < 0) {
    throw new Error(`Open-Meteo response does not include ${event.city} event date ${event.date}`);
  }
  const selectedIndex = index;
  const temp = temps[selectedIndex];
  const date = times[selectedIndex] ?? event.date;
  if (temp === undefined || !Number.isFinite(temp)) {
    throw new Error(`Open-Meteo response missing daily max temperature for ${event.city} ${event.date}`);
  }

  return {
    city: event.city,
    date,
    temperatureMaxC: temp,
    source: "open-meteo"
  };
}
