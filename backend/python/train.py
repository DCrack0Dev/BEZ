"""
Training entrypoint — trains candidate models offline via the pipeline.
Never replaces the production model.
"""

from __future__ import annotations

import json
import sys

from pipeline import run_pipeline
from registry import next_version, promote_to_production


def main():
    if len(sys.argv) < 2:
        print(
            json.dumps(
                {
                    "error": "Usage: python train.py <data_path> [version] [--epochs N] [--promote VERSION]"
                }
            )
        )
        return

    # Manual promote path (never automatic)
    if sys.argv[1] == "--promote":
        if len(sys.argv) < 3:
            print(json.dumps({"success": False, "error": "Usage: python train.py --promote <version>"}))
            return
        try:
            result = promote_to_production(sys.argv[2])
            print(json.dumps(result))
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}))
        return

    data_path = sys.argv[1]
    version = None
    epochs = 80

    args = sys.argv[2:]
    i = 0
    while i < len(args):
        if args[i] == "--epochs" and i + 1 < len(args):
            epochs = int(args[i + 1])
            i += 2
        elif not args[i].startswith("--") and version is None:
            version = args[i]
            i += 1
        else:
            i += 1

    if version is None:
        version = next_version()

    try:
        result = run_pipeline(
            data_path=data_path,
            version=version,
            epochs=epochs,
            hidden_sizes=[256],  # single candidate when version provided
        )
        # Compact stdout for Node wrapper — drop large history arrays optionally
        print(json.dumps(result, default=str))
    except Exception as e:
        import traceback

        print(
            json.dumps(
                {
                    "success": False,
                    "error": str(e),
                    "traceback": traceback.format_exc(),
                    "auto_promoted": False,
                }
            )
        )


if __name__ == "__main__":
    main()
