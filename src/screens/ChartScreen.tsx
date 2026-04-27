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

  // Mock data for chart
  const mockChartData = [
    { x: 1, open: 2345, close: 2348, high: 2350, low: 2344 },
    { x: 2, open: 2348, close: 2346, high: 2349, low: 2345 },
    { x: 3, open: 2346, close: 2350, high: 2352, low: 2345 },
    { x: 4, open: 2350, close: 2352, high: 2355, low: 2349 },
    { x: 5, open: 2352, close: 2351, high: 2353, low: 2350 },
    { x: 6, open: 2351, close: 2355, high: 2358, low: 2350 },
  ];

  useEffect(() => {
    const fetchSignal = async () => {
      try {
        const data = await getSignal(selectedSymbol, timeframe);
        setSignal(data.signal);
      } catch (error) {
        console.error('Failed to fetch signal');
      }
    };
    fetchSignal();
  }, [selectedSymbol, timeframe]);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={TYPOGRAPHY.h2}>{selectedSymbol}</Text>
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
          padding={{ top: 20, bottom: 40, left: 50, right: 20 }}
        >
          <VictoryAxis
            style={{
              axis: { stroke: COLORS.border },
              tickLabels: { fill: COLORS.textSecondary, fontSize: 10 },
              grid: { stroke: COLORS.border, strokeDasharray: '4' },
            }}
          />
          <VictoryAxis
            dependentAxis
            style={{
              axis: { stroke: COLORS.border },
              tickLabels: { fill: COLORS.textSecondary, fontSize: 10 },
              grid: { stroke: COLORS.border, strokeDasharray: '4' },
            }}
          />
          <VictoryCandlestick
            data={mockChartData}
            candleColors={{ positive: COLORS.buy, negative: COLORS.sell }}
            style={{
              data: { strokeWidth: 1 },
            }}
          />
        </VictoryChart>
      </View>

      <View style={styles.signalSection}>
        <Text style={styles.sectionTitle}>Technical Analysis</Text>
        <SignalBadge signal={signal} />
        <View style={styles.indicators}>
          <View style={styles.indicatorRow}>
            <Text style={TYPOGRAPHY.bodySecondary}>EMA 8</Text>
            <Text style={[TYPOGRAPHY.body, { color: COLORS.primary }]}>2352.45</Text>
          </View>
          <View style={styles.indicatorRow}>
            <Text style={TYPOGRAPHY.bodySecondary}>EMA 21</Text>
            <Text style={[TYPOGRAPHY.body, { color: '#FFA000' }]}>2348.12</Text>
          </View>
          <View style={styles.indicatorRow}>
            <Text style={TYPOGRAPHY.bodySecondary}>Bollinger Bands</Text>
            <Text style={TYPOGRAPHY.body}>2340.0 - 2360.0</Text>
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
