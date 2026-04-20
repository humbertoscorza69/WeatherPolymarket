/**
 * Inventory-aware spread widening.
 *
 * Stoikov's inventory-risk result: as your long-only inventory grows, push
 * your BUY further below mid so the marginal fill becomes less attractive.
 * Economically: the more capital we've already deployed, the more we should
 * demand per new position, because (a) risk concentration rises, and (b)
 * stale inventory ties up capital that could hit fresher opportunities.
 *
 * Formula
 * -------
 *   utilization = currentExposureUsdc / maxExposureUsdc   (∈ [0, 1])
 *   widenCents  = baseHalfSpreadCents + inventorySkewCents × utilization
 *
 * At 0% utilization we quote normally. At 100% we quote the fully skewed
 * spread. Linear ramp. Simple and well-behaved.
 *
 * Default inventorySkewCents = 2 — so with a 1¢ base, we widen to 3¢ when
 * fully loaded. Tunable via env.
 */

export interface InventorySkewConfig {
  baseHalfSpreadCents: number;
  inventorySkewCents: number;
  maxExposureUsdc: number;
}

export function skewedHalfSpreadCents(
  config: InventorySkewConfig,
  currentExposureUsdc: number
): number {
  if (config.maxExposureUsdc <= 0) return config.baseHalfSpreadCents;
  const utilization = Math.max(0, Math.min(1, currentExposureUsdc / config.maxExposureUsdc));
  return config.baseHalfSpreadCents + config.inventorySkewCents * utilization;
}
