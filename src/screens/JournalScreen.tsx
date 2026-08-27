import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity, InteractionManager } from 'react-native';
import { getClosedOrders } from '../api/orders';
import SkeletonLoader from '../components/SkeletonLoader';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';

import { useTradeStore } from '../store/useTradeStore';

type JournalTrade = {
  id: string;
  ticket: string;
  symbol: string;
  type: 'BUY' | 'SELL';
  lots: number;
  pnl: number;
  openPrice: number;
  closePrice: number;
  sl: number;
  tp: number;
  closeReason: string;
  openTime: string;
  closeTime: string;
  openDateTime: string;
  closeDateTime: string;
  duration: string;
};

const JournalScreen = () => {
  const { account } = useTradeStore();
  const [filter, setFilter] = useState<'today' | 'week' | 'month'>('today');
  const [rawResponse, setRawResponse] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [flippedTradeId, setFlippedTradeId] = useState<string | null>(null);
  const fetchInFlight = useRef(false);
  const pendingFilter = useRef<'today' | 'week' | 'month' | null>(null);
  const lastFilterTap = useRef<number>(0);
  const filterDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currency = account?.currency || 'USD';
  const symbol = currency === 'USD' ? '$' : (currency === 'ZAR' ? 'R' : (currency === 'GBP' ? '£' : (currency === 'EUR' ? '€' : currency)));

  const toNumber = (...vals: any[]) => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  };

  const toDate = (...vals: any[]) => {
    for (const raw of vals) {
      if (raw === null || raw === undefined || raw === '') continue;
      if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;

      if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw))) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) {
          const asMs = n > 1e12 ? n : n * 1000;
          const d = new Date(asMs);
          if (!Number.isNaN(d.getTime())) return d;
        }
      }

      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return null;
  };

  const formatDuration = (openDate: Date | null, closeDate: Date | null) => {
    if (!openDate || !closeDate) return '-';
    const totalSec = Math.floor(Math.abs(closeDate.getTime() - openDate.getTime()) / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}m ${secs}s`;
  };

  const inferCloseReason = (raw: any, closePrice: number, sl: number, tp: number, type: 'BUY' | 'SELL') => {
    const directReason = String(raw?.closeReason || raw?.reason || raw?.exitReason || '').toUpperCase();
    if (directReason.includes('SL') || directReason.includes('STOP')) return 'Stop Loss';
    if (directReason.includes('TP') || directReason.includes('TAKE')) return 'Take Profit';
    if (directReason.includes('MANUAL')) return 'Manual';
    if (directReason.includes('TIME')) return 'Time Exit';

    const threshold = Math.max(Math.abs(closePrice) * 0.0002, 0.05);
    if (sl > 0 && Math.abs(closePrice - sl) <= threshold) return 'Stop Loss';
    if (tp > 0 && Math.abs(closePrice - tp) <= threshold) return 'Take Profit';
    if (type === 'BUY' && sl > 0 && closePrice < sl) return 'Stop Loss';
    if (type === 'SELL' && sl > 0 && closePrice > sl) return 'Stop Loss';
    if (type === 'BUY' && tp > 0 && closePrice > tp) return 'Take Profit';
    if (type === 'SELL' && tp > 0 && closePrice < tp) return 'Take Profit';
    return 'Market Exit';
  };

  const fetchTrades = useCallback(async (rangeOverride?: 'today' | 'week' | 'month') => {
    const range = rangeOverride || filter;
    if (fetchInFlight.current) {
      pendingFilter.current = range;
      return;
    }
    fetchInFlight.current = true;
    setLoading(true);
    try {
      const data = await getClosedOrders(range);
      setRawResponse(data);
    } catch (error) {
      console.error('Failed to fetch trades');
    } finally {
      fetchInFlight.current = false;
      setLoading(false);
      if (pendingFilter.current && pendingFilter.current !== range) {
        const next = pendingFilter.current;
        pendingFilter.current = null;
        InteractionManager.runAfterInteractions(() => fetchTrades(next));
      } else {
        pendingFilter.current = null;
      }
    }
  }, [filter]);

  useEffect(() => {
    fetchTrades(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const { trades, summary } = useMemo(() => {
    const eaSymbol = account?.eaSymbol || 'XAUUSD';
    const formatted: JournalTrade[] = rawResponse.map((t: any) => {
      const oTime = toDate(t.openTime, t.open_time, t.openedAt, t.timeOpen, t.time_open, t.entryTime, t.date);
      const cTime = toDate(t.closeTime, t.close_time, t.closedAt, t.timeClose, t.time_close, t.exitTime, t.date);
      const durationStr = formatDuration(oTime, cTime);
      const tradeType: 'BUY' | 'SELL' = String(t.type || t.direction || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
      const openPrice = toNumber(t.openPrice, t.priceOpen, t.entryPrice, t.open_price, t.price_open, t.price);
      const closePrice = toNumber(t.closePrice, t.priceClose, t.exitPrice, t.close_price, t.price_close);
      const sl = toNumber(t.sl, t.stopLoss, t.stop_loss, t.StopLoss);
      const tp = toNumber(t.tp, t.takeProfit, t.take_profit, t.TakeProfit, t.tp1);
      const lots = toNumber(t.lots, t.volume, t.lotSize, t.size);
      const pnl = toNumber(t.profitDollars, t.profit, t.pnl, t.pnlFinal);
      return {
        id: String(t.id || t.ticket || String(Math.random())),
        ticket: String(t.ticket || t.id || '-'),
        symbol: t.symbol || eaSymbol,
        type: tradeType,
        lots,
        pnl,
        openPrice,
        closePrice,
        sl,
        tp,
        closeReason: inferCloseReason(t, closePrice, sl, tp, tradeType),
        openTime: oTime ? oTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-',
        closeTime: cTime ? cTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-',
        openDateTime: oTime ? oTime.toLocaleString() : '-',
        closeDateTime: cTime ? cTime.toLocaleString() : '-',
        duration: durationStr,
      };
    });
    const totalPnl = formatted.reduce((acc: number, curr) => acc + curr.pnl, 0);
    const wins = formatted.filter((t) => t.pnl > 0.00001).length;
    return {
      trades: formatted,
      summary: {
        total: formatted.length,
        winRate: formatted.length > 0 ? Math.round((wins / formatted.length) * 100) : 0,
        pnl: totalPnl,
      },
    };
  }, [rawResponse, account?.eaSymbol]);

  const changeFilter = (next: 'today' | 'week' | 'month') => {
    const now = Date.now();
    if (now - lastFilterTap.current < 250) return;
    lastFilterTap.current = now;
    if (filterDebounceTimer.current) clearTimeout(filterDebounceTimer.current);
    filterDebounceTimer.current = setTimeout(() => {
      setFilter(next);
    }, 120);
  };

  return (
    <View style={styles.container}>
      <View style={styles.filterBar}>
        {(['today', 'week', 'month'] as const).map((f) => (
          <TouchableOpacity
            key={f}
            style={[styles.filterButton, filter === f && styles.filterButtonActive]}
            onPress={() => changeFilter(f)}
            disabled={loading}
            activeOpacity={0.8}
          >
            <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => fetchTrades()} tintColor={COLORS.primary} />}
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
                  {summary.pnl >= 0 ? '+' : ''}{symbol}{summary.pnl.toFixed(2)}
                </Text>
              </View>
            </View>

            <Text style={styles.sectionTitle}>Recent Trades</Text>
            {trades.map((trade) => (
              <TouchableOpacity
                key={trade.id}
                activeOpacity={0.9}
                onPress={() => setFlippedTradeId((prev) => (prev === trade.id ? null : trade.id))}
                style={styles.tradeCard}
              >
                {flippedTradeId !== trade.id ? (
                  <>
                    <View style={styles.tradeHeader}>
                      <View>
                        <Text style={TYPOGRAPHY.h3}>{trade.symbol}</Text>
                        <Text style={[TYPOGRAPHY.caption, { color: trade.type === 'BUY' ? COLORS.buy : COLORS.sell }]}>
                          {trade.type}
                        </Text>
                      </View>
                      <Text style={[TYPOGRAPHY.mono, { color: trade.pnl >= 0 ? COLORS.buy : COLORS.sell, fontSize: 18 }]}>
                        {trade.pnl >= 0 ? '+' : ''}{symbol}{trade.pnl.toFixed(2)}
                      </Text>
                    </View>
                    <View style={styles.tradeFooter}>
                      <Text style={TYPOGRAPHY.bodySecondary}>{trade.openTime} - {trade.closeTime}</Text>
                      <Text style={TYPOGRAPHY.bodySecondary}>Dur: {trade.duration}</Text>
                    </View>
                    <Text style={styles.flipHint}>Tap for details</Text>
                  </>
                ) : (
                  <>
                    <View style={styles.tradeHeader}>
                      <Text style={TYPOGRAPHY.h3}>{trade.symbol} #{trade.ticket}</Text>
                      <Text style={[TYPOGRAPHY.caption, { color: trade.type === 'BUY' ? COLORS.buy : COLORS.sell }]}>
                        {trade.type}
                      </Text>
                    </View>
                    <View style={styles.detailsGrid}>
                      <View style={styles.detailRow}><Text style={styles.detailKey}>Lots</Text><Text style={styles.detailVal}>{trade.lots > 0 ? trade.lots.toFixed(2) : '-'}</Text></View>
                      <View style={styles.detailRow}><Text style={styles.detailKey}>Open</Text><Text style={styles.detailVal}>{trade.openPrice > 0 ? trade.openPrice.toFixed(3) : '-'}</Text></View>
                      <View style={styles.detailRow}><Text style={styles.detailKey}>Close</Text><Text style={styles.detailVal}>{trade.closePrice > 0 ? trade.closePrice.toFixed(3) : '-'}</Text></View>
                      <View style={styles.detailRow}><Text style={styles.detailKey}>SL</Text><Text style={styles.detailVal}>{trade.sl > 0 ? trade.sl.toFixed(3) : '-'}</Text></View>
                      <View style={styles.detailRow}><Text style={styles.detailKey}>TP</Text><Text style={styles.detailVal}>{trade.tp > 0 ? trade.tp.toFixed(3) : '-'}</Text></View>
                      <View style={styles.detailRow}><Text style={styles.detailKey}>Closed By</Text><Text style={styles.detailVal}>{trade.closeReason}</Text></View>
                      <View style={styles.detailRow}><Text style={styles.detailKey}>Opened</Text><Text style={styles.detailVal}>{trade.openDateTime}</Text></View>
                      <View style={styles.detailRow}><Text style={styles.detailKey}>Closed</Text><Text style={styles.detailVal}>{trade.closeDateTime}</Text></View>
                      <View style={styles.detailRow}><Text style={styles.detailKey}>Duration</Text><Text style={styles.detailVal}>{trade.duration}</Text></View>
                      <View style={styles.detailRow}><Text style={styles.detailKey}>P&L</Text><Text style={[styles.detailVal, { color: trade.pnl >= 0 ? COLORS.buy : COLORS.sell }]}>{trade.pnl >= 0 ? '+' : ''}{symbol}{trade.pnl.toFixed(2)}</Text></View>
                    </View>
                    <Text style={styles.flipHint}>Tap to go back</Text>
                  </>
                )}
              </TouchableOpacity>
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
  flipHint: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
    marginTop: SPACING.s,
    textAlign: 'right',
  },
  detailsGrid: {
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: SPACING.s,
    gap: 6,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  detailKey: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
  },
  detailVal: {
    ...TYPOGRAPHY.body,
    color: COLORS.textPrimary,
    marginLeft: SPACING.s,
    flexShrink: 1,
    textAlign: 'right',
  },
});

export default JournalScreen;
