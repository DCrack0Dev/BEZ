import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, Alert } from 'react-native';
import { useTradeStore } from '../store/useTradeStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { placeOrder, closeOrder } from '../api/orders';
import AccountCard from '../components/AccountCard';
import TradeButton from '../components/TradeButton';
import PositionCard from '../components/PositionCard';
import ConfirmModal from '../components/ConfirmModal';
import SkeletonLoader from '../components/SkeletonLoader';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';
import { usePolling } from '../hooks/usePolling';

const DashboardScreen = () => {
  const { account, openPositions, isLoading } = useTradeStore();
  const { botSettings } = useSettingsStore();
  const [refreshing, setRefreshing] = useState(false);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<{ type: 'BUY' | 'SELL', symbol: string } | null>(null);

  const selectedSymbol = account.eaSymbol || 'XAUUSD';

  const { refresh } = usePolling();

  const onRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  const handleTradePress = (type: 'BUY' | 'SELL') => {
    setPendingOrder({ type, symbol: selectedSymbol });
    setConfirmVisible(true);
  };

  const handleConfirmOrder = async () => {
    if (!pendingOrder) return;
    setConfirmVisible(false);
    try {
      await placeOrder({
        symbol: pendingOrder.symbol,
        type: pendingOrder.type,
        lots: botSettings.defaultLots
      });
      Alert.alert('Success', 'Order Sent Successfully');
      refresh();
    } catch (error) {
      Alert.alert('Error', 'Failed to place order');
    }
  };

  const handleClosePosition = async (ticket: string) => {
    try {
      await closeOrder(ticket);
      Alert.alert('Success', 'Position Closed');
      refresh();
    } catch (error) {
      Alert.alert('Error', 'Failed to close position');
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
      >
        {isLoading && !refreshing ? (
          <View>
            <SkeletonLoader style={{ height: 160, marginBottom: SPACING.m }} />
            <View style={{ height: 180, backgroundColor: COLORS.card, borderRadius: 16, marginBottom: SPACING.l, padding: SPACING.m }}>
               <SkeletonLoader style={{ height: 20, width: 100, marginBottom: SPACING.m }} />
               <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: SPACING.m }}>
                 <SkeletonLoader style={{ height: 50, flex: 1, marginRight: SPACING.s }} />
                 <SkeletonLoader style={{ height: 50, flex: 1 }} />
               </View>
               <SkeletonLoader style={{ height: 50 }} />
            </View>
          </View>
        ) : (
          <>
            <AccountCard 
              balance={account.balance}
              equity={account.equity}
              pnlToday={account.pnlToday}
              eaConnected={account.eaConnected}
            />

            <View style={styles.tradePanel}>
              <Text style={styles.sectionTitle}>Quick Trade</Text>
              <View style={styles.tradeButtons}>
            <TradeButton 
              title="BUY" 
              type="BUY" 
              onPress={() => handleTradePress('BUY')} 
              disabled={!account.eaConnected}
            />
            <TradeButton 
              title="SELL" 
              type="SELL" 
              onPress={() => handleTradePress('SELL')} 
              disabled={!account.eaConnected}
            />
          </View>
              <View style={styles.symbolSelector}>
                <Text style={TYPOGRAPHY.bodySecondary}>Symbol: {selectedSymbol}</Text>
                <Text style={TYPOGRAPHY.bodySecondary}>Lots: {botSettings.defaultLots}</Text>
              </View>
            </View>
          </>
        )}

        <View style={styles.positionsSection}>
          <Text style={styles.sectionTitle}>Open Positions ({openPositions.length})</Text>
          {isLoading && !refreshing ? (
            <View>
              <SkeletonLoader style={{ height: 100, marginBottom: SPACING.m }} />
              <SkeletonLoader style={{ height: 100, marginBottom: SPACING.m }} />
            </View>
          ) : openPositions.length > 0 ? (
            openPositions.map((pos) => (
              <PositionCard key={pos.ticket} position={pos} onClose={handleClosePosition} />
            ))
          ) : (
            <View style={styles.emptyState}>
              <Text style={TYPOGRAPHY.bodySecondary}>No open positions</Text>
            </View>
          )}
        </View>
      </ScrollView>

      {pendingOrder && (
        <ConfirmModal
          visible={confirmVisible}
          symbol={pendingOrder.symbol}
          direction={pendingOrder.type}
          lots={botSettings.defaultLots}
          sl={botSettings.stopLoss}
          tp={botSettings.takeProfit}
          onConfirm={handleConfirmOrder}
          onCancel={() => setConfirmVisible(false)}
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scrollContent: {
    padding: SPACING.m,
  },
  sectionTitle: {
    ...TYPOGRAPHY.h3,
    marginBottom: SPACING.m,
  },
  tradePanel: {
    marginBottom: SPACING.l,
  },
  tradeButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: SPACING.m,
  },
  symbolSelector: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: COLORS.card,
    padding: SPACING.m,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  positionsSection: {
    marginTop: SPACING.m,
  },
  emptyState: {
    padding: SPACING.xl,
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 12,
    borderStyle: 'dashed',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
});

export default DashboardScreen;
