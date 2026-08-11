import { spawn } from "child_process";
import path from "path";

export interface TradingPrediction {
  buy_probability: number;
  sell_probability: number;
  hold_probability: number;
  confidence: number;
  expected_risk: number;
  expected_reward: number;
  expected_duration: number;
}

export interface TrainingResult {
  success: boolean;
  version?: string;
  training_results?: {
    final_loss?: number;
    final_train_loss?: number;
    final_val_loss?: number;
    epochs?: number;
  };
  candidates?: any[];
  best_candidate?: any;
  auto_promoted?: boolean;
  message?: string;
  error?: string;
}

export class TradingModelWrapper {
  private readonly pythonPath: string;
  private readonly baseDir: string;

  constructor() {
    this.pythonPath = process.env.PYTHON_PATH || "python";
    this.baseDir = path.join(__dirname, "../../python");
  }

  /**
   * Run inference using the specified model version
   */
  async predict(
    features: number[],
    version: string = "v1.0"
  ): Promise<TradingPrediction> {
    return new Promise((resolve, reject) => {
      const featuresJson = JSON.stringify(features);
      const scriptPath = path.join(this.baseDir, "inference.py");
      const pythonProcess = spawn(this.pythonPath, [scriptPath, version, featuresJson]);
      let output = "";
      let errorOutput = "";

      pythonProcess.stdout?.on("data", (data) => {
        output += data.toString();
      });

      pythonProcess.stderr?.on("data", (data) => {
        errorOutput += data.toString();
      });

      pythonProcess.on("close", (code) => {
        if (code !== 0) {
          console.error(`❌ Inference error (code: ${code}): ${errorOutput}`);
          reject(new Error(`Inference failed: ${errorOutput}`));
          return;
        }

        try {
          // Defensive: parse only the last non-empty line as JSON, in case
          // any library code (this repo's own, or a future dependency)
          // prints extra informational text to stdout ahead of the actual
          // JSON result. inference.py's contract is a single trailing JSON
          // line, but we don't want a stray print statement anywhere in the
          // Python call chain to silently break every live prediction.
          const lines = output.trim().split(/\r?\n/).filter(Boolean);
          const lastLine = lines[lines.length - 1] || '';
          const result = JSON.parse(lastLine);
          if (!result.success) {
            reject(new Error(result.error || "Unknown error"));
            return;
          }
          resolve(result.prediction);
        } catch (e) {
          console.error("❌ Failed to parse inference output:", e);
          console.error("Output received:", output);
          reject(e);
        }
      });
    });
  }

  /**
   * Train a new version of the model using provided training data
   */
  async train(dataPath: string, newVersion: string): Promise<TrainingResult> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(this.baseDir, "train.py");
      const pythonProcess = spawn(this.pythonPath, [scriptPath, dataPath, newVersion]);
      let output = "";
      let errorOutput = "";

      pythonProcess.stdout?.on("data", (data) => {
        output += data.toString();
      });

      pythonProcess.stderr?.on("data", (data) => {
        errorOutput += data.toString();
      });

      pythonProcess.on("close", (code) => {
        if (code !== 0) {
          console.error(`❌ Training error (code: ${code}): ${errorOutput}`);
          reject(new Error(`Training failed: ${errorOutput}`));
          return;
        }
        try {
          const result = JSON.parse(output.trim());
          if (!result.success) {
            reject(new Error(result.error || "Unknown error"));
            return;
          }
          resolve(result);
        } catch (e) {
          console.error("❌ Failed to parse training output:", e);
          console.error("Output received:", output);
          reject(e);
        }
      });
    });
  }
}

// Singleton instance
export const tradingModel = new TradingModelWrapper();
