import { prisma } from '../database';
import { FeatureSet } from '../types';
import { Prisma } from '../generated/prisma';

const { Decimal } = Prisma;

type JsonInput = Prisma.InputJsonValue;

export class FeatureStorage {
  async computeSimilarSetupWinRate(feature: FeatureSet): Promise<number> {
    try {
      const similar = await prisma.tradeDNA.findMany({
        where: {
          symbol: feature.symbol,
          outcome: { in: ['WIN', 'LOSS'] },
          entryFeatures: { not: Prisma.AnyNull },
        },
        take: 100,
        orderBy: { entryTimestamp: 'desc' },
        select: { outcome: true, entryFeatures: true, direction: true },
      });

      if (similar.length < 5) return 0;

      const dir = feature.trendDirection === 'BULLISH' ? 'BUY' : feature.trendDirection === 'BEARISH' ? 'SELL' : null;

      let matches = 0;
      let wins = 0;
      for (const dna of similar) {
        const ef = dna.entryFeatures as Partial<FeatureSet> | null;
        if (!ef) continue;
        if (dir && dna.direction !== dir) continue;
        const sameFvg = ef.fvgPresent === feature.fvgPresent;
        const sameOb = ef.orderBlockConfirmed === feature.orderBlockConfirmed;
        const samePattern = ef.prevCandlePattern === feature.prevCandlePattern || ef.prevCandleType === feature.prevCandleType;
        if (!sameFvg && !sameOb && !samePattern) continue;
        matches++;
        if (dna.outcome === 'WIN') wins++;
      }

      return matches >= 3 ? wins / matches : 0;
    } catch {
      return 0;
    }
  }

  async saveFeature(feature: FeatureSet & { candleId?: string }) {
    try {
      const dec = (n: number | undefined | null) =>
        n === undefined || n === null ? null : new Decimal(Number(n).toString());

      const data: Prisma.FeatureSetUncheckedCreateInput = {
        symbol: feature.symbol,
        timeframe: feature.timeframe,
        trendStrength: new Decimal(Number(feature.trendStrength).toString()),
        trendDirection: feature.trendDirection,
        ema20DistancePips: new Decimal(Number(feature.ema20DistancePips).toString()),
        ema50DistancePips: new Decimal(Number(feature.ema50DistancePips).toString()),
        adxValue: new Decimal(Number(feature.adxValue).toString()),
        slope20: dec(feature.slope20),
        slope50: dec(feature.slope50),
        momentumDirection: feature.momentumDirection,
        rsiStrength: new Decimal(Number(feature.rsiStrength).toString()),
        macdMomentum: feature.macdMomentum,
        cciValue: dec(feature.cciValue),
        williamsR: dec(feature.williamsR),
        atrRatio: new Decimal(Number(feature.atrRatio).toString()),
        volatility: feature.volatility,
        bbPercentWidth: dec(feature.bbPercentWidth),
        bbPosition: dec(feature.bbPosition),
        bbWidth: dec(feature.bbWidth),
        liquiditySweep: feature.liquiditySweep,
        swingHighs: feature.swingHighs as unknown as JsonInput,
        swingLows: feature.swingLows as unknown as JsonInput,
        nearestSupport: dec(feature.nearestSupport),
        nearestResistance: dec(feature.nearestResistance),
        structureType: feature.structureType,
        structureStrength: dec(feature.structureStrength),
        fvgPresent: feature.fvgPresent,
        fvgDetails: feature.fvgDetails
          ? (feature.fvgDetails as unknown as JsonInput)
          : undefined,
        orderBlockConfirmed: feature.orderBlockConfirmed,
        orderBlockDetails: feature.orderBlockDetails
          ? (feature.orderBlockDetails as unknown as JsonInput)
          : undefined,
        marketSession: feature.marketSession,
        prevCandlePattern: feature.prevCandlePattern,
        prevCandleBodyPct: dec(feature.prevCandleBodyPct),
        prevCandleType: feature.prevCandleType,
        volumeRatio: dec(feature.volumeRatio),
        newsImpact: feature.newsImpact,
        normalizedFeatures: (feature.normalizedFeatures ?? []) as unknown as JsonInput,
        similarSetupWinRate: new Decimal(Number(feature.similarSetupWinRate || 0).toString()),
        riskScore: feature.riskScore,
        bullishStructurePercent: new Decimal(Number(feature.bullishStructurePercent || 0).toString()),
        bearishStructurePercent: new Decimal(Number(feature.bearishStructurePercent || 0).toString()),
        candleId: feature.candleId!,
      };

      const savedFeature = await prisma.featureSet.create({ data });
      return savedFeature;
    } catch (error) {
      console.error('Error saving feature:', error);
      throw error;
    }
  }

  async getFeaturesBySymbol(symbol: string, limit: number = 100) {
    try {
      return await prisma.featureSet.findMany({
        where: {
          symbol: symbol
        },
        orderBy: {
          createdAt: 'desc'
        },
        take: limit
      });
    } catch (error) {
      console.error('Error getting features by symbol:', error);
      throw error;
    }
  }

  async getLatestFeature(symbol: string) {
    try {
      return await prisma.featureSet.findFirst({
        where: {
          symbol: symbol
        },
        orderBy: {
          createdAt: 'desc'
        }
      });
    } catch (error) {
      console.error('Error getting latest feature:', error);
      throw error;
    }
  }
}
