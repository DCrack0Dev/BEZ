/**
 * CLI entry: train a candidate model (does NOT auto-promote production).
 * Usage: npx ts-node src/scripts/trainCandidate.ts
 */
import { modelManager } from '../model-management';
import { logger } from '../logging';

async function main() {
  logger.info('Starting candidate training (production remains read-only)...');
  const result = await modelManager.startTraining({});
  console.log(JSON.stringify(result, null, 2));
  if (!result?.success) process.exit(1);
  logger.success('Training finished. Promote manually via POST /ai/promote when ready.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
