// Request body validation middleware, backed by zod.
//
// Schemas are intentionally permissive on "extra" fields (`.passthrough()`) where the
// downstream business logic (trading-engine) accepts loosely-typed/extensible payloads
// (e.g. addCommand(cmd: any)). We still enforce the fields we know the engine relies on,
// per LiquiBot/backend/src/types/index.ts (MT5Payload) — read-only reference, not edited.
import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema } from 'zod';

export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request body',
        details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    req.body = result.data;
    next();
  };
}

const candleSchema = z
  .object({
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volume: z.number().optional().default(0),
    timestamp: z.number(),
    x: z.number().optional(),
  })
  .passthrough();

// Matches MT5Payload in src/types/index.ts.
// Optional numeric fields are filled by the EA v3 heartbeat; defaults keep
// older EA builds from 400ing while still allowing risk sizing to run.
export const eaUpdateSchema = z
  .object({
    symbol: z.string().min(1),
    timeframe: z.string().min(1).optional().default('M5'),
    candles: z.array(candleSchema).optional().default([]),
    spread: z.number(),
    balance: z.number(),
    equity: z.number(),
    pipSize: z.number().optional().default(0.01),
    pointSize: z.number().optional().default(0.001),
    pipValue: z.number().optional().default(1),
    minLot: z.number().optional().default(0.01),
    maxLot: z.number().optional().default(100),
    minLotStep: z.number().optional().default(0.01),
    swingHighs: z.array(z.number()).optional(),
    swingLows: z.array(z.number()).optional(),
    openPositionsCount: z.number().optional().default(0),
    ema20: z.number().optional().default(0),
    ema20Prev: z.number().optional().default(0),
    atr14: z.number().optional(),
    newsFilterActive: z.boolean().optional(),
    freeMargin: z.number().optional(),
    marginLevel: z.number().optional(),
    margin: z.number().optional(),
    positions: z.array(z.any()).optional(),
    openPositions: z.array(z.any()).optional(),
    closedTrades: z.array(z.any()).optional(),
    timestamp: z.number().optional(), // replay-protection helper (see replayGuard.ts)
  })
  .passthrough();

// Manual order / pause / resume actions from the mobile app.
export const orderSchema = z
  .object({
    action: z.string().min(1),
    symbol: z.string().optional(),
    lots: z.number().optional(),
    sl: z.number().optional(),
    tp: z.number().optional(),
    ticket: z.union([z.string(), z.number()]).optional(),
    timestamp: z.number().optional(), // replay-protection helper (see replayGuard.ts)
  })
  .passthrough();

// Bot configuration sync from the mobile app.
export const botConfigSchema = z
  .object({
    autoTradingEnabled: z.boolean().optional(),
    timezoneTradingEnabled: z.boolean().optional(),
    timestamp: z.number().optional(),
  })
  .passthrough();

// EA / mobile-app credential validation request.
export const eaValidateSchema = z.object({
  apiKey: z.string().min(1, 'apiKey is required'),
});

// EA execution-report payload: broker-side details for every order/position event.
export const eaExecutionReportSchema = z
  .object({
    ticket: z.union([z.string(), z.number()]),
    eventType: z.string().min(1), // ORDER_OPEN, ORDER_CLOSE, ORDER_MODIFY, SLIPPAGE, REQUOTE, PARTIAL_FILL, ERROR
    symbol: z.string().optional(),
    direction: z.string().optional(), // BUY/SELL
    requestedPrice: z.number().optional(),
    executionPrice: z.number().optional(),
    slippagePips: z.number().optional(),
    spreadAtExecution: z.number().optional(),
    lotSize: z.number().optional(),
    sl: z.number().optional(),
    tp: z.number().optional(),
    profitPips: z.number().optional(),
    profitDollars: z.number().optional(),
    brokerErrorCode: z.union([z.string(), z.number()]).optional(),
    brokerErrorMessage: z.string().optional(),
    retriesUsed: z.number().optional(),
    latencyMs: z.number().optional(),
    serverTimestamp: z.union([z.string(), z.number()]).optional(),
    eaTimestamp: z.union([z.string(), z.number()]).optional(),
    rawBrokerResponse: z.any().optional(),
  })
  .passthrough();
