"""
CLI helpers for Node/TS: status, promote, list models.
"""

from __future__ import annotations

import json
import sys

from registry import get_dashboard_state, list_models, promote_to_production


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python manage.py <status|list|promote> [version]"}))
        return

    cmd = sys.argv[1]
    try:
        if cmd == "status":
            print(json.dumps({"success": True, "data": get_dashboard_state()}))
        elif cmd == "list":
            print(json.dumps({"success": True, "data": list_models()}))
        elif cmd == "promote":
            if len(sys.argv) < 3:
                print(json.dumps({"success": False, "error": "Version required"}))
                return
            print(json.dumps(promote_to_production(sys.argv[2])))
        else:
            print(json.dumps({"success": False, "error": f"Unknown command: {cmd}"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


if __name__ == "__main__":
    main()
