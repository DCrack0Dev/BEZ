"""
Training & trading evaluation metrics.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

import numpy as np


def _safe_div(num: float, den: float, default: float = 0.0) -> float:
    if den == 0 or not np.isfinite(den):
        return default
    return float(num / den)


def classification_metrics(
    y_true: Sequence[int],
    y_pred: Sequence[int],
    num_classes: int = 3,
) -> Dict[str, float]:
    """Accuracy, macro precision/recall/F1 for multi-class labels."""
    y_true_arr = np.asarray(y_true, dtype=int)
    y_pred_arr = np.asarray(y_pred, dtype=int)
    n = len(y_true_arr)
    if n == 0:
        return {
            "accuracy": 0.0,
            "precision": 0.0,
            "recall": 0.0,
            "f1": 0.0,
        }

    accuracy = float(np.mean(y_true_arr == y_pred_arr))
    precisions, recalls, f1s = [], [], []

    for c in range(num_classes):
        tp = int(np.sum((y_pred_arr == c) & (y_true_arr == c)))
        fp = int(np.sum((y_pred_arr == c) & (y_true_arr != c)))
        fn = int(np.sum((y_pred_arr != c) & (y_true_arr == c)))
        p = _safe_div(tp, tp + fp)
        r = _safe_div(tp, tp + fn)
        f1 = _safe_div(2 * p * r, p + r)
        precisions.append(p)
        recalls.append(r)
        f1s.append(f1)

    return {
        "accuracy": accuracy,
        "precision": float(np.mean(precisions)),
        "recall": float(np.mean(recalls)),
        "f1": float(np.mean(f1s)),
    }


def profit_factor(pnls: Sequence[float]) -> float:
    gains = sum(p for p in pnls if p > 0)
    losses = abs(sum(p for p in pnls if p < 0))
    if losses == 0:
        return float("inf") if gains > 0 else 0.0
    return float(gains / losses)


def sharpe_ratio(returns: Sequence[float], risk_free: float = 0.0) -> float:
    arr = np.asarray(returns, dtype=float)
    if len(arr) < 2:
        return 0.0
    excess = arr - risk_free
    std = float(np.std(excess, ddof=1))
    if std == 0 or not np.isfinite(std):
        return 0.0
    return float(np.mean(excess) / std * np.sqrt(len(arr)))


def max_drawdown(equity_curve: Sequence[float]) -> float:
    """Maximum drawdown as a fraction of peak (0–1)."""
    if not equity_curve:
        return 0.0
    eq = np.asarray(equity_curve, dtype=float)
    peak = np.maximum.accumulate(eq)
    dd = np.where(peak > 0, (peak - eq) / peak, 0.0)
    return float(np.max(dd)) if len(dd) else 0.0


def build_equity_curve(pnls: Sequence[float], start: float = 10000.0) -> List[float]:
    equity = [float(start)]
    for p in pnls:
        equity.append(equity[-1] + float(p))
    return equity


def win_rate(pnls: Sequence[float]) -> float:
    closed = [p for p in pnls if p != 0]
    if not closed:
        return 0.0
    return float(sum(1 for p in closed if p > 0) / len(closed))


def average_rr(wins: Sequence[float], losses: Sequence[float]) -> float:
    avg_win = float(np.mean(wins)) if wins else 0.0
    avg_loss = float(abs(np.mean(losses))) if losses else 0.0
    return _safe_div(avg_win, avg_loss)


def stability_score(pnls: Sequence[float], window: int = 20) -> float:
    """
    Stability in [0, 1]: inverse of rolling win-rate volatility.
    Higher = more consistent.
    """
    arr = np.asarray(pnls, dtype=float)
    if len(arr) < window * 2:
        # Fall back to inverse CV of returns
        if len(arr) < 2:
            return 0.0
        std = float(np.std(arr))
        mean_abs = float(np.mean(np.abs(arr))) + 1e-9
        return float(max(0.0, min(1.0, 1.0 - std / mean_abs)))

    rolling_wr = []
    for i in range(window, len(arr) + 1):
        chunk = arr[i - window : i]
        rolling_wr.append(win_rate(chunk.tolist()))
    vol = float(np.std(rolling_wr))
    return float(max(0.0, min(1.0, 1.0 - vol * 2)))


def trading_metrics(pnls: Sequence[float], starting_equity: float = 10000.0) -> Dict[str, float]:
    pnls_list = [float(p) for p in pnls]
    equity = build_equity_curve(pnls_list, starting_equity)
    wins = [p for p in pnls_list if p > 0]
    losses = [p for p in pnls_list if p < 0]
    pf = profit_factor(pnls_list)
    if not np.isfinite(pf):
        pf = 99.0  # cap for serialization

    return {
        "win_rate": win_rate(pnls_list),
        "profit_factor": pf,
        "average_rr": average_rr(wins, losses),
        "max_drawdown": max_drawdown(equity),
        "sharpe_ratio": sharpe_ratio(pnls_list),
        "trade_frequency": float(len(pnls_list)),
        "stability": stability_score(pnls_list),
        "total_pnl": float(sum(pnls_list)),
        "avg_pnl": float(np.mean(pnls_list)) if pnls_list else 0.0,
    }


def compare_models(
    candidate: Dict[str, float],
    production: Dict[str, float],
    margins: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """
    Compare candidate vs production on key trading metrics.
    Recommend deploy only when candidate consistently outperforms.
    """
    margins = margins or {
        "win_rate": 0.02,
        "profit_factor": 0.05,
        "average_rr": 0.05,
        "max_drawdown": 0.0,  # lower is better — candidate must be <= prod
        "trade_frequency": 0.0,  # informational
        "stability": 0.02,
    }

    keys_higher_better = ["win_rate", "profit_factor", "average_rr", "stability"]
    keys_lower_better = ["max_drawdown"]

    comparisons: Dict[str, Any] = {}
    wins = 0
    required = 0

    for key in keys_higher_better:
        required += 1
        c_val = float(candidate.get(key, 0))
        p_val = float(production.get(key, 0))
        margin = margins.get(key, 0)
        beats = c_val >= p_val + margin
        comparisons[key] = {
            "candidate": c_val,
            "production": p_val,
            "delta": c_val - p_val,
            "beats": beats,
        }
        if beats:
            wins += 1

    for key in keys_lower_better:
        required += 1
        c_val = float(candidate.get(key, 0))
        p_val = float(production.get(key, 1))
        beats = c_val <= p_val  # equal or better drawdown
        comparisons[key] = {
            "candidate": c_val,
            "production": p_val,
            "delta": c_val - p_val,
            "beats": beats,
        }
        if beats:
            wins += 1

    # Trade frequency — report only
    comparisons["trade_frequency"] = {
        "candidate": float(candidate.get("trade_frequency", 0)),
        "production": float(production.get("trade_frequency", 0)),
        "delta": float(candidate.get("trade_frequency", 0))
        - float(production.get("trade_frequency", 0)),
        "beats": None,
    }

    consistently_outperforms = wins == required and required > 0
    recommend = "YES" if consistently_outperforms else "NO"
    reason = (
        f"Candidate beats production on {wins}/{required} core metrics"
        if consistently_outperforms
        else f"Candidate only beats production on {wins}/{required} core metrics — do not deploy"
    )

    return {
        "comparisons": comparisons,
        "metrics_won": wins,
        "metrics_required": required,
        "recommend_deploy": recommend,
        "reason": reason,
        "auto_promoted": False,  # never auto-replace production
    }
