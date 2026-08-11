// Single consolidated risk engine. The former advancedRiskEngine.ts was
// deleted; its session/news/daily-loss/min-R:R checks now live directly on
// the live signal-validation path in trading-engine/signalValidator.ts
// (which calls into riskEngine.ts for lot/TP/SL math), so there is exactly
// one risk engine actually exercised in production.
export * from "./riskEngine";
