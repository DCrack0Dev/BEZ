"""
Offline training pipeline.

Flow:
1. Load historical trade data (engineered features + targets)
2. Train candidate model(s) offline
3. Track train/val losses and classification metrics
4. Evaluate trading metrics on unseen holdout
5. Compare against production (never auto-replace)
6. Save versioned candidate + registry entry
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from evaluate import evaluate_candidate_vs_production
from metrics import trading_metrics
from model import TradingModel
from registry import get_production_version, next_version, register_candidate

BASE_DIR = Path(__file__).parent


def load_training_data(data_path: str) -> List[Dict[str, Any]]:
    path = Path(data_path)
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict) and "samples" in data:
        return data["samples"]
    if not isinstance(data, list):
        raise ValueError("Training data must be a list of samples or {samples: [...]}")
    return data


def engineer_feature_vector(sample: Dict[str, Any]) -> np.ndarray:
    """
    Build a fixed-length feature vector from historical trade / feature-set data.
    Accepts either a pre-built `features` array or a feature object / FeatureSet dict.
    """
    if "features" in sample and isinstance(sample["features"], list):
        return np.asarray(sample["features"], dtype=float)

    feats = sample.get("entryFeatures") or sample.get("featureSet") or sample.get("features") or {}
    if isinstance(feats, list):
        return np.asarray(feats, dtype=float)

    # Engineered scalars from FeatureSet-like objects
    keys = [
        "trendStrength",
        "ema20DistancePips",
        "ema50DistancePips",
        "adxValue",
        "slope20",
        "slope50",
        "rsiStrength",
        "cciValue",
        "williamsR",
        "atrRatio",
        "bbPercentWidth",
        "bbPosition",
        "structureStrength",
        "prevCandleBodyPct",
        "riskPercent",
        "aiConfidence",
    ]
    direction_map = {"BULLISH": 1.0, "BEARISH": -1.0, "NEUTRAL": 0.0, "BUY": 1.0, "SELL": -1.0}
    session_map = {"ASIA": 0.0, "LONDON": 0.33, "NEWYORK": 0.66, "OVERLAP": 1.0}
    vol_map = {"LOW": 0.0, "MEDIUM": 0.33, "HIGH": 0.66, "EXTREME": 1.0}

    values: List[float] = []
    for k in keys:
        v = feats.get(k, sample.get(k, 0))
        try:
            values.append(float(v) if v is not None else 0.0)
        except (TypeError, ValueError):
            values.append(0.0)

    values.append(direction_map.get(str(feats.get("trendDirection", "NEUTRAL")).upper(), 0.0))
    values.append(direction_map.get(str(feats.get("momentumDirection", "NEUTRAL")).upper(), 0.0))
    values.append(session_map.get(str(feats.get("marketSession", "LONDON")).upper(), 0.33))
    values.append(vol_map.get(str(feats.get("volatility", "MEDIUM")).upper(), 0.33))
    values.append(1.0 if str(feats.get("fvgPresent", "NONE")).upper() != "NONE" else 0.0)
    values.append(1.0 if str(feats.get("orderBlockConfirmed", "NONE")).upper() != "NONE" else 0.0)
    values.append(1.0 if str(feats.get("liquiditySweep", "NONE")).upper() != "NONE" else 0.0)

    # Pad / truncate to 50 dims for model compatibility
    arr = np.asarray(values, dtype=float)
    if arr.shape[0] < 50:
        arr = np.pad(arr, (0, 50 - arr.shape[0]))
    elif arr.shape[0] > 50:
        arr = arr[:50]
    return arr


def prepare_dataset(
    samples: List[Dict[str, Any]],
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Returns X, y_probs, y_confidence, y_metrics, y_pnls
    Labels: 0=BUY, 1=SELL, 2=HOLD
    """
    features_list = []
    y_probs = []
    y_confidence = []
    y_metrics = []
    y_pnls = []

    for sample in samples:
        X_row = engineer_feature_vector(sample)
        target = sample.get("target") or {}
        direction = str(
            sample.get("direction")
            or target.get("direction")
            or sample.get("aiPrediction")
            or "HOLD"
        ).upper()

        win = bool(target.get("win", sample.get("outcome") == "WIN"))
        profit_pips = float(
            target.get("profit_pips")
            or target.get("profitPips")
            or sample.get("profitPips")
            or sample.get("profit_pips")
            or 0
        )
        duration = float(
            target.get("duration")
            or sample.get("durationMinutes")
            or 30
        )

        probs = np.zeros(3, dtype=float)
        if direction in ("BUY", "SELL"):
            dir_idx = 0 if direction == "BUY" else 1
            if win:
                probs[dir_idx] = 1.0
            else:
                # Losing directional trade — still label the intended action,
                # but lower confidence; also mix hold signal for hard negatives
                probs[dir_idx] = 0.3
                probs[2] = 0.7
        else:
            if win and profit_pips > 0:
                probs[0] = 1.0  # fallback: profitable unlabeled → buy
            else:
                probs[2] = 1.0

        conf = min(1.0, max(0.1, abs(profit_pips) / 20.0))
        risk = abs(min(profit_pips, 0)) if not win else abs(float(target.get("risk") or 10))
        reward = max(profit_pips, 0) if win else abs(float(target.get("reward") or 15))
        # Normalize metric heads to ~[0, 1] scale for stable MSE
        risk_n = min(risk / 50.0, 2.0)
        reward_n = min(reward / 50.0, 2.0)
        duration_n = min(duration / 120.0, 2.0)

        features_list.append(X_row)
        y_probs.append(probs)
        y_confidence.append(conf)
        y_metrics.append([risk_n, reward_n, duration_n])
        y_pnls.append(profit_pips)

    return (
        np.asarray(features_list, dtype=float),
        np.asarray(y_probs, dtype=float),
        np.asarray(y_confidence, dtype=float),
        np.asarray(y_metrics, dtype=float),
        np.asarray(y_pnls, dtype=float),
    )


def run_pipeline(
    data_path: str,
    version: Optional[str] = None,
    epochs: int = 80,
    batch_size: int = 32,
    lr: float = 0.001,
    holdout_ratio: float = 0.2,
    hidden_sizes: Optional[List[int]] = None,
    seed: int = 42,
) -> Dict[str, Any]:
    """
    Train candidate model(s) offline. Save all with versions.
    Never replaces the production model.
    """
    samples = load_training_data(data_path)
    if len(samples) < 4:
        return {
            "success": False,
            "error": f"Need at least 4 historical samples, got {len(samples)}",
            "auto_promoted": False,
        }

    X, y_probs, y_conf, y_metrics, y_pnls = prepare_dataset(samples)
    input_size = int(X.shape[1])

    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(X))
    holdout_n = max(1, int(len(X) * holdout_ratio))
    test_idx, train_idx = idx[:holdout_n], idx[holdout_n:]

    X_train, X_test = X[train_idx], X[test_idx]
    y_probs_train, y_probs_test = y_probs[train_idx], y_probs[test_idx]
    y_conf_train = y_conf[train_idx]
    y_metrics_train = y_metrics[train_idx]
    y_pnls_test = y_pnls[test_idx]
    y_labels_test = np.argmax(y_probs_test, axis=1)

    candidates_cfg = hidden_sizes or [128, 256]
    results = []
    best = None

    for hidden in candidates_cfg:
        ver = version if (version and len(candidates_cfg) == 1) else next_version()
        # If user passed a version and we train multiple, append hidden size
        if version and len(candidates_cfg) > 1:
            ver = f"{version}-h{hidden}"

        model = TradingModel(version=ver, input_size=input_size, hidden_size=hidden)
        training_results = model.train(
            X_train,
            y_probs_train,
            y_conf_train,
            y_metrics_train,
            epochs=epochs,
            batch_size=batch_size,
            lr=lr,
            val_split=0.2,
            seed=seed,
        )

        # Trading metrics on training labels (for tracking)
        train_label_pnls = y_pnls[train_idx]
        train_trade = trading_metrics(train_label_pnls.tolist())

        model.save(
            extra_metadata={
                "metrics": {
                    "training": training_results,
                    "train_trade_stats": {
                        k: v for k, v in train_trade.items() if k != "simulated_pnls"
                    },
                },
                "is_production": False,
                "status": "CANDIDATE",
            }
        )

        evaluation = evaluate_candidate_vs_production(
            ver, X_test, y_labels_test, y_pnls_test
        )
        recommendation = evaluation["comparison"]["recommend_deploy"]
        reason = evaluation["comparison"]["reason"]

        register_candidate(
            version=ver,
            metrics={
                "training_loss": training_results.get("final_train_loss"),
                "validation_loss": training_results.get("final_val_loss"),
                "accuracy": training_results.get("final_accuracy"),
                "precision": training_results.get("final_precision"),
                "recall": training_results.get("final_recall"),
                "f1": training_results.get("final_f1"),
                "profit_factor": evaluation["candidate_metrics"].get("profit_factor"),
                "sharpe_ratio": evaluation["candidate_metrics"].get("sharpe_ratio"),
                "max_drawdown": evaluation["candidate_metrics"].get("max_drawdown"),
                "win_rate": evaluation["candidate_metrics"].get("win_rate"),
                "average_rr": evaluation["candidate_metrics"].get("average_rr"),
                "stability": evaluation["candidate_metrics"].get("stability"),
                "trade_frequency": evaluation["candidate_metrics"].get("trade_frequency"),
            },
            training_run={
                "status": "COMPLETED",
                "epochs": epochs,
                "hidden_size": hidden,
                "train_samples": training_results.get("train_samples"),
                "val_samples": training_results.get("val_samples"),
                "holdout_samples": int(holdout_n),
                "history_summary": {
                    "final_train_loss": training_results.get("final_train_loss"),
                    "final_val_loss": training_results.get("final_val_loss"),
                    "final_f1": training_results.get("final_f1"),
                },
            },
            deployment_recommendation=recommendation,
            recommendation_reason=reason,
        )

        # Persist evaluation into metadata
        meta_path = BASE_DIR / "saved_models" / f"model_{ver}" / "metadata.json"
        if meta_path.exists():
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            meta["evaluation"] = {
                "candidate_metrics": evaluation["candidate_metrics"],
                "production_metrics": evaluation["production_metrics"],
                "comparison": evaluation["comparison"],
            }
            meta["deployment_recommendation"] = recommendation
            meta["recommendation_reason"] = reason
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, indent=2)

        candidate_result = {
            "version": ver,
            "hidden_size": hidden,
            "training_results": {
                k: v for k, v in training_results.items() if k != "history"
            },
            "history": training_results.get("history"),
            "evaluation": evaluation,
            "deployment_recommendation": recommendation,
            "recommendation_reason": reason,
            "auto_promoted": False,
        }
        results.append(candidate_result)

        score = (
            float(evaluation["candidate_metrics"].get("f1", 0))
            + float(evaluation["candidate_metrics"].get("profit_factor", 0)) * 0.1
        )
        if best is None or score > best["score"]:
            best = {"score": score, "result": candidate_result}

    return {
        "success": True,
        "production_version": get_production_version(),
        "candidates": results,
        "best_candidate": best["result"] if best else None,
        "auto_promoted": False,
        "message": (
            "Candidates trained and saved. Production model was NOT replaced. "
            "Promote manually only if recommendation is YES."
        ),
    }
