#!/usr/bin/env python3
"""
Summarize one or more universe-backtest CSVs. Complements the built-in
report with per-city PnL, entry-price × side heatmap, and hold-time vs
pnl scatter-equivalents (text).

Usage:
  python scripts/analysis/summarize-backtest.py data/analysis/universe-backtest-*.csv
"""
import sys
import glob
from pathlib import Path

import pandas as pd

def summarize(path):
    df = pd.read_csv(path)
    if not len(df):
        print(f"\n=== {path} · 0 trades ===")
        return
    total_pnl = df.pnl.sum()
    wr = (df.pnl > 0.01).mean() * 100
    print(f"\n=== {Path(path).name} · n={len(df)}  WR={wr:.1f}%  PnL=${total_pnl:.2f} ===")

    # Per-side
    print("by side:")
    for side, sub in df.groupby("side"):
        print(f"  {side}: n={len(sub):5d}  WR={(sub.pnl > 0.01).mean()*100:5.1f}%  pnl=${sub.pnl.sum():9.2f}  avg=${sub.pnl.mean():6.3f}")

    # Per exit reason
    print("by exit reason:")
    for r, sub in df.groupby("exitReason"):
        print(f"  {r:<15} n={len(sub):5d}  WR={(sub.pnl > 0.01).mean()*100:5.1f}%  pnl=${sub.pnl.sum():9.2f}")

    # Top / bottom cities by PnL (sample >= 5)
    city = df.groupby("city").agg(n=("pnl", "size"), pnl=("pnl", "sum"), wr=("pnl", lambda x: (x > 0.01).mean()*100)).reset_index()
    city = city[city.n >= 5].sort_values("pnl")
    print("worst 10 cities (n>=5):")
    for _, r in city.head(10).iterrows():
        print(f"  {r.city:<18} n={int(r.n):3d}  WR={r.wr:5.1f}%  pnl=${r.pnl:8.2f}")
    print("best 10 cities (n>=5):")
    for _, r in city.tail(10).iloc[::-1].iterrows():
        print(f"  {r.city:<18} n={int(r.n):3d}  WR={r.wr:5.1f}%  pnl=${r.pnl:8.2f}")

    # Entry price × side grid
    bins = [0, 0.1, 0.3, 0.5, 0.7, 0.85, 0.95, 1.01]
    df["entry_bin"] = pd.cut(df.entryPrice, bins=bins, include_lowest=True)
    print("entry_price × side (n / pnl):")
    for (side, b), sub in df.groupby(["side", "entry_bin"], observed=True):
        if not len(sub): continue
        wr = (sub.pnl > 0.01).mean() * 100
        print(f"  {side:<3} {str(b):<15} n={len(sub):5d}  WR={wr:5.1f}%  pnl=${sub.pnl.sum():9.2f}")

    # PnL by hold time
    print("by hold time:")
    bins = [0, 15, 30, 60, 120, 240, 99999]
    df["hold_bin"] = pd.cut(df.holdMin, bins=bins)
    for hb, sub in df.groupby("hold_bin", observed=True):
        if not len(sub): continue
        wr = (sub.pnl > 0.01).mean() * 100
        print(f"  {str(hb):<15} n={len(sub):5d}  WR={wr:5.1f}%  pnl=${sub.pnl.sum():9.2f}")

def main():
    if len(sys.argv) < 2:
        print("usage: summarize-backtest.py <csv> [csv ...]")
        sys.exit(1)
    paths = []
    for a in sys.argv[1:]:
        paths.extend(glob.glob(a))
    for p in sorted(paths):
        summarize(p)

if __name__ == "__main__":
    main()
