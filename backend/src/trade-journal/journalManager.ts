import { PrismaClient, Prisma, AdvancedTradeJournal } from '../generated/prisma';
import { Decimal } from 'decimal.js';
import { prisma } from '../database';

// Allows callers (e.g. trading-engine) to pass an interactive transaction
// client so journal writes commit atomically with other DB writes, while
// defaulting to the module-level client for existing callers (api/index.ts).
type DbClient = PrismaClient | Prisma.TransactionClient;

interface CreateJournalEntryParams {
  ticket: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  marketSnapshot: Record<string, any>;
  marketSession: string;
  indicators: Record<string, any>;
  featureSet: Record<string, any>;
  aiPrediction?: 'BUY' | 'SELL' | 'HOLD';
  aiConfidence?: number;
  aiExpectedRisk?: number;
  aiExpectedReward?: number;
  aiExpectedDuration?: number;
  modelVersion?: string;
  entryPrice: number;
  executionPrice: number;
  slippage: number;
  spreadAtEntry: number;
  sl: number;
  tp: number;
  lotSize: number;
  riskPercent: number;
  riskScore?: number;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'OPEN';
  profitPips: number;
  profitPercent: number;
  profitDollars: number;
  entryTimestamp: Date;
  closeTimestamp?: Date;
  durationMinutes?: number;
  reasonForEntry?: string;
  reasonForExit?: string;
  notes?: string;
  screenshotRefs?: string[];
  tradeDnaId?: string;
  // Ensemble + Regime phase 1 (all additive, nullable; defaults to Prisma defaults when omitted)
  marketRegime?: string;
  regimeConfidence?: number | Decimal | null;
  detectedPattern?: string | null;
  patternConfidence?: number | Decimal | null;
  fnnConfidence?: number | Decimal | null;
  cnnConfidence?: number | Decimal | null;
  lstmConfidence?: number | Decimal | null;
  ensembleScore?: number | Decimal | null;
  ensembleDecision?: string | null;
  explainability?: any;
}

interface UpdateJournalEntryParams {
  outcome?: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'OPEN';
  profitPips?: number;
  profitPercent?: number;
  profitDollars?: number;
  closeTimestamp?: Date;
  durationMinutes?: number;
  reasonForExit?: string;
  notes?: string;
  screenshotRefs?: string[];
  // Ensemble + Regime phase 1 (nullable, additive updates)
  marketRegime?: string | null;
  regimeConfidence?: number | Decimal | null;
  detectedPattern?: string | null;
  patternConfidence?: number | Decimal | null;
  fnnConfidence?: number | Decimal | null;
  cnnConfidence?: number | Decimal | null;
  lstmConfidence?: number | Decimal | null;
  ensembleScore?: number | Decimal | null;
  ensembleDecision?: string | null;
  explainability?: any;
}

export class JournalManager {
  /**
   * Create a new journal entry when a trade opens
   */
  async createEntry(params: CreateJournalEntryParams, db: DbClient = prisma): Promise<AdvancedTradeJournal> {
    const entry = await db.advancedTradeJournal.create({
      data: {
        ...params,
        durationMinutes: params.durationMinutes,
      },
    });

    console.log(`📓 Journal entry created for ticket ${params.ticket}`);
    return entry;
  }

  /**
   * Get a journal entry by ticket number
   */
  async getEntryByTicket(ticket: string): Promise<AdvancedTradeJournal | null> {
    return await prisma.advancedTradeJournal.findUnique({
      where: { ticket },
    });
  }

  /**
   * Get all journal entries with optional filters
   */
  async getAllEntries(options?: {
    symbol?: string;
    outcome?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<AdvancedTradeJournal[]> {
    const { symbol, outcome, startDate, endDate, limit = 100, offset = 0 } = options || {};

    const where: any = {};
    if (symbol) where.symbol = symbol;
    if (outcome) where.outcome = outcome;
    if (startDate || endDate) {
      where.entryTimestamp = {};
      if (startDate) where.entryTimestamp.gte = startDate;
      if (endDate) where.entryTimestamp.lte = endDate;
    }

    return await prisma.advancedTradeJournal.findMany({
      where,
      orderBy: { entryTimestamp: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  /**
   * Update a journal entry (usually when a trade closes)
   */
  async updateEntry(ticket: string, params: UpdateJournalEntryParams, db: DbClient = prisma): Promise<AdvancedTradeJournal | null> {
    // Normalize numeric fields to avoid NULL/undefined being written
    const safeParams: any = { ...params };
    if (params.profitPips !== undefined) safeParams.profitPips = Number(params.profitPips);
    if (params.profitPercent !== undefined) safeParams.profitPercent = Number(params.profitPercent);
    if (params.profitDollars !== undefined) safeParams.profitDollars = Number(params.profitDollars);

    const updatedEntry = await db.advancedTradeJournal.updateMany({
      where: { ticket },
      data: {
        ...safeParams,
        durationMinutes: params.durationMinutes,
        updatedAt: new Date(),
      },
    });

    if (updatedEntry.count > 0) {
      console.log(`📓 Journal entry updated for ticket ${ticket} (profitDollars=${safeParams.profitDollars ?? 'N/A'})`);
      return await db.advancedTradeJournal.findUnique({ where: { ticket } });
    }

    // If no row was updated, create one as a best-effort fallback so the UI has a record.
    try {
      const created = await db.advancedTradeJournal.create({
        data: {
          ticket,
          symbol: (safeParams as any).symbol || 'UNKNOWN',
          direction: (safeParams as any).direction || 'BUY',
          marketSnapshot: (safeParams as any).marketSnapshot || {},
          marketSession: (safeParams as any).marketSession || 'UNKNOWN',
          indicators: (safeParams as any).indicators || {},
          featureSet: (safeParams as any).featureSet || {},
          entryPrice: Number((safeParams as any).entryPrice || 0),
          executionPrice: Number((safeParams as any).executionPrice || 0),
          slippage: Number((safeParams as any).slippage || 0),
          spreadAtEntry: Number((safeParams as any).spreadAtEntry || 0),
          sl: Number((safeParams as any).sl || 0),
          tp: Number((safeParams as any).tp || 0),
          lotSize: Number((safeParams as any).lotSize || 0),
          riskPercent: Number((safeParams as any).riskPercent || 0),
          outcome: (safeParams as any).outcome || 'OPEN',
          profitPips: safeParams.profitPips ?? 0,
          profitPercent: safeParams.profitPercent ?? 0,
          profitDollars: safeParams.profitDollars ?? 0,
          entryTimestamp: (safeParams as any).entryTimestamp || new Date(),
          closeTimestamp: (safeParams as any).closeTimestamp || new Date(),
          durationMinutes: safeParams.durationMinutes,
        },
      });
      console.warn(`📓 Journal entry missing for ticket ${ticket}; created fallback entry (profitDollars=${created.profitDollars})`);
      return created;
    } catch (e) {
      console.error(`Failed to create fallback journal entry for ${ticket}:`, e);
    }

    return null;
  }

  /**
   * Add a note to an existing entry
   */
  async addNote(ticket: string, note: string): Promise<AdvancedTradeJournal | null> {
    const existing = await this.getEntryByTicket(ticket);
    if (!existing) return null;

    const updatedNotes = existing.notes ? `${existing.notes}\n${note}` : note;
    return await prisma.advancedTradeJournal.update({
      where: { ticket },
      data: {
        notes: updatedNotes,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Get statistics about the journal
   */
  async getStats(options?: {
    symbol?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const { symbol, startDate, endDate } = options || {};
    const where: any = {};
    if (symbol) where.symbol = symbol;
    if (startDate || endDate) {
      where.entryTimestamp = {};
      if (startDate) where.entryTimestamp.gte = startDate;
      if (endDate) where.entryTimestamp.lte = endDate;
    }

    const totalTrades = await prisma.advancedTradeJournal.count({ where });
    const winningTrades = await prisma.advancedTradeJournal.count({
      where: { ...where, outcome: 'WIN' },
    });
    const losingTrades = await prisma.advancedTradeJournal.count({
      where: { ...where, outcome: 'LOSS' },
    });
    const breakevenTrades = await prisma.advancedTradeJournal.count({
      where: { ...where, outcome: 'BREAKEVEN' },
    });

    const entries = await prisma.advancedTradeJournal.findMany({
      where,
      select: { profitDollars: true, profitPips: true },
    });

    const totalProfitDollars = entries.reduce((sum, e) => sum + Number(e.profitDollars), 0);
    const totalProfitPips = entries.reduce((sum, e) => sum + Number(e.profitPips), 0);

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      breakevenTrades,
      winRate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
      totalProfitDollars,
      totalProfitPips,
      avgProfitDollars: totalTrades > 0 ? totalProfitDollars / totalTrades : 0,
      avgProfitPips: totalTrades > 0 ? totalProfitPips / totalTrades : 0,
    };
  }

  /**
   * Delete a journal entry (use carefully)
   */
  async deleteEntry(ticket: string): Promise<boolean> {
    const result = await prisma.advancedTradeJournal.deleteMany({
      where: { ticket },
    });
    return result.count > 0;
  }
}

export const journalManager = new JournalManager();
