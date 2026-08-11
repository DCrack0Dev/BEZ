"""
Model version registry.

Rules:
- Every trained model is saved with an explicit version.
- Production pointer is never replaced automatically.
- Promotion requires an explicit promote() call (manual / API).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

BASE_DIR = Path(__file__).parent
MODELS_DIR = BASE_DIR / "saved_models"
REGISTRY_PATH = MODELS_DIR / "registry.json"

MODELS_DIR.mkdir(exist_ok=True)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_registry() -> Dict[str, Any]:
    return {
        "production_version": None,
        "candidates": {},
        "training_runs": [],
        "updated_at": _now(),
    }


def load_registry() -> Dict[str, Any]:
    if not REGISTRY_PATH.exists():
        reg = _default_registry()
        # Bootstrap from existing model folders
        for path in sorted(MODELS_DIR.glob("model_*")):
            if path.is_dir():
                version = path.name.replace("model_", "", 1)
                meta_path = path / "metadata.json"
                meta = {}
                if meta_path.exists():
                    with open(meta_path, "r", encoding="utf-8") as f:
                        meta = json.load(f)
                reg["candidates"][version] = {
                    "version": version,
                    "status": "CANDIDATE",
                    "path": str(path),
                    "registered_at": meta.get("saved_at", _now()),
                    "metrics": meta.get("metrics", {}),
                    "deployment_recommendation": meta.get("deployment_recommendation", "NO"),
                }
                if reg["production_version"] is None:
                    # First known model becomes production only if marked as such
                    if meta.get("is_production"):
                        reg["production_version"] = version
                        reg["candidates"][version]["status"] = "PRODUCTION"
        # If still no production and we have v1.1, use it as initial production (bootstrap)
        if reg["production_version"] is None and "v1.1" in reg["candidates"]:
            reg["production_version"] = "v1.1"
            reg["candidates"]["v1.1"]["status"] = "PRODUCTION"
        save_registry(reg)
        return reg

    with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_registry(registry: Dict[str, Any]) -> None:
    registry["updated_at"] = _now()
    MODELS_DIR.mkdir(exist_ok=True)
    with open(REGISTRY_PATH, "w", encoding="utf-8") as f:
        json.dump(registry, f, indent=2)


def next_version(prefix: str = "v") -> str:
    """Generate next semantic-ish version: v1.0, v1.1, v1.2, ..."""
    reg = load_registry()
    versions = list(reg.get("candidates", {}).keys())
    # Also scan disk
    for path in MODELS_DIR.glob("model_*"):
        versions.append(path.name.replace("model_", "", 1))

    majors: Dict[int, int] = {}
    for v in versions:
        cleaned = v.lstrip("vV")
        parts = cleaned.split(".")
        try:
            major = int(parts[0])
            minor = int(parts[1]) if len(parts) > 1 else 0
            majors[major] = max(majors.get(major, -1), minor)
        except ValueError:
            continue

    if not majors:
        return f"{prefix}1.0"
    major = max(majors.keys())
    minor = majors[major] + 1
    return f"{prefix}{major}.{minor}"


def register_candidate(
    version: str,
    metrics: Dict[str, Any],
    training_run: Optional[Dict[str, Any]] = None,
    deployment_recommendation: str = "NO",
    recommendation_reason: str = "",
) -> Dict[str, Any]:
    reg = load_registry()
    model_path = MODELS_DIR / f"model_{version}"
    entry = {
        "version": version,
        "status": "CANDIDATE",
        "path": str(model_path),
        "registered_at": _now(),
        "metrics": metrics,
        "deployment_recommendation": deployment_recommendation,
        "recommendation_reason": recommendation_reason,
        "is_production": False,
    }
    # Never overwrite production status if this version somehow is production
    if reg.get("production_version") == version:
        entry["status"] = "PRODUCTION"
        entry["is_production"] = True

    reg.setdefault("candidates", {})[version] = entry
    if training_run:
        reg.setdefault("training_runs", []).append(
            {
                **training_run,
                "version": version,
                "timestamp": _now(),
            }
        )
        # Keep last 100 runs
        reg["training_runs"] = reg["training_runs"][-100:]
    save_registry(reg)
    return entry


def get_production_version() -> Optional[str]:
    return load_registry().get("production_version")


def get_candidate(version: str) -> Optional[Dict[str, Any]]:
    return load_registry().get("candidates", {}).get(version)


def list_models() -> List[Dict[str, Any]]:
    reg = load_registry()
    prod = reg.get("production_version")
    models = []
    for version, entry in reg.get("candidates", {}).items():
        models.append({**entry, "is_production": version == prod})
    models.sort(key=lambda m: m.get("registered_at", ""), reverse=True)
    return models


def promote_to_production(version: str) -> Dict[str, Any]:
    """
    Explicit manual promotion. Never called automatically by the training pipeline.
    """
    reg = load_registry()
    if version not in reg.get("candidates", {}):
        raise ValueError(f"Unknown candidate version: {version}")

    old = reg.get("production_version")
    if old and old in reg["candidates"]:
        reg["candidates"][old]["status"] = "ARCHIVED"
        reg["candidates"][old]["is_production"] = False

    reg["production_version"] = version
    reg["candidates"][version]["status"] = "PRODUCTION"
    reg["candidates"][version]["is_production"] = True
    reg["candidates"][version]["promoted_at"] = _now()
    save_registry(reg)

    # Mirror flag into metadata.json
    meta_path = MODELS_DIR / f"model_{version}" / "metadata.json"
    if meta_path.exists():
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        meta["is_production"] = True
        meta["promoted_at"] = _now()
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)

    return {
        "success": True,
        "previous_production": old,
        "production_version": version,
        "message": f"Promoted {version} to production (manual).",
    }


def get_dashboard_state() -> Dict[str, Any]:
    reg = load_registry()
    return {
        "production_version": reg.get("production_version"),
        "models": list_models(),
        "training_runs": list(reversed(reg.get("training_runs", [])[-20:])),
        "updated_at": reg.get("updated_at"),
    }
