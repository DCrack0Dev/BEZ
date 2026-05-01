import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Dimensions, Modal, ActivityIndicator } from 'react-native';
import { VictoryChart, VictoryTheme, VictoryAxis, VictoryCandlestick, VictoryLine, VictoryLabel, VictoryZoomContainer } from 'victory-native';
import SignalBadge from '../components/SignalBadge';
import { useTradeStore } from '../store/useTradeStore';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';
import { MaterialCommunityIcons } from '@expo/vector-icons';

const { width, height: screenHeight } = Dimensions.get('window');

const ChartScreen = () => {
  const { account, openPositions, structures, activeTimeframe, setActiveTimeframe } = useTradeStore();
  const selectedSymbol = account.eaSymbol || 'XAUUSD';
  const [signal, setSignal] = useState<'BUY' | 'SELL' | 'NONE'>('NONE');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoomDomain, setZoomDomain] = useState<any>(null);

  const timeframes = ['M5', 'M15', 'H1', 'H4'];

  // Use real data from EA based on selected timeframe
  const chartData = useMemo(() => {
    // Backend now sends chart data directly for the active timeframe or in the tf key
    const rawData = account.chart && account.chart[activeTimeframe] 
      ? account.chart[activeTimeframe] 
      : (Array.isArray(account.chart) ? account.chart : []);
    
    if (!Array.isArray(rawData) || rawData.length === 0) return [];
    
    return [...rawData]
      .sort((a, b) => a.x - b.x)
      .map(d => ({ ...d, x: new Date(d.x * 1000) })); // Convert unix to Date for Victory
  }, [account.chart, activeTimeframe]);

  // Reset zoom when timeframe changes or data loads
  useEffect(() => {
    if (chartData.length > 0) {
      const lastIdx = chartData.length - 1;
      const firstIdx = Math.max(0, lastIdx - 100); // Show last 100 candles for better analysis
      setZoomDomain({ x: [chartData[firstIdx].x, chartData[lastIdx].x] });
    }
  }, [activeTimeframe, chartData]);

  // Windowing: Only render candles within a reasonable range
  const visibleData = useMemo(() => {
    if (chartData.length === 0) return [];
    if (!zoomDomain || !zoomDomain.x) return chartData.slice(-200);
    
    const [minX, maxX] = zoomDomain.x;
    const minTime = minX instanceof Date ? minX.getTime() : minX;
    const maxTime = maxX instanceof Date ? maxX.getTime() : maxX;
    
    // Buffer of 50 candles for better context
    return chartData.filter(d => {
      const t = d.x.getTime();
      return t >= minTime - (60000 * 50) && t <= maxTime + (60000 * 50);
    });
  }, [chartData, zoomDomain]);

  // Filter positions for current symbol
  const symbolPositions = openPositions.filter(p => p.symbol === selectedSymbol);

  useEffect(() => {
    if (account.fastEMA > account.slowEMA && account.slowEMA > 0) {
      setSignal('BUY');
    } else if (account.fastEMA < account.slowEMA && account.fastEMA > 0) {
      setSignal('SELL');
    } else {
      setSignal('NONE');
    }
  }, [account.fastEMA, account.slowEMA]);

  const renderChart = (isFull: boolean) => {
    const symbolStructures = structures[activeTimeframe] || {};
    const obs = symbolStructures.orderBlocks || [];
    const fvgs = symbolStructures.fvgs || [];

    // When rotated, width becomes height and height becomes width
    const chartWidth = isFull ? screenHeight : width - 32;
    const chartHeight = isFull ? width : 350;

    return (
      <View style={[styles.chartContainer, isFull && styles.fullscreenChart, { backgroundColor: '#FFFFFF' }]}>
        <View style={styles.chartHeader}>
          <Text style={[styles.chartTitle, { color: COLORS.black }]}>{isFull ? `${selectedSymbol} (${activeTimeframe})` : 'Live Chart'}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {isFull && (
               <TouchableOpacity 
                 style={{ marginRight: 25 }}
                 onPress={() => {
                   if (chartData.length > 0) {
                     const lastIdx = chartData.length - 1;
                     const firstIdx = Math.max(0, lastIdx - 30);
                     setZoomDomain({ x: [chartData[firstIdx].x, chartData[lastIdx].x] });
                   }
                 }}
               >
                 <MaterialCommunityIcons name="refresh" size={24} color={COLORS.primary} />
               </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => setIsFullscreen(!isFull)}>
              <MaterialCommunityIcons 
                name={isFull ? "close" : "fullscreen"} 
                size={24} 
                color={COLORS.primary} 
              />
            </TouchableOpacity>
          </View>
        </View>
        
        {chartData.length > 0 ? (
          <VictoryChart
            theme={VictoryTheme.material}
            width={chartWidth}
            height={isFull ? chartHeight - 60 : 300}
            padding={{ top: 10, bottom: 60, left: 60, right: 20 }}
            domainPadding={{ y: 30 }}
            scale={{ x: "time" }}
            containerComponent={
              <VictoryZoomContainer
                zoomDimension="x"
                zoomDomain={zoomDomain}
                onZoomDomainChange={(domain) => setZoomDomain(domain)}
                minimumZoom={{ x: 60000 * 5 }} // Min 5 candles
                allowZoom={true}
                allowPan={true}
              />
            }
            style={{ parent: { backgroundColor: "#FFFFFF" } }}
          >
            <VictoryAxis
              style={{
                axis: { stroke: "#D1D1D1" },
                tickLabels: { fill: "#444444", fontSize: 9, fontFamily: 'System' },
                grid: { stroke: "#F0F0F0", strokeDasharray: '4' },
              }}
            />
            <VictoryAxis
              dependentAxis
              style={{
                axis: { stroke: "#D1D1D1" },
                tickLabels: { fill: "#444444", fontSize: 9, fontFamily: 'System' },
                grid: { stroke: "#F0F0F0", strokeDasharray: '4' },
              }}
            />
            
            {/* Draw FVGs */}
            {fvgs.map((fvg: any, i: number) => {
              const fvgColor = fvg.type === 'BULLISH' ? '#2E7D32' : '#C2185B';
              return (
                <VictoryLine
                  key={`fvg-${i}`}
                  y={() => (fvg.top + fvg.bottom) / 2}
                  style={{ data: { stroke: fvgColor, strokeWidth: 10, strokeOpacity: 0.1 } }}
                />
              );
            })}

            {/* Draw Order Blocks */}
            {obs.map((ob: any, i: number) => {
              const obColor = ob.type === 'BULLISH' ? '#1565C0' : '#E65100';
              return (
                <VictoryLine
                  key={`ob-${i}`}
                  y={() => (ob.top + ob.bottom) / 2}
                  style={{ data: { stroke: obColor, strokeWidth: 15, strokeOpacity: 0.15 } }}
                />
              );
            })}

            <VictoryCandlestick
              data={visibleData}
              candleColors={{ positive: '#00C853', negative: '#FF1744' }}
              style={{
                data: { 
                  strokeWidth: 1, 
                  stroke: ({ datum }: any) => datum.close > datum.open ? '#00C853' : '#FF1744',
                  fill: ({ datum }: any) => datum.close > datum.open ? '#00C853' : '#FF1744',
                  fillOpacity: 0.8,
                },
              }}
            />
            
            {/* Entry Overlays */}
            {symbolPositions.map((pos) => {
              const openPrice = Number(pos.openPrice || 0);
              const slPrice = Number(pos.sl || 0);
              const tpPrice = Number(pos.tp || 0);
              
              return (
                <React.Fragment key={`pos-${pos.ticket}`}>
                  {openPrice > 0 && (
                    <VictoryLine
                      y={() => openPrice}
                      style={{ data: { stroke: '#2196F3', strokeWidth: 1.5, strokeDasharray: '4,4' } }}
                    />
                  )}
                  {slPrice > 0 && (
                    <VictoryLine
                      y={() => slPrice}
                      style={{ data: { stroke: '#D50000', strokeWidth: 1, strokeDasharray: '2,2' } }}
                    />
                  )}
                  {tpPrice > 0 && (
                    <VictoryLine
                      y={() => tpPrice}
                      style={{ data: { stroke: '#00A152', strokeWidth: 1, strokeDasharray: '2,2' } }}
                    />
                  )}
                </React.Fragment>
              );
            })}

            {/* Current Price Line */}
            {account.price > 0 && (
              <VictoryLine
                y={() => account.price}
                style={{ data: { stroke: "#666666", strokeWidth: 1 } }}
              />
            )}
          </VictoryChart>
        ) : (
          <View style={{ height: isFull ? chartHeight : 260, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator color={COLORS.primary} />
            <Text style={{ color: "#888888", marginTop: 10 }}>Syncing {activeTimeframe} Candles...</Text>
          </View>
        )}
      </View>
    );
  };

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
              style={[styles.tfButton, activeTimeframe === tf && styles.tfButtonActive]}
              onPress={() => setActiveTimeframe(tf)}
            >
              <Text style={[styles.tfText, activeTimeframe === tf && styles.tfTextActive]}>{tf}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {renderChart(false)}

      <Modal visible={isFullscreen} animationType="slide" transparent={false}>
        <View style={styles.fullscreenContainer}>
          <View style={styles.fullscreenHeader}>
            <Text style={styles.fullscreenTitle}>{selectedSymbol} ({activeTimeframe})</Text>
            <TouchableOpacity onPress={() => setIsFullscreen(false)}>
              <MaterialCommunityIcons name="close" size={28} color={COLORS.primary} />
            </TouchableOpacity>
          </View>
          {(() => {
            const symbolStructures = structures[activeTimeframe] || {};
            const obs = symbolStructures.orderBlocks || [];
            const fvgs = symbolStructures.fvgs || [];
            
            return (
              <VictoryChart
            theme={VictoryTheme.material}
            width={width - 20}
            height={screenHeight - 120}
            padding={{ top: 20, bottom: 80, left: 60, right: 20 }}
            domainPadding={{ y: 30 }}
            scale={{ x: "time" }}
            containerComponent={
              <VictoryZoomContainer
                zoomDimension="x"
                zoomDomain={zoomDomain}
                onZoomDomainChange={(domain) => setZoomDomain(domain)}
                minimumZoom={{ x: 60000 * 5 }}
                allowZoom={true}
                allowPan={true}
              />
            }
            style={{ parent: { backgroundColor: "#FFFFFF" } }}
          >
            <VictoryAxis
              style={{
                axis: { stroke: "#D1D1D1" },
                tickLabels: { fill: "#444444", fontSize: 10, fontFamily: 'System' },
                grid: { stroke: "#F0F0F0", strokeDasharray: '4' },
              }}
            />
            <VictoryAxis
              dependentAxis
              style={{
                axis: { stroke: "#D1D1D1" },
                tickLabels: { fill: "#444444", fontSize: 10, fontFamily: 'System' },
                grid: { stroke: "#F0F0F0", strokeDasharray: '4' },
              }}
            />
            
            {/* Draw FVGs */}
            {fvgs.map((fvg: any, i: number) => {
              const fvgColor = fvg.type === 'BULLISH' ? '#2E7D32' : '#C2185B';
              return (
                <VictoryLine
                  key={`fvg-${i}`}
                  y={() => (fvg.top + fvg.bottom) / 2}
                  style={{ data: { stroke: fvgColor, strokeWidth: 10, strokeOpacity: 0.1 } }}
                />
              );
            })}

            {/* Draw Order Blocks */}
            {obs.map((ob: any, i: number) => {
              const obColor = ob.type === 'BULLISH' ? '#1565C0' : '#E65100';
              return (
                <VictoryLine
                  key={`ob-${i}`}
                  y={() => (ob.top + ob.bottom) / 2}
                  style={{ data: { stroke: obColor, strokeWidth: 15, strokeOpacity: 0.15 } }}
                />
              );
            })}

            <VictoryCandlestick
              data={visibleData}
              candleColors={{ positive: '#00C853', negative: '#FF1744' }}
              style={{
                data: { 
                  strokeWidth: 1, 
                  stroke: ({ datum }: any) => datum.close > datum.open ? '#00C853' : '#FF1744',
                  fill: ({ datum }: any) => datum.close > datum.open ? '#00C853' : '#FF1744',
                  fillOpacity: 0.8,
                },
              }}
            />
            
            {/* Entry Overlays */}
            {symbolPositions.map((pos) => {
              const openPrice = Number(pos.openPrice || 0);
              const slPrice = Number(pos.sl || 0);
              const tpPrice = Number(pos.tp || 0);
              
              return (
                <React.Fragment key={`pos-${pos.ticket}`}>
                  {openPrice > 0 && (
                    <VictoryLine
                      y={() => openPrice}
                      style={{ data: { stroke: '#2196F3', strokeWidth: 1.5, strokeDasharray: '4,4' } }}
                    />
                  )}
                  {slPrice > 0 && (
                    <VictoryLine
                      y={() => slPrice}
                      style={{ data: { stroke: '#D50000', strokeWidth: 1, strokeDasharray: '2,2' } }}
                    />
                  )}
                  {tpPrice > 0 && (
                    <VictoryLine
                      y={() => tpPrice}
                      style={{ data: { stroke: '#00A152', strokeWidth: 1, strokeDasharray: '2,2' } }}
                    />
                  )}
                </React.Fragment>
              );
            })}

            {/* Current Price Line */}
            {account.price > 0 && (
              <VictoryLine
                y={() => account.price}
                style={{ data: { stroke: "#666666", strokeWidth: 1 } }}
              />
            )}
          </VictoryChart>
            );
          })()}
        </View>
      </Modal>

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
    padding: SPACING.s,
  },
  chartHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.s,
    marginBottom: SPACING.s,
  },
  chartTitle: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
    fontWeight: 'bold',
  },
  fullscreenContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  fullscreenHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  fullscreenTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#000000',
  },
  fullscreenChart: {
    margin: 0,
    width: screenHeight,
    height: width,
    borderRadius: 0,
    borderWidth: 0,
    position: 'absolute',
    top: (screenHeight - width) / -2,
    left: (width - screenHeight) / -2,
    transform: [{ rotate: '90deg' }],
    zIndex: 999,
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
