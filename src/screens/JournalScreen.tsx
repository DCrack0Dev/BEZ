import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { getClosedOrders } from '../api/orders';
import SkeletonLoader from '../components/SkeletonLoader';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';

const JournalScreen = () => {
  const [filter, setFilter] = useState<'today' | 'week' | 'month'>('today');
  const [trades, setTrades] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState({ total: 0, winRate: 0, pnl: 0 });

  const fetchTrades = async () => {
    setLoading(true);
    try {
      const data = await getClosedOrders(filter);
      
      // Transform backend data if needed, or use directly
      const formattedTrades = data.map((t: any) => ({
        id: t.id,
        symbol: t.symbol,
        type: t.type,
        pnl: t.profit || 0,
        openTime: new Date(t.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        closeTime: new Date(t.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        duration: '-', // Backend currently doesn't track duration directly without open time
      }));
      
      setTrades(formattedTrades);
      
      const totalPnl = formattedTrades.reduce((acc: number, curr: any) => acc + curr.pnl, 0);
      const wins = formattedTrades.filter((t: any) => t.pnl > 0).length;
      
      setSummary({
        total: formattedTrades.length,
        winRate: formattedTrades.length > 0 ? Math.round((wins / formattedTrades.length) * 100) : 0,
        pnl: totalPnl
      });
    } catch (error) {
      console.error('Failed to fetch trades');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTrades();
  }, [filter]);

  return (
    <View style={styles.container}>
      <View style={styles.filterBar}>
        {(['today', 'week', 'month'] as const).map((f) => (
          <TouchableOpacity
            key={f}
            style={[styles.filterButton, filter === f && styles.filterButtonActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={fetchTrades} tintColor={COLORS.primary} />}
      >
        {loading && trades.length === 0 ? (
          <View>
            <SkeletonLoader style={{ height: 100, borderRadius: 16, marginBottom: SPACING.l }} />
            <SkeletonLoader style={{ height: 25, width: 150, marginBottom: SPACING.m }} />
            <SkeletonLoader style={{ height: 120, borderRadius: 12, marginBottom: SPACING.m }} />
            <SkeletonLoader style={{ height: 120, borderRadius: 12, marginBottom: SPACING.m }} />
            <SkeletonLoader style={{ height: 120, borderRadius: 12, marginBottom: SPACING.m }} />
          </View>
        ) : (
          <>
            <View style={styles.summaryCard}>
              <View style={styles.summaryItem}>
                <Text style={TYPOGRAPHY.caption}>Trades</Text>
                <Text style={TYPOGRAPHY.h3}>{summary.total}</Text>
              </View>
              <View style={styles.summaryItem}>
                <Text style={TYPOGRAPHY.caption}>Win Rate</Text>
                <Text style={[TYPOGRAPHY.h3, { color: COLORS.primary }]}>{summary.winRate}%</Text>
              </View>
              <View style={styles.summaryItem}>
                <Text style={TYPOGRAPHY.caption}>Total P&L</Text>
                <Text style={[TYPOGRAPHY.h3, { color: summary.pnl >= 0 ? COLORS.buy : COLORS.sell }]}>
                  {summary.pnl >= 0 ? '+' : ''}{summary.pnl.toFixed(2)}
                </Text>
              </View>
            </View>

            <Text style={styles.sectionTitle}>Recent Trades</Text>
            {trades.map((trade) => (
              <View key={trade.id} style={styles.tradeCard}>
                <View style={styles.tradeHeader}>
                  <View>
                    <Text style={TYPOGRAPHY.h3}>{trade.symbol}</Text>
                    <Text style={[TYPOGRAPHY.caption, { color: trade.type === 'BUY' ? COLORS.buy : COLORS.sell }]}>
                      {trade.type}
                    </Text>
                  </View>
                  <Text style={[TYPOGRAPHY.mono, { color: trade.pnl >= 0 ? COLORS.buy : COLORS.sell, fontSize: 18 }]}>
                    {trade.pnl >= 0 ? '+' : ''}{trade.pnl.toFixed(2)}
                  </Text>
                </View>
                <View style={styles.tradeFooter}>
                  <Text style={TYPOGRAPHY.bodySecondary}>{trade.openTime} - {trade.closeTime}</Text>
                  <Text style={TYPOGRAPHY.bodySecondary}>Dur: {trade.duration}</Text>
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  filterBar: {
    flexDirection: 'row',
    backgroundColor: COLORS.card,
    padding: SPACING.s,
    margin: SPACING.m,
    borderRadius: 12,
  },
  filterButton: {
    flex: 1,
    paddingVertical: SPACING.s,
    alignItems: 'center',
    borderRadius: 8,
  },
  filterButtonActive: {
    backgroundColor: COLORS.primary,
  },
  filterText: {
    ...TYPOGRAPHY.button,
    fontSize: 12,
    color: COLORS.textSecondary,
  },
  filterTextActive: {
    color: COLORS.black,
  },
  scrollContent: {
    padding: SPACING.m,
  },
  summaryCard: {
    flexDirection: 'row',
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: SPACING.m,
    marginBottom: SPACING.l,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  summaryItem: {
    flex: 1,
    alignItems: 'center',
  },
  sectionTitle: {
    ...TYPOGRAPHY.h3,
    marginBottom: SPACING.m,
  },
  tradeCard: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: SPACING.m,
    marginBottom: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  tradeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.s,
  },
  tradeFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: SPACING.s,
  },
});

export default JournalScreen;
