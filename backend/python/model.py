"""
PyTorch Neural Network for Trading Signal Prediction
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import joblib
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from sklearn.preprocessing import StandardScaler

from metrics import classification_metrics

BASE_DIR = Path(__file__).parent
MODELS_DIR = BASE_DIR / "saved_models"
SCALERS_DIR = BASE_DIR / "saved_scalers"
MODELS_DIR.mkdir(exist_ok=True)
SCALERS_DIR.mkdir(exist_ok=True)


class TradingNN(nn.Module):
    """
    Input: normalized market features
    Output: action probs (buy/sell/hold), confidence, risk/reward/duration
    """

    def __init__(self, input_size: int = 50, hidden_size: int = 256, dropout: float = 0.3):
        super().__init__()
        self.shared = nn.Sequential(
            nn.Linear(input_size, hidden_size),
            nn.BatchNorm1d(hidden_size),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_size, hidden_size // 2),
            nn.BatchNorm1d(hidden_size // 2),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_size // 2, hidden_size // 4),
            nn.BatchNorm1d(hidden_size // 4),
            nn.ReLU(),
            nn.Dropout(dropout),
        )
        self.action_head = nn.Linear(hidden_size // 4, 3)
        self.confidence_head = nn.Sequential(
            nn.Linear(hidden_size // 4, 1),
            nn.Sigmoid(),
        )
        self.metrics_head = nn.Linear(hidden_size // 4, 3)

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        shared = self.shared(x)
        actions = self.action_head(shared)  # logits — Softmax applied in loss / predict
        confidence = self.confidence_head(shared)
        metrics = self.metrics_head(shared)
        return actions, confidence, metrics


class TradingModel:
    """Wrapper with training, versioning, and inference."""

    def __init__(self, version: str = "v1.0", input_size: int = 50, hidden_size: int = 256):
        self.version = version
        self.input_size = input_size
        self.hidden_size = hidden_size
        self.model = TradingNN(input_size=input_size, hidden_size=hidden_size)
        self.scaler: Optional[StandardScaler] = None
        self.history: Dict[str, List[float]] = {
            "train_loss": [],
            "val_loss": [],
            "val_accuracy": [],
            "val_precision": [],
            "val_recall": [],
            "val_f1": [],
        }

    def fit_scaler(self, X: np.ndarray) -> np.ndarray:
        self.scaler = StandardScaler()
        return self.scaler.fit_transform(X)

    def transform(self, X: np.ndarray) -> np.ndarray:
        if self.scaler is None:
            return X
        return self.scaler.transform(X)

    def train(
        self,
        X: np.ndarray,
        y_probs: np.ndarray,
        y_confidence: np.ndarray,
        y_metrics: np.ndarray,
        epochs: int = 100,
        batch_size: int = 32,
        lr: float = 0.001,
        val_split: float = 0.2,
        seed: int = 42,
    ) -> Dict[str, Any]:
        """
        Train offline with train/validation split.
        Tracks training loss, validation loss, accuracy, precision, recall, F1.
        """
        rng = np.random.default_rng(seed)
        n = X.shape[0]
        indices = rng.permutation(n)
        val_n = max(1, int(n * val_split)) if n > 5 else 0

        if val_n > 0:
            val_idx = indices[:val_n]
            train_idx = indices[val_n:]
        else:
            val_idx = np.array([], dtype=int)
            train_idx = indices

        X_train, X_val = X[train_idx], X[val_idx] if val_n else None
        y_probs_train = y_probs[train_idx]
        y_conf_train = y_confidence[train_idx]
        y_metrics_train = y_metrics[train_idx]

        # Fit scaler on training fold only
        X_train = self.fit_scaler(X_train)
        if X_val is not None and len(X_val):
            X_val = self.transform(X_val)

        optimizer = optim.Adam(self.model.parameters(), lr=lr, weight_decay=1e-5)
        action_loss_fn = nn.CrossEntropyLoss()
        confidence_loss_fn = nn.MSELoss()
        metrics_loss_fn = nn.MSELoss()

        X_t = torch.tensor(X_train, dtype=torch.float32)
        y_probs_t = torch.tensor(y_probs_train, dtype=torch.float32)
        y_conf_t = torch.tensor(y_conf_train, dtype=torch.float32).view(-1, 1)
        y_metrics_t = torch.tensor(y_metrics_train, dtype=torch.float32)

        X_val_t = (
            torch.tensor(X_val, dtype=torch.float32)
            if X_val is not None and len(X_val)
            else None
        )
        y_val_labels = (
            torch.argmax(torch.tensor(y_probs[val_idx], dtype=torch.float32), dim=1)
            if val_n
            else None
        )

        best_val_loss = float("inf")
        best_state = None

        for epoch in range(epochs):
            self.model.train()
            permutation = torch.randperm(X_t.size(0))
            total_loss = 0.0
            batches = 0

            for i in range(0, X_t.size(0), batch_size):
                optimizer.zero_grad()
                idx = permutation[i : i + batch_size]
                if idx.numel() < 2:
                    continue  # BatchNorm needs >1
                batch_x = X_t[idx]
                batch_action = y_probs_t[idx]
                batch_conf = y_conf_t[idx]
                batch_metrics = y_metrics_t[idx]

                pred_actions, pred_conf, pred_metrics = self.model(batch_x)
                loss_action = action_loss_fn(pred_actions, torch.argmax(batch_action, dim=1))
                loss_conf = confidence_loss_fn(pred_conf, batch_conf)
                loss_metrics = metrics_loss_fn(pred_metrics, batch_metrics)
                loss = loss_action + 0.5 * loss_conf + 0.25 * loss_metrics
                loss.backward()
                optimizer.step()
                total_loss += loss.item()
                batches += 1

            avg_train = total_loss / max(batches, 1)
            self.history["train_loss"].append(avg_train)

            val_stats = self._validate(
                X_val_t,
                y_val_labels,
                y_probs[val_idx] if val_n else None,
                y_confidence[val_idx] if val_n else None,
                y_metrics[val_idx] if val_n else None,
                action_loss_fn,
                confidence_loss_fn,
                metrics_loss_fn,
            )
            self.history["val_loss"].append(val_stats["val_loss"])
            self.history["val_accuracy"].append(val_stats["accuracy"])
            self.history["val_precision"].append(val_stats["precision"])
            self.history["val_recall"].append(val_stats["recall"])
            self.history["val_f1"].append(val_stats["f1"])

            if val_stats["val_loss"] < best_val_loss:
                best_val_loss = val_stats["val_loss"]
                best_state = {k: v.cpu().clone() for k, v in self.model.state_dict().items()}

            if (epoch + 1) % 10 == 0 or epoch == 0:
                print(
                    f"Epoch {epoch + 1}/{epochs} "
                    f"train_loss={avg_train:.6f} "
                    f"val_loss={val_stats['val_loss']:.6f} "
                    f"acc={val_stats['accuracy']:.4f} "
                    f"f1={val_stats['f1']:.4f}"
                )

        if best_state is not None:
            self.model.load_state_dict(best_state)

        return {
            "final_train_loss": self.history["train_loss"][-1] if self.history["train_loss"] else 0,
            "final_val_loss": self.history["val_loss"][-1] if self.history["val_loss"] else 0,
            "final_accuracy": self.history["val_accuracy"][-1] if self.history["val_accuracy"] else 0,
            "final_precision": self.history["val_precision"][-1] if self.history["val_precision"] else 0,
            "final_recall": self.history["val_recall"][-1] if self.history["val_recall"] else 0,
            "final_f1": self.history["val_f1"][-1] if self.history["val_f1"] else 0,
            "best_val_loss": best_val_loss if best_val_loss != float("inf") else 0,
            "epochs": epochs,
            "train_samples": int(len(train_idx)),
            "val_samples": int(val_n),
            "history": self.history,
        }

    def _validate(
        self,
        X_val_t: Optional[torch.Tensor],
        y_val_labels: Optional[torch.Tensor],
        y_probs_val,
        y_conf_val,
        y_metrics_val,
        action_loss_fn,
        confidence_loss_fn,
        metrics_loss_fn,
    ) -> Dict[str, float]:
        empty = {
            "val_loss": 0.0,
            "accuracy": 0.0,
            "precision": 0.0,
            "recall": 0.0,
            "f1": 0.0,
        }
        if X_val_t is None or y_val_labels is None or X_val_t.size(0) < 2:
            return empty

        self.model.eval()
        with torch.no_grad():
            pred_actions, pred_conf, pred_metrics = self.model(X_val_t)
            y_probs_t = torch.tensor(y_probs_val, dtype=torch.float32)
            y_conf_t = torch.tensor(y_conf_val, dtype=torch.float32).view(-1, 1)
            y_metrics_t = torch.tensor(y_metrics_val, dtype=torch.float32)

            loss = (
                action_loss_fn(pred_actions, y_val_labels)
                + 0.5 * confidence_loss_fn(pred_conf, y_conf_t)
                + 0.25 * metrics_loss_fn(pred_metrics, y_metrics_t)
            )
            pred_labels = torch.argmax(torch.softmax(pred_actions, dim=1), dim=1).numpy()
            true_labels = y_val_labels.numpy()
            clf = classification_metrics(true_labels, pred_labels)

        return {
            "val_loss": float(loss.item()),
            **clf,
        }

    def predict(self, X: np.ndarray) -> Dict[str, Any]:
        self.model.eval()
        if len(X.shape) == 1:
            X = X.reshape(1, -1)
        if self.scaler is not None:
            X = self.scaler.transform(X)

        with torch.no_grad():
            X_tensor = torch.tensor(X, dtype=torch.float32)
            # BatchNorm needs eval mode (already set) — single sample OK in eval
            pred_actions, pred_confidence, pred_metrics = self.model(X_tensor)
            probs = torch.softmax(pred_actions, dim=1).numpy()
            confidence_np = pred_confidence.numpy().flatten()
            metrics_np = pred_metrics.numpy()

            predictions = []
            for i in range(probs.shape[0]):
                predictions.append(
                    {
                        "buy_probability": float(probs[i][0]),
                        "sell_probability": float(probs[i][1]),
                        "hold_probability": float(probs[i][2]),
                        "confidence": float(confidence_np[i]),
                        "expected_risk": float(metrics_np[i][0]),
                        "expected_reward": float(metrics_np[i][1]),
                        "expected_duration": float(metrics_np[i][2]),
                    }
                )
            return predictions[0] if len(predictions) == 1 else predictions

    def save(self, extra_metadata: Optional[Dict[str, Any]] = None):
        model_dir = MODELS_DIR / f"model_{self.version}"
        model_dir.mkdir(exist_ok=True)
        torch.save(self.model.state_dict(), model_dir / "model_weights.pth")

        metadata: Dict[str, Any] = {
            "version": self.version,
            "input_size": self.input_size,
            "hidden_size": self.hidden_size,
            "saved_at": str(np.datetime64("now")),
            "is_production": False,
        }
        if extra_metadata:
            metadata.update(extra_metadata)

        with open(model_dir / "metadata.json", "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2)

        if self.scaler is not None:
            joblib.dump(self.scaler, SCALERS_DIR / f"scaler_{self.version}.joblib")

        with open(model_dir / "history.json", "w", encoding="utf-8") as f:
            json.dump(self.history, f, indent=2)

        print(f"Saved model version {self.version} to {model_dir}")

    @staticmethod
    def _normalize_state_dict(state: Dict[str, Any]) -> Dict[str, Any]:
        """Map legacy Sequential head keys (action_head.0.*) to Linear keys."""
        remapped = {}
        for key, value in state.items():
            if key.startswith("action_head.0."):
                remapped[key.replace("action_head.0.", "action_head.", 1)] = value
            elif key.startswith("metrics_head.0."):
                remapped[key.replace("metrics_head.0.", "metrics_head.", 1)] = value
            elif key.startswith("action_head.1."):
                continue  # drop Softmax params if any
            else:
                remapped[key] = value
        return remapped

    @classmethod
    def load(cls, version: str = "v1.0") -> "TradingModel":
        model_dir = MODELS_DIR / f"model_{version}"
        if not model_dir.exists():
            raise FileNotFoundError(f"No model found at {model_dir}")

        with open(model_dir / "metadata.json", "r", encoding="utf-8") as f:
            metadata = json.load(f)

        instance = cls(
            version=version,
            input_size=metadata["input_size"],
            hidden_size=metadata.get("hidden_size", 256),
        )
        raw = torch.load(model_dir / "model_weights.pth", weights_only=True, map_location="cpu")
        state = cls._normalize_state_dict(raw)
        instance.model.load_state_dict(state, strict=False)
        instance.model.eval()

        scaler_path = SCALERS_DIR / f"scaler_{version}.joblib"
        if scaler_path.exists():
            instance.scaler = joblib.load(scaler_path)

        history_path = model_dir / "history.json"
        if history_path.exists():
            with open(history_path, "r", encoding="utf-8") as f:
                instance.history = json.load(f)

        # Print to stderr, not stdout: inference.py's stdout contract is a
        # single JSON line consumed by tradingModel.ts's predict(); any extra
        # stdout text (even a friendly log line) breaks that JSON.parse.
        print(f"Loaded model version {version}", file=sys.stderr)
        return instance


if __name__ == "__main__":
    model = TradingModel(version="v1.0")
    model.save()
    loaded = TradingModel.load(version="v1.0")
    print(loaded.predict(np.random.rand(1, 50)))
