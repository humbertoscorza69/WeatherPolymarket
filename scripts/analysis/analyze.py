#!/usr/bin/env python3
"""
Analyze 900e's entry-selection patterns from the feature CSV built by
scripts/analysis/extract-features.mjs.

This script asks three questions and answers each with evidence, not
speculation:

  1. UNIVARIATE: for each feature, how does the distribution differ
     between markets 900e entered (label=1) and the siblings they
     passed on (label=0)?

  2. MATCHED-PAIR RANK: within each (snapshot_ts, city, date) group,
     what rank (by abs_dist / by yes_price / by no_price) does 900e's
     chosen bucket hold? If the rule is "always pick the closest", the
     rank should be concentrated at 1.

  3. MODEL FIT: a logistic regression AND a small decision tree, with
     honest train/test split. Report holdout accuracy and top coefs /
     printable tree.

Usage:
  python3 scripts/analysis/analyze.py
  python3 scripts/analysis/analyze.py --train-frac=0.7

Outputs:
  data/analysis/analyze-report.txt
"""
import argparse
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier, export_text
from sklearn.metrics import confusion_matrix, precision_score, recall_score, f1_score, roc_auc_score
from sklearn.preprocessing import StandardScaler

IN = Path("data/analysis/features-900e.csv")
OUT = Path("data/analysis/analyze-report.txt")

def pct(series, q):
    return series.quantile(q) if len(series) else float("nan")

def fmt_pctls(series, label):
    if len(series) == 0:
        return f"{label}: n=0"
    return (f"{label}: n={len(series):5d}  "
            f"mean={series.mean():7.3f}  "
            f"p10={pct(series, .1):7.3f}  "
            f"p50={pct(series, .5):7.3f}  "
            f"p90={pct(series, .9):7.3f}")

def univariate(df, lines):
    lines.append("\n=== UNIVARIATE (entered=1 vs passed=0) ===")
    features = [
        "obs_max_c", "obs_max_age_h", "current_temp_c", "ttr_h",
        "signed_dist_c", "abs_dist_c",
        "yes_price", "no_price", "yes_price_age_s", "no_price_age_s",
        "n_ticks_1h", "n_ticks_total", "group_size",
        "rank_by_abs_dist", "rank_by_yes_price", "rank_by_no_price",
    ]
    for f in features:
        if f not in df.columns:
            continue
        entered = df.loc[df.label == 1, f].dropna()
        passed  = df.loc[df.label == 0, f].dropna()
        lines.append(f"\n  {f}")
        lines.append(f"    {fmt_pctls(entered, 'entered')}")
        lines.append(f"    {fmt_pctls(passed,  'passed ')}")

    # Categorical: bucket_rel and bucket_kind
    for f in ["bucket_rel", "bucket_kind"]:
        if f not in df.columns:
            continue
        lines.append(f"\n  {f} (crosstab):")
        xt = pd.crosstab(df[f], df.label, margins=True)
        for line in str(xt).split("\n"):
            lines.append(f"    {line}")
        xt_norm = pd.crosstab(df[f], df.label, normalize="index")
        if 1 in xt_norm.columns:
            top = xt_norm[1].sort_values(ascending=False)
            lines.append(f"    ← P(entered | {f}) ranked:")
            for k, v in top.items():
                lines.append(f"       {k:<14} {v*100:5.1f}%")

def matched_pair_rank(df, lines):
    lines.append("\n=== MATCHED-PAIR RANK (how selective is 900e?) ===")
    entered = df[df.label == 1].copy()
    if not len(entered):
        lines.append("  no label=1 rows")
        return
    for col, label in [
        ("rank_by_abs_dist",   "rank of chosen market by |dist to obs_max|"),
        ("rank_by_yes_price",  "rank of chosen market by YES price (low→high)"),
        ("rank_by_no_price",   "rank of chosen market by NO price (low→high)"),
    ]:
        r = entered[col].dropna()
        if not len(r):
            continue
        lines.append(f"\n  {label}  (n={len(r)})")
        # Histogram: rank 1, 2, 3, ..., >10
        hist = r.value_counts().sort_index()
        total = len(r)
        for k, v in hist.items():
            if k > 10:
                continue
            bar = "█" * int(round(40 * v / total))
            lines.append(f"    rank {int(k):2d}: {v:4d}  ({v/total*100:5.1f}%)  {bar}")
        over10 = (r > 10).sum()
        if over10:
            lines.append(f"    rank>10: {over10}")

    # Share of entries that are top-1 by each ranker
    lines.append(f"\n  top-1 hit rates:")
    for col, label in [("rank_by_abs_dist", "closest to obs_max"),
                       ("rank_by_yes_price", "lowest YES price"),
                       ("rank_by_no_price",  "lowest NO price")]:
        r = entered[col].dropna()
        if not len(r):
            continue
        t1 = (r == 1).mean()
        t3 = (r <= 3).mean()
        lines.append(f"    {label:<25}: top-1={t1*100:5.1f}%  top-3={t3*100:5.1f}%")

    # By entered_side, is the selection rule different for YES vs NO?
    lines.append(f"\n  rank-by-abs-dist by entered_side:")
    for side, sub in entered.groupby("entered_side"):
        r = sub["rank_by_abs_dist"].dropna()
        if not len(r):
            continue
        t1 = (r == 1).mean()
        t3 = (r <= 3).mean()
        med = r.median()
        lines.append(f"    {side}: n={len(r)}  top-1={t1*100:5.1f}%  top-3={t3*100:5.1f}%  median={med:.1f}")

def build_model(df, lines, train_frac=0.7):
    lines.append(f"\n=== MODEL (logistic + tree, chronological {int(train_frac*100)}/{int((1-train_frac)*100)} split) ===")
    df = df.sort_values("snapshot_ts").reset_index(drop=True)
    cutoff = int(len(df) * train_frac)
    train = df.iloc[:cutoff]
    test = df.iloc[cutoff:]
    lines.append(f"  train rows: {len(train)}  (entered: {(train.label==1).sum()})")
    lines.append(f"  test  rows: {len(test)}   (entered: {(test.label==1).sum()})")

    feat_cols = [
        "obs_max_c", "obs_max_age_h", "ttr_h",
        "signed_dist_c", "abs_dist_c",
        "yes_price", "no_price",
        "n_ticks_1h", "n_ticks_total", "group_size",
        "rank_by_abs_dist", "rank_by_yes_price", "rank_by_no_price",
    ]
    # Dummy-encode bucket_rel
    rel_d = pd.get_dummies(df["bucket_rel"], prefix="rel", dummy_na=True).astype(float)
    X_full = pd.concat([df[feat_cols], rel_d], axis=1)
    cols = X_full.columns.tolist()

    X_train = X_full.iloc[:cutoff].copy()
    X_test  = X_full.iloc[cutoff:].copy()
    # Impute missing with train median (no lookahead: only using train)
    med = X_train.median(numeric_only=True)
    X_train = X_train.fillna(med)
    X_test  = X_test.fillna(med)
    y_train = train["label"].values.astype(int)
    y_test = test["label"].values.astype(int)

    # Scale for logistic
    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_test_s = scaler.transform(X_test)

    if y_train.sum() < 5 or y_test.sum() < 2:
        lines.append("  ⚠ too few label=1 samples for a meaningful fit")
        return

    # Logistic regression
    lr = LogisticRegression(max_iter=2000, class_weight="balanced", solver="liblinear")
    lr.fit(X_train_s, y_train)
    p_train = lr.predict_proba(X_train_s)[:, 1]
    p_test = lr.predict_proba(X_test_s)[:, 1]
    yhat_test = (p_test >= 0.5).astype(int)
    lines.append(f"\n  LOGISTIC REGRESSION")
    try:
        auc_train = roc_auc_score(y_train, p_train)
        auc_test = roc_auc_score(y_test, p_test)
        lines.append(f"    ROC-AUC: train={auc_train:.3f}  test={auc_test:.3f}")
    except ValueError as e:
        lines.append(f"    ROC-AUC: n/a ({e})")
    lines.append(f"    precision={precision_score(y_test, yhat_test, zero_division=0):.3f}  "
                 f"recall={recall_score(y_test, yhat_test, zero_division=0):.3f}  "
                 f"F1={f1_score(y_test, yhat_test, zero_division=0):.3f}")
    lines.append(f"    confusion (test):\n      {confusion_matrix(y_test, yhat_test)}")

    coefs = sorted(zip(cols, lr.coef_[0]), key=lambda x: -abs(x[1]))
    lines.append(f"    top coefficients (sign shows direction):")
    for c, w in coefs[:15]:
        lines.append(f"      {c:<28} {w:+8.4f}")

    # Decision tree for human-readable rule
    tree = DecisionTreeClassifier(max_depth=4, class_weight="balanced", random_state=42)
    tree.fit(X_train, y_train)
    yhat_tree = tree.predict(X_test)
    lines.append(f"\n  DECISION TREE (max_depth=4)")
    try:
        auc_tree = roc_auc_score(y_test, tree.predict_proba(X_test)[:, 1])
        lines.append(f"    ROC-AUC test: {auc_tree:.3f}")
    except ValueError as e:
        lines.append(f"    ROC-AUC: n/a ({e})")
    lines.append(f"    precision={precision_score(y_test, yhat_tree, zero_division=0):.3f}  "
                 f"recall={recall_score(y_test, yhat_tree, zero_division=0):.3f}  "
                 f"F1={f1_score(y_test, yhat_tree, zero_division=0):.3f}")
    lines.append(f"    tree (indent is depth):")
    try:
        rules = export_text(tree, feature_names=list(cols), max_depth=4)
        for ln in rules.split("\n"):
            lines.append(f"      {ln}")
    except Exception as e:
        lines.append(f"      (could not export: {e})")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-frac", type=float, default=0.7)
    args = ap.parse_args()

    if not IN.exists():
        print(f"missing {IN} — run scripts/analysis/extract-features.mjs first", file=sys.stderr)
        sys.exit(1)

    df = pd.read_csv(IN)
    lines = []
    lines.append(f"=== analyze-900e ===")
    lines.append(f"input: {IN}   rows: {len(df)}   label=1: {(df.label==1).sum()}")
    lines.append(f"groups (snapshot_ts,city,date): {df.groupby(['snapshot_ts','city','date']).ngroups}")
    lines.append(f"date range: {df.date.min()} → {df.date.max()}")

    univariate(df, lines)
    matched_pair_rank(df, lines)
    build_model(df, lines, train_frac=args.train_frac)

    txt = "\n".join(lines)
    print(txt)
    OUT.write_text(txt + "\n", encoding="utf-8")
    print(f"\n-> wrote report to {OUT}")

if __name__ == "__main__":
    main()
