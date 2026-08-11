import { FeatureSet } from '../types';

/**
 * Trade DNA System
 * Generates a detailed fingerprint for every trade
 */

export interface ScreenshotData {
  beforeTrade?: string; // Base64 or URL
  atEntry?: string;
  afterTrade?: string;
}

export interface TradeDNA {
  id: string;
  ticket: string;
  symbol: string;
  
  // Direction & Timing
  direction: 'BUY' | 'SELL';
  entryTime: number;
  closeTime?: number;
  durationMinutes?: number;
  
  // Market Conditions
  entryFeatures: FeatureSet;
  closeFeatures?: FeatureSet;
  
  // Technicals
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  lotSize: number;
  riskPercent: number;
  
  // Execution
  slippage: number;
  spreadAtEntry: number;
  executionLatency: number;
  
  // Outcome
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'OPEN';
  profitPips: number;
  profitPercent: number;
  profitDollars: number;
  
  // AI Performance
  aiConfidence: number;
  modelVersion: string;
  
  // Lessons & Mistakes
  mistakes?: string[];
  lessons?: string[];
  notes?: string;
  
  // Screenshots
  screenshots: ScreenshotData;
  
  // Metadata
  createdAt: number;
  updatedAt: number;
}

export class TradeDnaEngine {
  private dnaStore: Map<string, TradeDNA> = new Map();

  /**
   * Initialize a new Trade DNA entry when a position is opened
   */
  public initializeTradeDNA(
    ticket: string,
    symbol: string,
    direction: 'BUY' | 'SELL',
    entryPrice: number,
    stopLoss: number,
    takeProfit: number,
    lotSize: number,
    riskPercent: number,
    entryFeatures: FeatureSet,
    modelVersion: string = 'v1.0',
    aiConfidence: number = 0.75
  ): TradeDNA {
    const id = `dna_${Date.now()}_${ticket}`;
    const dna: TradeDNA = {
      id,
      ticket,
      symbol,
      direction,
      entryTime: Date.now(),
      entryPrice,
      stopLoss,
      takeProfit,
      lotSize,
      riskPercent,
      entryFeatures,
      slippage: 0,
      spreadAtEntry: entryFeatures.spreadStatus === 'WIDE' ? 2 : 1,
      executionLatency: 0,
      outcome: 'OPEN',
      profitPips: 0,
      profitPercent: 0,
      profitDollars: 0,
      aiConfidence,
      modelVersion,
      screenshots: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.dnaStore.set(id, dna);
    console.log(`🧬 Trade DNA created: ${id}`);
    return dna;
  }

  /**
   * Update Trade DNA during open position
   */
  public updateTradeDNA(ticket: string, updates: Partial<TradeDNA>): TradeDNA | null {
    let dna = this.getDnaByTicket(ticket);
    if (!dna) return null;

    dna = {
      ...dna,
      ...updates,
      updatedAt: Date.now()
    };

    this.dnaStore.set(dna.id, dna);
    return dna;
  }

  /**
   * Finalize Trade DNA when position is closed
   */
  public finalizeTradeDNA(
    ticket: string,
    closePrice: number,
    closeFeatures: FeatureSet,
    profitPips: number,
    profitPercent: number,
    profitDollars: number,
    lessons?: string[],
    mistakes?: string[]
  ): TradeDNA | null {
    let dna = this.getDnaByTicket(ticket);
    if (!dna) return null;

    const outcome = profitPips > 5 ? 'WIN' : (profitPips < -5 ? 'LOSS' : 'BREAKEVEN');
    const durationMinutes = dna.entryTime ? Math.floor((Date.now() - dna.entryTime) / 60000) : 0;

    dna = {
      ...dna,
      closeTime: Date.now(),
      durationMinutes,
      closeFeatures,
      outcome,
      profitPips,
      profitPercent,
      profitDollars,
      lessons,
      mistakes,
      updatedAt: Date.now()
    };

    this.dnaStore.set(dna.id, dna);
    console.log(`🧬 Trade DNA finalized: ${dna.id} (${outcome})`);
    return dna;
  }

  /**
   * Get DNA by ticket
   */
  public getDnaByTicket(ticket: string): TradeDNA | null {
    for (const dna of this.dnaStore.values()) {
      if (dna.ticket === ticket) {
        return dna;
      }
    }
    return null;
  }

  /**
   * Get all DNA entries
   */
  public getAllDna(): TradeDNA[] {
    return Array.from(this.dnaStore.values());
  }

  /**
   * Get DNA for training dataset
   */
  public getTrainingDataset(): TradeDNA[] {
    return this.getAllDna().filter(dna => dna.outcome !== 'OPEN');
  }
}
