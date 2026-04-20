export interface ProbabilityPoint {
  temperatureC: number;
  probability: number;
}

export function forecastToProbabilities(
  forecastTempC: number,
  uncertaintyC: number,
  outcomesC: number[]
): ProbabilityPoint[] {
  if (!Number.isFinite(forecastTempC)) throw new Error("forecastTempC must be finite");
  if (!Number.isFinite(uncertaintyC) || uncertaintyC <= 0) throw new Error("uncertaintyC must be > 0");
  if (outcomesC.length === 0) throw new Error("outcomesC must not be empty");

  const weights = outcomesC.map((temperatureC) => {
    const z = (temperatureC - forecastTempC) / uncertaintyC;
    return { temperatureC, weight: Math.exp(-0.5 * z * z) };
  });

  const total = weights.reduce((sum, point) => sum + point.weight, 0);
  if (total <= 0) throw new Error("probability distribution total was zero");

  return weights.map((point) => ({
    temperatureC: point.temperatureC,
    probability: point.weight / total
  }));
}

export function roundPrice(value: number): number {
  return Math.round(value * 100) / 100;
}
