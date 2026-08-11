"""
Inference Script
Takes normalized features, returns predictions
"""

import json
import sys
import numpy as np
from model import TradingModel


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python inference.py <model_version> <features_json>"}))
        return
        
    version = sys.argv[1]
    features_json = sys.argv[2]
    
    try:
        features = json.loads(features_json)
        model = TradingModel.load(version)
        
        if isinstance(features, list):
            X = np.array(features)
        else:
            X = np.array([features])
            
        prediction = model.predict(X)
        
        print(json.dumps({"success": True, "prediction": prediction}))
        
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


if __name__ == "__main__":
    main()
