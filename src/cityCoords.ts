export interface CityCoords {
  lat: number;
  lon: number;
  tz: string;
}

export const CITY_COORDS: Record<string, CityCoords> = {
  Shanghai: { lat: 31.2304, lon: 121.4737, tz: "Asia/Shanghai" },
  "Hong Kong": { lat: 22.3193, lon: 114.1694, tz: "Asia/Hong_Kong" },
  Tokyo: { lat: 35.6762, lon: 139.6503, tz: "Asia/Tokyo" },
  Singapore: { lat: 1.3521, lon: 103.8198, tz: "Asia/Singapore" },
  Sydney: { lat: -33.8688, lon: 151.2093, tz: "Australia/Sydney" },
  London: { lat: 51.5074, lon: -0.1278, tz: "Europe/London" },
  Paris: { lat: 48.8566, lon: 2.3522, tz: "Europe/Paris" },
  Beijing: { lat: 39.9042, lon: 116.4074, tz: "Asia/Shanghai" },
  "New York": { lat: 40.7128, lon: -74.006, tz: "America/New_York" },
  "Los Angeles": { lat: 34.0522, lon: -118.2437, tz: "America/Los_Angeles" },
  Miami: { lat: 25.7617, lon: -80.1918, tz: "America/New_York" },
  Chicago: { lat: 41.8781, lon: -87.6298, tz: "America/Chicago" },
  Dubai: { lat: 25.2048, lon: 55.2708, tz: "Asia/Dubai" },
  Mumbai: { lat: 19.076, lon: 72.8777, tz: "Asia/Kolkata" },
  Seoul: { lat: 37.5665, lon: 126.978, tz: "Asia/Seoul" },
  Bangkok: { lat: 13.7563, lon: 100.5018, tz: "Asia/Bangkok" },
  Wellington: { lat: -41.2865, lon: 174.7762, tz: "Pacific/Auckland" },
  "Cape Town": { lat: -33.9249, lon: 18.4241, tz: "Africa/Johannesburg" }
};
