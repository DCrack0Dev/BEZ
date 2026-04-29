import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Dimensions } from 'react-native';
import { VictoryChart, VictoryLine, VictoryTheme, VictoryAxis, VictoryCandlestick } from 'victory-native';
import { getSignal } from '../api/signal';
import SignalBadge from '../components/SignalBadge';
import { useTradeStore } from '../store/useTradeStore';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';

const { width } = Dimensions.get('window');

const ChartScreen = () => {
  const { account } = useTradeStore();
  const selectedSymbol = account.eaSymbol || 'XAUUSD';
  const [timeframe, setTimeframe] = useState('M5');
  const [signal, setSignal] = useState<'BUY' | 'SELL' | 'NONE'>('NONE');

  const timeframes = ['M1', 'M5', 'M15', 'M30', 'H1'];

  // Use real data from EA based on selected timeframe, fallback to empty array
  const chartData = account.chart && account.chart[timeframe] && Array.isArray(account.chart[timeframe]) 
    ? account.chart[timeframe] 
    : (Array.isArray(account.chart) ? account.chart : []);

  useEffect(() => {
    if (account.fastEMA > account.slowEMA && account.slowEMA > 0) {
      setSignal('BUY');
    } else if (account.fastEMA < account.slowEMA && account.fastEMA > 0) {
      setSignal('SELL');
    } else {
      setSignal('NONE');
    }
  }, [account.fastEMA, account.slowEMA]);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={TYPOGRAPHY.h2}>{selectedSymbol}</Text>
          {account.price !== undefined && account.price > 0 && (
            <Text style={[TYPOGRAPHY.h3, { color: COLORS.primary, marginTop: 4 }]}>
              {account.price.toFixed(5)}
            </Text>
          )}
        </View>
        <View style={styles.timeframeContainer}>
          {timeframes.map((tf) => (
            <TouchableOpacity
              key={tf}
              style={[styles.tfButton, timeframe === tf && styles.tfButtonActive]}
              onPress={() => setTimeframe(tf)}
            >
              <Text style={[styles.tfText, timeframe === tf && styles.tfTextActive]}>{tf}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.chartContainer}>
        <VictoryChart
          theme={VictoryTheme.material}
          width={width - 32}
          height={300}
          padding={{ top: 20, bottom: 40, left: 60, right: 20 }}
          domainPadding={{ x: 10, y: 10 }}
        >
          <VictoryAxis
            style={{
              axis: { stroke: COLORS.border },
              tickLabels: { fill: COLORS.textSecondary, fontSize: 10, fontFamily: 'System' },
              grid: { stroke: COLORS.border, strokeDasharray: '4' },
            }}
          />
          <VictoryAxis
            dependentAxis
            style={{
              axis: { stroke: COLORS.border },
              tickLabels: { fill: COLORS.textSecondary, fontSize: 10, fontFamily: 'System' },
              grid: { stroke: COLORS.border, strokeDasharray: '4' },
            }}
          />
          {chartData.length > 0 ? (
            <VictoryCandlestick
              data={chartData}
              candleColors={{ positive: COLORS.buy, negative: COLORS.sell }}
              style={{
                data: { strokeWidth: 1 },
              }}
            />
          ) : (
            <View style={{ position: 'absolute', top: 140, alignSelf: 'center' }}>
              <Text style={{ color: COLORS.textSecondary, fontFamily: 'System' }}>Waiting for chart data...</Text>
            </View>
          )}
        </VictoryChart>
      </View>

      <View style={styles.signalSection}>
        <Text style={styles.sectionTitle}>Technical Analysis</Text>
        <SignalBadge signal={signal} />
        <View style={styles.indicators}>
          <View style={styles.indicatorRow}>
            <Text style={TYPOGRAPHY.bodySecondary}>EMA 8</Text>
            <Text style={[TYPOGRAPHY.body, { color: COLORS.primary }]}>
              {account.fastEMA ? account.fastEMA.toFixed(5) : '-'}
            </Text>
          </View>
          <View style={styles.indicatorRow}>
            <Text style={TYPOGRAPHY.bodySecondary}>EMA 21</Text>
            <Text style={[TYPOGRAPHY.body, { color: '#FFA000' }]}>
              {account.slowEMA ? account.slowEMA.toFixed(5) : '-'}
            </Text>
          </View>
          <View style={styles.indicatorRow}>
            <Text style={TYPOGRAPHY.bodySecondary}>Bollinger Bands</Text>
            <Text style={TYPOGRAPHY.body}>
              {account.bbLower ? account.bbLower.toFixed(5) : '-'} - {account.bbUpper ? account.bbUpper.toFixed(5) : '-'}
            </Text>
          </View>
          <View style={styles.indicatorRow}>
            <Text style={TYPOGRAPHY.bodySecondary}>RSI (M5)</Text>
            <Text style={[TYPOGRAPHY.body, { color: COLORS.primary }]}>
              {account.rsi ? account.rsi.toFixed(2) : '-'}
            </Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    padding: SPACING.m,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  timeframeContainer: {
    flexDirection: 'row',
    backgroundColor: COLORS.card,
    borderRadius: 8,
    padding: 2,
  },
  tfButton: {
    paddingHorizontal: SPACING.s,
    paddingVertical: 4,
    borderRadius: 6,
  },
  tfButtonActive: {
    backgroundColor: COLORS.primary,
  },
  tfText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
  },
  tfTextActive: {
    color: COLORS.black,
    fontWeight: 'bold',
  },
  chartContainer: {
    backgroundColor: COLORS.card,
    margin: SPACING.m,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  signalSection: {
    padding: SPACING.m,
  },
  sectionTitle: {
    ...TYPOGRAPHY.h3,
    marginBottom: SPACING.m,
    textAlign: 'center',
  },
  indicators: {
    marginTop: SPACING.l,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: SPACING.m,
  },
  indicatorRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: SPACING.s,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
});

export default ChartScreen;
