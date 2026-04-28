import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';
import { Position } from '../store/useTradeStore';

interface PositionCardProps {
  position: Position;
  onClose: (ticket: string) => void;
}

const PositionCard: React.FC<PositionCardProps> = ({ position, onClose }) => {
  const isBuy = position.type === 'BUY';
  const isPositive = position.pnl >= 0;

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View>
          <View style={styles.symbolRow}>
            <Text style={TYPOGRAPHY.h3}>{position.symbol}</Text>
            <View style={[styles.badge, { backgroundColor: isBuy ? COLORS.buy + '20' : COLORS.sell + '20' }]}>
              <Text style={[styles.badgeText, { color: isBuy ? COLORS.buy : COLORS.sell }]}>{position.type}</Text>
            </View>
            <Text style={styles.lots}>{position.lots} Lots</Text>
          </View>
          <Text style={TYPOGRAPHY.bodySecondary}>Open: {position.openPrice}</Text>
        </View>
        <View style={styles.pnlContainer}>
          <Text style={[TYPOGRAPHY.mono, { color: isPositive ? COLORS.buy : COLORS.sell, fontSize: 18 }]}>
            {isPositive ? '+' : ''}{(position.pnl || 0).toFixed(2)}
          </Text>
          <Text style={TYPOGRAPHY.bodySecondary}>Price: {position.currentPrice}</Text>
        </View>
      </View>
      <TouchableOpacity 
        style={styles.closeButton} 
        onPress={() => onClose(position.ticket)}
      >
        <Text style={styles.closeButtonText}>Close Position</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.m,
  },
  symbolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  badge: {
    paddingHorizontal: SPACING.s,
    paddingVertical: 2,
    borderRadius: 4,
    marginHorizontal: SPACING.s,
  },
  badgeText: {
    ...TYPOGRAPHY.caption,
    fontSize: 10,
    fontWeight: '700',
  },
  lots: {
    ...TYPOGRAPHY.bodySecondary,
    fontSize: 12,
  },
  pnlContainer: {
    alignItems: 'flex-end',
  },
  closeButton: {
    backgroundColor: COLORS.border,
    paddingVertical: SPACING.s,
    borderRadius: 8,
    alignItems: 'center',
  },
  closeButtonText: {
    ...TYPOGRAPHY.button,
    fontSize: 14,
    color: COLORS.textPrimary,
  },
});

export default PositionCard;
