import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';
import { useTradeStore } from '../store/useTradeStore';

/**
 * TradeMonitor.tsx
 * Live position tracker showing trail progress and phase status.
 */

const TradeMonitor: React.FC = () => {
  const { positions } = useTradeStore();

  return (
    <View style={styles.container}>
      <Text style={[TYPOGRAPHY.h2, { marginBottom: SPACING.m }]}>Active Positions</Text>
      <ScrollView showsVerticalScrollIndicator={false}>
        {positions.map((pos: any) => (
          <View key={pos.ticket} style={styles.monitorCard}>
            <View style={styles.row}>
              <View style={[styles.badge, { backgroundColor: pos.direction === 'BUY' ? COLORS.buy : COLORS.sell }]}>
                <Text style={styles.badgeText}>{pos.direction}</Text>
              </View>
              <Text style={TYPOGRAPHY.h3}>{pos.symbol}</Text>
              <Text style={[TYPOGRAPHY.mono, styles.pnl, { color: pos.profit >= 0 ? COLORS.buy : COLORS.sell }]}>
                {pos.profit >= 0 ? '+$' : '-$'}{Math.abs(pos.profit).toFixed(2)}
              </Text>
            </View>

            <View style={styles.details}>
              <View style={styles.detailRow}>
                <Text style={TYPOGRAPHY.bodySecondary}>Entry: {pos.entryPrice}</Text>
                <Text style={TYPOGRAPHY.bodySecondary}>Current: {pos.currentPrice}</Text>
              </View>
              
              <View style={styles.stopSection}>
                <Text style={TYPOGRAPHY.caption}>Stop Loss Progress</Text>
                <View style={styles.progressBar}>
                  <View style={[styles.progressFill, { width: `${(pos.phase / 5) * 100}%`, backgroundColor: pos.direction === 'BUY' ? COLORS.buy : COLORS.sell }]} />
                </View>
                <View style={styles.detailRow}>
                  <Text style={TYPOGRAPHY.mono}>{pos.currentSL}</Text>
                  {pos.isRiskFree && (
                    <View style={styles.riskFreeBadge}>
                      <Text style={styles.riskFreeText}>RISK FREE ✓</Text>
                    </View>
                  )}
                </View>
              </View>

              <View style={styles.phaseRow}>
                <Text style={TYPOGRAPHY.caption}>Phase {pos.phase} of 5</Text>
                <View style={styles.dots}>
                  {[1, 2, 3, 4, 5].map(p => (
                    <View key={p} style={[styles.dot, { backgroundColor: p <= pos.phase ? (pos.direction === 'BUY' ? COLORS.buy : COLORS.sell) : COLORS.border }]} />
                  ))}
                </View>
              </View>
            </View>
          </View>
        ))}
        {positions.length === 0 && (
          <Text style={[TYPOGRAPHY.bodySecondary, { textAlign: 'center', marginTop: SPACING.xl }]}>
            No active positions
          </Text>
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: SPACING.m,
  },
  monitorCard: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.s,
    marginBottom: SPACING.s,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: '800',
  },
  pnl: {
    marginLeft: 'auto',
    fontSize: 16,
  },
  details: {
    gap: SPACING.s,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  stopSection: {
    marginTop: SPACING.s,
    gap: 4,
  },
  progressBar: {
    height: 4,
    backgroundColor: COLORS.border,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
  },
  riskFreeBadge: {
    backgroundColor: COLORS.buy + '20',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  riskFreeText: {
    color: COLORS.buy,
    fontSize: 10,
    fontWeight: '700',
  },
  phaseRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: SPACING.s,
  },
  dots: {
    flexDirection: 'row',
    gap: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});

export default TradeMonitor;
