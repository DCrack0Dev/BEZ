import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';
import { TradeSignal } from '../../backend/src/riskEngine';

interface SignalCardProps {
  signal: TradeSignal;
  urgency: string;
  expiresIn: number;
}

const SignalCard: React.FC<SignalCardProps> = ({ signal, urgency, expiresIn }) => {
  const [timeLeft, setTimeLeft] = useState(expiresIn);
  const isBuy = signal.direction === 'BUY';
  const isXAUUSD = signal.symbol.includes("XAU") || signal.symbol.includes("GOLD");
  const unit = isXAUUSD ? 'pts' : 'pips';

  useEffect(() => {
    if (timeLeft <= 0) return;
    const timer = setInterval(() => setTimeLeft(t => t - 1), 1000);
    return () => clearInterval(timer);
  }, [timeLeft]);

  return (
    <View style={[styles.card, { borderColor: isBuy ? COLORS.buy : COLORS.sell }]}>
      <View style={styles.header}>
        <View style={styles.symbolRow}>
          <View style={[styles.dot, { backgroundColor: isBuy ? COLORS.buy : COLORS.sell }]} />
          <Text style={TYPOGRAPHY.h3}>{signal.direction} {signal.symbol}</Text>
        </View>
        <Text style={[styles.expiry, { color: timeLeft < 10 ? COLORS.sell : COLORS.textSecondary }]}>
          Expires: {timeLeft}s
        </Text>
      </View>

      <View style={styles.body}>
        <Text style={TYPOGRAPHY.bodyLarge}>Entry: <Text style={TYPOGRAPHY.mono}>{signal.entryPrice}</Text></Text>
        <Text style={TYPOGRAPHY.bodySecondary}>
          Stop: <Text style={[TYPOGRAPHY.mono, { color: COLORS.sell }]}>{signal.stopLoss}</Text> 
          {isBuy ? ' ▼ ' : ' ▲ '} 
          {Math.abs(signal.entryPrice - signal.stopLoss).toFixed(2)} {unit}
        </Text>

        <View style={styles.tpRow}>
          <Text style={TYPOGRAPHY.bodySecondary}>TP1: {signal.takeProfitLevels[0]}</Text>
          <Text style={TYPOGRAPHY.bodySecondary}>TP2: {signal.takeProfitLevels[1]}</Text>
          <Text style={TYPOGRAPHY.bodySecondary}>TP3: {signal.takeProfitLevels[2]}</Text>
        </View>

        <View style={styles.lotsRow}>
          <Text style={TYPOGRAPHY.caption}>E1: {signal.lotSizes.entry1}</Text>
          <Text style={TYPOGRAPHY.caption}>E2: {signal.lotSizes.entry2}</Text>
          <Text style={TYPOGRAPHY.caption}>E3: {signal.lotSizes.entry3}</Text>
        </View>

        <View style={styles.footer}>
          <Text style={TYPOGRAPHY.caption}>Risk: {signal.riskPercent}%</Text>
          <View style={styles.phaseBar}>
            <View style={[styles.phaseDot, { backgroundColor: COLORS.buy }]} />
            <View style={styles.phaseDot} />
            <View style={styles.phaseDot} />
            <View style={styles.phaseDot} />
            <View style={styles.phaseDot} />
          </View>
          <Text style={TYPOGRAPHY.caption}>Phase 1</Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    borderWidth: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.m,
  },
  symbolRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: SPACING.s,
  },
  expiry: {
    ...TYPOGRAPHY.mono,
    fontSize: 12,
  },
  body: {
    gap: SPACING.s,
  },
  tpRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: SPACING.s,
  },
  lotsRow: {
    flexDirection: 'row',
    gap: SPACING.m,
    marginTop: SPACING.xs,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: SPACING.m,
    paddingTop: SPACING.s,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  phaseBar: {
    flexDirection: 'row',
    gap: 4,
  },
  phaseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.border,
  },
});

export default SignalCard;
