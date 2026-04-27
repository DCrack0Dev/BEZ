import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';

interface AccountCardProps {
  balance: number;
  equity: number;
  pnlToday: number;
  eaConnected: boolean;
}

const AccountCard: React.FC<AccountCardProps> = ({ balance, equity, pnlToday, eaConnected }) => {
  const isPositive = pnlToday >= 0;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View>
          <Text style={TYPOGRAPHY.caption}>Account Balance</Text>
          <Text style={styles.balance}>${balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: eaConnected ? COLORS.buy + '20' : COLORS.sell + '20' }]}>
          <View style={[styles.statusDot, { backgroundColor: eaConnected ? COLORS.buy : COLORS.sell }]} />
          <Text style={[styles.statusText, { color: eaConnected ? COLORS.buy : COLORS.sell }]}>
            {eaConnected ? 'EA Connected' : 'EA Offline'}
          </Text>
        </View>
      </View>

      <View style={styles.footer}>
        <View>
          <Text style={TYPOGRAPHY.caption}>Equity</Text>
          <Text style={TYPOGRAPHY.mono}>${equity.toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text>
        </View>
        <View style={styles.pnlContainer}>
          <Text style={[TYPOGRAPHY.caption, { textAlign: 'right' }]}>Today's P&L</Text>
          <Text style={[TYPOGRAPHY.mono, { color: isPositive ? COLORS.buy : COLORS.sell }]}>
            {isPositive ? '+' : ''}{pnlToday.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </Text>
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
    marginVertical: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: SPACING.l,
  },
  balance: {
    ...TYPOGRAPHY.h2,
    marginTop: SPACING.xs,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.s,
    paddingVertical: SPACING.xs,
    borderRadius: 20,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: SPACING.xs,
  },
  statusText: {
    ...TYPOGRAPHY.caption,
    fontSize: 10,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  pnlContainer: {
    alignItems: 'flex-end',
  },
});

export default AccountCard;
