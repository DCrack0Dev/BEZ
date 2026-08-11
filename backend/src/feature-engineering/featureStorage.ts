import { prisma } from '../database';

export class FeatureStorage {
  async saveFeature(feature: any) {
    try {
      const savedFeature = await prisma.featureSet.create({
        data: {
          symbol: feature.symbol,
          timeframe: feature.timeframe,
          trendStrength: feature.trendStrength,
          trendDirection: feature.trendDirection,
          ema20DistancePips: feature.ema20DistancePips,
          ema50DistancePips: feature.ema50DistancePips,
          adxValue: feature.adxValue,
          slope20: feature.slope20,
          slope50: feature.slope50,
          momentumDirection: feature.momentumDirection,
          rsiStrength: feature.rsiStrength,
          macdMomentum: feature.macdMomentum,
          cciValue: feature.cciValue,
          williamsR: feature.williamsR,
          atrRatio: feature.atrRatio,
          volatility: feature.volatility,
          bbPercentWidth: feature.bbPercentWidth,
          bbPosition: feature.bbPosition,
          liquiditySweep: feature.liquiditySweep,
          recentSweeps: feature.recentSweeps,
          swingHighs: feature.swingHighs,
          swingLows: feature.swingLows,
          nearestSupport: feature.nearestSupport,
          nearestResistance: feature.nearestResistance,
          structureType: feature.structureType,
          structureStrength: feature.structureStrength,
          fvgPresent: feature.fvgPresent,
          fvgDetails: feature.fvgDetails,
          orderBlockConfirmed: feature.orderBlockConfirmed,
          orderBlockDetails: feature.orderBlockDetails,
          poiZones: feature.poiZones,
          marketSession: feature.marketSession,
          prevCandlePattern: feature.prevCandlePattern,
          prevCandleBodyPct: feature.prevCandleBodyPct,
          prevCandleType: feature.prevCandleType,
          normalizedFeatures: feature.normalizedFeatures,
          candleId: feature.candleId
        }
      });
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
