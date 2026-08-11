"""
Offline evaluation of candidate models against production on unseen data.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from metrics import classification_metrics, compare_models, trading_metrics
from model import TradingModel
from registry import get_production_version


ACTION_MAP = {"BUY": 0, "SELL": 1, "HOLD": 2}


def _simulate_trade_pnls(
    predictions: List[Dict[str, Any]],
    true_labels: Sequence[int],
    true_pnls: Sequence[float],
    confidence_threshold: float = 0.45,
) -> Tuple[List[float], List[int]]:
    """
    Simulate trade outcomes:
    - If model predicts BUY/SELL with confidence >= threshold and matches label → use true pnl
    - If model takes a trade in wrong direction → flip sign of pnl (adverse)
    - HOLD → 0 pnl (no trade)
    """
    sim_pnls: List[float] = []
    pred_labels: List[int] = []

    for i, pred in enumerate(predictions):
        probs = [
            pred["buy_probability"],
            pred["sell_probability"],
            pred["hold_probability"],
        ]
        action = int(np.argmax(probs))
        conf = float(pred["confidence"])
        pred_labels.append(action)

        if action == 2 or conf < confidence_threshold:
            sim_pnls.append(0.0)
            continue

        true_action = int(true_labels[i])
        pnl = float(true_pnls[i])
        if true_action == action:
            sim_pnls.append(pnl)
        elif true_action == 2:
            # Label was hold but we traded — small penalty
            sim_pnls.append(-abs(pnl) * 0.25 if pnl != 0 else -1.0)
        else:
            # Wrong direction
            sim_pnls.append(-abs(pnl) if pnl != 0 else -5.0)

    return sim_pnls, pred_labels


def evaluate_model_on_data(
    model: TradingModel,
    X: np.ndarray,
    y_labels: np.ndarray,
    y_pnls: np.ndarray,
    confidence_threshold: float = 0.45,
) -> Dict[str, Any]:
    raw = model.predict(X)
    predictions = raw if isinstance(raw, list) else [raw]
    sim_pnls, pred_labels = _simulate_trade_pnls(
        predictions, y_labels, y_pnls, confidence_threshold
    )
    clf = classification_metrics(y_labels.tolist(), pred_labels)
    trade = trading_metrics(sim_pnls)
    return {
        **clf,
        **trade,
        "n_samples": int(len(y_labels)),
        "n_trades": int(sum(1 for p in sim_pnls if p != 0)),
        "predictions": predictions,
        "simulated_pnls": sim_pnls,
    }


def evaluate_candidate_vs_production(
    candidate_version: str,
    X_test: np.ndarray,
    y_labels: np.ndarray,
    y_pnls: np.ndarray,
    production_version: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Evaluate candidate on unseen holdout. Compare to production if available.
    Never promotes automatically.
    """
    candidate = TradingModel.load(candidate_version)
    cand_metrics = evaluate_model_on_data(candidate, X_test, y_labels, y_pnls)

    prod_version = production_version or get_production_version()
    comparison = None
    prod_metrics = None

    if prod_version and prod_version != candidate_version:
        try:
            production = TradingModel.load(prod_version)
            prod_metrics = evaluate_model_on_data(production, X_test, y_labels, y_pnls)
            comparison = compare_models(cand_metrics, prod_metrics)
        except (FileNotFoundError, RuntimeError, Exception) as exc:
            comparison = {
                "recommend_deploy": "MONITOR",
                "reason": f"Could not evaluate production {prod_version}: {exc}",
                "auto_promoted": False,
                "comparisons": {},
                "metrics_won": 0,
                "metrics_required": 0,
            }
    else:
        # No production baseline — recommend monitor, not auto-deploy
        comparison = {
            "recommend_deploy": "MONITOR",
            "reason": "No production baseline — candidate saved but not auto-deployed",
            "auto_promoted": False,
            "comparisons": {},
            "metrics_won": 0,
            "metrics_required": 0,
        }

    # Strip bulky arrays from returned metrics for JSON
    cand_summary = {k: v for k, v in cand_metrics.items() if k not in ("predictions", "simulated_pnls")}
    prod_summary = None
    if prod_metrics:
        prod_summary = {
            k: v for k, v in prod_metrics.items() if k not in ("predictions", "simulated_pnls")
        }

    return {
        "candidate_version": candidate_version,
        "production_version": prod_version,
        "candidate_metrics": cand_summary,
        "production_metrics": prod_summary,
        "comparison": comparison,
        "auto_promoted": False,
        "equity_curve": _equity_from_pnls(cand_metrics.get("simulated_pnls", [])),
    }


def _equity_from_pnls(pnls: Sequence[float], start: float = 10000.0) -> List[float]:
    eq = [start]
    for p in pnls:
        eq.append(eq[-1] + float(p))
    return eq
