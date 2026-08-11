"""
Backtesting engine — replay historical data through a model, export reports.
"""

from __future__ import annotations

import csv
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from metrics import (
    build_equity_curve,
    max_drawdown,
    profit_factor,
    sharpe_ratio,
    trading_metrics,
    win_rate,
)
from model import TradingModel
from registry import get_production_version

BASE_DIR = Path(__file__).parent
REPORTS_DIR = BASE_DIR / "reports"
REPORTS_DIR.mkdir(exist_ok=True)


def _month_key(ts: Any) -> str:
    if ts is None:
        return "unknown"
    if isinstance(ts, (int, float)):
        # ms or s
        sec = ts / 1000 if ts > 1e12 else ts
        return datetime.utcfromtimestamp(sec).strftime("%Y-%m")
    try:
        return str(ts)[:7]
    except Exception:
        return "unknown"


def load_historical_samples(path: str) -> List[Dict[str, Any]]:
    p = Path(path)
    with open(p, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict) and "samples" in data:
        return data["samples"]
    if isinstance(data, list):
        return data
    raise ValueError("Historical data must be a list or {samples: [...]}")


def features_from_sample(sample: Dict[str, Any]) -> np.ndarray:
    if isinstance(sample.get("features"), list):
        arr = np.asarray(sample["features"], dtype=float)
    else:
        feats = sample.get("entryFeatures") or sample.get("featureSet") or {}
        if isinstance(feats, list):
            arr = np.asarray(feats, dtype=float)
        elif isinstance(feats.get("normalizedFeatures"), list):
            arr = np.asarray(feats["normalizedFeatures"], dtype=float)
        else:
            arr = np.zeros(50, dtype=float)
    if arr.shape[0] < 50:
        arr = np.pad(arr, (0, 50 - arr.shape[0]))
    return arr[:50]


def true_pnl(sample: Dict[str, Any]) -> float:
    target = sample.get("target") or {}
    return float(
        target.get("profit_pips")
        or target.get("profitPips")
        or sample.get("profitPips")
        or sample.get("profit_pips")
        or 0
    )


def true_direction(sample: Dict[str, Any]) -> str:
    d = (
        sample.get("direction")
        or (sample.get("target") or {}).get("direction")
        or sample.get("aiPrediction")
        or "HOLD"
    )
    return str(d).upper()


def simulate_trade(
    prediction: Dict[str, Any],
    sample: Dict[str, Any],
    confidence_threshold: float = 0.45,
) -> Optional[Dict[str, Any]]:
    """
    If model takes a trade, simulate PnL using historical outcome when direction matches.
    """
    probs = [
        prediction["buy_probability"],
        prediction["sell_probability"],
        prediction["hold_probability"],
    ]
    action_idx = int(np.argmax(probs))
    action = ["BUY", "SELL", "HOLD"][action_idx]
    conf = float(prediction["confidence"])
    if action == "HOLD" or conf < confidence_threshold:
        return None

    hist_dir = true_direction(sample)
    pnl = true_pnl(sample)
    if hist_dir == action:
        sim_pnl = pnl
    elif hist_dir == "HOLD":
        sim_pnl = -abs(pnl) * 0.25 if pnl else -1.0
    else:
        sim_pnl = -abs(pnl) if pnl else -5.0

    return {
        "action": action,
        "confidence": conf,
        "pnl_pips": float(sim_pnl),
        "historical_direction": hist_dir,
        "timestamp": sample.get("timestamp")
        or sample.get("entryTimestamp")
        or sample.get("createdAt"),
        "symbol": sample.get("symbol", "UNKNOWN"),
    }


def monthly_returns(trades: Sequence[Dict[str, Any]]) -> Dict[str, float]:
    by_month: Dict[str, float] = defaultdict(float)
    for t in trades:
        by_month[_month_key(t.get("timestamp"))] += float(t["pnl_pips"])
    return dict(sorted(by_month.items()))


def trade_distribution(trades: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    buys = sum(1 for t in trades if t["action"] == "BUY")
    sells = sum(1 for t in trades if t["action"] == "SELL")
    pnls = [float(t["pnl_pips"]) for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    # Histogram bins
    bins = [-50, -30, -15, -5, 0, 5, 15, 30, 50, 100]
    hist = {f"{bins[i]}:{bins[i+1]}": 0 for i in range(len(bins) - 1)}
    hist["lt_-50"] = 0
    hist["gt_100"] = 0
    for p in pnls:
        placed = False
        for i in range(len(bins) - 1):
            if bins[i] <= p < bins[i + 1]:
                hist[f"{bins[i]}:{bins[i+1]}"] += 1
                placed = True
                break
        if not placed:
            if p < bins[0]:
                hist["lt_-50"] += 1
            else:
                hist["gt_100"] += 1

    return {
        "buy_count": buys,
        "sell_count": sells,
        "win_count": len(wins),
        "loss_count": len(losses),
        "avg_win": float(np.mean(wins)) if wins else 0.0,
        "avg_loss": float(np.mean(losses)) if losses else 0.0,
        "pnl_histogram": hist,
        "by_symbol": _count_by(trades, "symbol"),
        "by_action": {"BUY": buys, "SELL": sells},
    }


def _count_by(trades: Sequence[Dict[str, Any]], key: str) -> Dict[str, int]:
    out: Dict[str, int] = defaultdict(int)
    for t in trades:
        out[str(t.get(key, "UNKNOWN"))] += 1
    return dict(out)


def run_backtest(
    data_path: str,
    model_version: Optional[str] = None,
    confidence_threshold: float = 0.45,
    starting_equity: float = 10000.0,
    export: bool = True,
) -> Dict[str, Any]:
    version = model_version or get_production_version() or "v1.1"
    samples = load_historical_samples(data_path)
    model = TradingModel.load(version)

    trades: List[Dict[str, Any]] = []
    for sample in samples:
        X = features_from_sample(sample)
        pred = model.predict(X)
        if isinstance(pred, list):
            pred = pred[0]
        trade = simulate_trade(pred, sample, confidence_threshold)
        if trade:
            trades.append(trade)

    pnls = [t["pnl_pips"] for t in trades]
    metrics = trading_metrics(pnls, starting_equity)
    equity = build_equity_curve(pnls, starting_equity)
    months = monthly_returns(trades)
    dist = trade_distribution(trades)

    report = {
        "success": True,
        "model_version": version,
        "data_path": str(data_path),
        "n_samples": len(samples),
        "n_trades": len(trades),
        "win_rate": metrics["win_rate"],
        "profit_factor": metrics["profit_factor"],
        "sharpe_ratio": metrics["sharpe_ratio"],
        "max_drawdown": metrics["max_drawdown"],
        "total_pnl": metrics["total_pnl"],
        "avg_pnl": metrics["avg_pnl"],
        "stability": metrics["stability"],
        "average_rr": metrics["average_rr"],
        "monthly_returns": months,
        "trade_distribution": dist,
        "equity_curve": equity,
        "trades": trades,
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }

    if export:
        paths = export_report(report)
        report["report_paths"] = paths

    return report


def export_report(report: Dict[str, Any]) -> Dict[str, str]:
    stamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    version = report.get("model_version", "unknown").replace(".", "_")
    base = REPORTS_DIR / f"backtest_{version}_{stamp}"
    json_path = Path(str(base) + ".json")
    csv_path = Path(str(base) + "_trades.csv")
    summary_path = Path(str(base) + "_summary.csv")

    # Full JSON (without huge duplication — keep trades)
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, default=str)

    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["action", "confidence", "pnl_pips", "historical_direction", "timestamp", "symbol"],
        )
        writer.writeheader()
        for t in report.get("trades", []):
            writer.writerow(t)

    with open(summary_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["metric", "value"])
        for key in (
            "model_version",
            "n_samples",
            "n_trades",
            "win_rate",
            "profit_factor",
            "sharpe_ratio",
            "max_drawdown",
            "total_pnl",
            "average_rr",
            "stability",
        ):
            writer.writerow([key, report.get(key)])
        writer.writerow([])
        writer.writerow(["month", "return_pips"])
        for month, ret in (report.get("monthly_returns") or {}).items():
            writer.writerow([month, ret])

    return {
        "json": str(json_path),
        "trades_csv": str(csv_path),
        "summary_csv": str(summary_path),
    }


def main():
    import sys

    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python backtest.py <data_path> [model_version]"}))
        return
    data_path = sys.argv[1]
    version = sys.argv[2] if len(sys.argv) > 2 else None
    try:
        result = run_backtest(data_path, version)
        # Compact stdout for Node — drop full trades list optionally
        compact = {k: v for k, v in result.items() if k != "trades"}
        compact["n_trades_exported"] = result.get("n_trades")
        print(json.dumps(compact, default=str))
    except Exception as e:
        import traceback

        print(json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc()}))


if __name__ == "__main__":
    main()
