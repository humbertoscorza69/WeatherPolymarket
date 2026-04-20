import { FillEvent } from "../types.js";

export interface InventoryPosition {
  conditionId: string;
  shares: number;
  avgEntryPrice: number;
  realizedPnl: number;
}

export class InventoryEngine {
  private readonly positions = new Map<string, InventoryPosition>();

  applyFill(fill: FillEvent): InventoryPosition {
    return fill.side === "BUY" ? this.addPosition(fill) : this.removePosition(fill);
  }

  addPosition(fill: FillEvent): InventoryPosition {
    const current = this.getPosition(fill.conditionId);
    const totalShares = current.shares + fill.shares;
    const avgEntryPrice =
      totalShares === 0
        ? 0
        : (current.avgEntryPrice * current.shares + fill.price * fill.shares) / totalShares;
    const next = {
      ...current,
      shares: totalShares,
      avgEntryPrice
    };
    this.positions.set(fill.conditionId, next);
    return next;
  }

  removePosition(fill: FillEvent): InventoryPosition {
    const current = this.getPosition(fill.conditionId);
    const soldShares = Math.min(current.shares, fill.shares);
    const realizedPnl = current.realizedPnl + (fill.price - current.avgEntryPrice) * soldShares;
    const nextShares = Math.max(0, current.shares - fill.shares);
    const next = {
      ...current,
      shares: nextShares,
      avgEntryPrice: nextShares === 0 ? 0 : current.avgEntryPrice,
      realizedPnl
    };
    this.positions.set(fill.conditionId, next);
    return next;
  }

  getPosition(conditionId: string): InventoryPosition {
    return (
      this.positions.get(conditionId) ?? {
        conditionId,
        shares: 0,
        avgEntryPrice: 0,
        realizedPnl: 0
      }
    );
  }

  hasPosition(conditionId: string): boolean {
    return this.getPosition(conditionId).shares > 0;
  }
}
