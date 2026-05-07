import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Dimensions,
  InteractionManager,
  LayoutChangeEvent,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as ScreenOrientation from 'expo-screen-orientation';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import SignalBadge from '../components/SignalBadge';
import { useTradeStore } from '../store/useTradeStore';
import { COLORS } from '../theme/colors';
import { SPACING } from '../theme/spacing';
import { TYPOGRAPHY } from '../theme/typography';

type Timeframe = 'M5' | 'M15' | 'H1' | 'H4';
type RawCandle = { x?: number; time?: number; open: number; high: number; low: number; close: number; tick_volume?: number; volume?: number };
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type CandleMap = Record<Timeframe, Candle[]>;
type ChartOverlay = { id: string; price: number; label: string; color: string };
type TradeVisual = {
  ticket: string;
  symbol: string;
  type: 'BUY' | 'SELL';
  openPrice: number;
  sl?: number;
  tp?: number;
  status: 'open' | 'closed';
  closedAt?: number;
};

const TF_COUNTS: Record<Timeframe, number> = { M5: 288, M15: 96, H1: 24, H4: 6 };
const TF_INTERVAL_SECONDS: Record<Timeframe, number> = { M5: 300, M15: 900, H1: 3600, H4: 14400 };
const timeframes: Timeframe[] = ['M5', 'M15', 'H1', 'H4'];
const CLOSED_LINE_FADE_MS = 12000;

const makeChartHtml = (width: number, height: number) => `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <style>
    html, body, #chart { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #ffffff; }
  </style>
  <script src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
</head>
<body>
  <div id="chart"></div>
  <script>
    let chart = null;
    let candleSeries = null;
    let overlaySeries = [];
    let latestCandles = [];
    function initChart() {
      chart = LightweightCharts.createChart(document.getElementById('chart'), {
        width: ${Math.max(50, Math.floor(width))},
        height: ${Math.max(50, Math.floor(height))},
        layout: { background: { color: '#ffffff' }, textColor: '#333' },
        grid: { vertLines: { color: '#f0f0f0' }, horzLines: { color: '#f0f0f0' } },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: '#ccc' },
        timeScale: {
          borderColor: '#ccc',
          timeVisible: true,
          secondsVisible: false,
          fixLeftEdge: false,
          fixRightEdge: false
        },
        handleScroll: true,
        handleScale: true
      });
      candleSeries = chart.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350'
      });
    }
    function clearOverlays() {
      if (!chart || !Array.isArray(overlaySeries)) return;
      overlaySeries.forEach((s) => {
        try { chart.removeSeries(s); } catch (e) {}
      });
      overlaySeries = [];
    }
    function applyOverlays(overlays) {
      if (!chart || !Array.isArray(latestCandles) || latestCandles.length === 0) return;
      clearOverlays();
      const from = latestCandles[Math.max(0, latestCandles.length - 120)].time;
      const to = latestCandles[latestCandles.length - 1].time;
      (Array.isArray(overlays) ? overlays : []).forEach((o) => {
        if (!o || typeof o.price !== 'number') return;
        const line = chart.addLineSeries({
          color: o.color || '#999999',
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Solid,
          priceLineVisible: true,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        line.setData([{ time: from, value: o.price }, { time: to, value: o.price }]);
        line.createPriceLine({
          price: o.price,
          color: o.color || '#999999',
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: o.label || '',
        });
        overlaySeries.push(line);
      });
    }
    function applyData(candles) {
      if (!candleSeries || !Array.isArray(candles)) return;
      candleSeries.setData(candles);
      latestCandles = candles;
      chart.timeScale().fitContent();
      const len = candles.length;
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - 60), to: len });
    }
    function onMessage(raw) {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'SET_DATA') applyData(msg.payload.candles || []);
        if (msg.type === 'SET_OVERLAYS') applyOverlays(msg.payload.overlays || []);
        if (msg.type === 'RESIZE' && chart) chart.applyOptions({ width: msg.payload.width, height: msg.payload.height });
      } catch (e) {}
    }
    document.addEventListener('message', (e) => onMessage(e.data));
    window.addEventListener('message', (e) => onMessage(e.data));
    window.addEventListener('beforeunload', () => { if (chart) chart.remove(); });
    initChart();
  </script>
</body>
</html>`;

const roundToBucket = (ts: number, interval: number) => Math.floor(ts / interval) * interval;

const generateNextCandle = (time: number, open: number, interval: number): Candle => {
  const tfFactor = interval / 300;
  const drift = (Math.random() - 0.5) * 0.0022 * tfFactor;
  const close = Math.max(0.00001, open * (1 + drift));
  const body = Math.abs(close - open);
  const maxWick = Math.max(open * 0.0009 * tfFactor, body * 2.2);
  const upperWick = Math.random() * maxWick;
  const lowerWick = Math.random() * maxWick;
  const high = Math.max(open, close) + upperWick;
  const low = Math.max(0.00001, Math.min(open, close) - lowerWick);
  const volume = Math.round(200 + Math.random() * 800 * tfFactor);
  return { time, open, high, low, close, volume };
};

const normalizeCandles = (raw: RawCandle[], timeframe: Timeframe, fallbackPrice: number): Candle[] => {
  const interval = TF_INTERVAL_SECONDS[timeframe];
  const count = TF_COUNTS[timeframe];
  const nowSec = Math.floor(Date.now() / 1000);
  const endTime = roundToBucket(nowSec, interval);
  const startTime = endTime - (count - 1) * interval;

  const sanitized = (Array.isArray(raw) ? raw : [])
    .map((c) => {
      const t = Number(c.x ?? c.time ?? 0);
      const open = Number(c.open);
      const high = Number(c.high);
      const low = Number(c.low);
      const close = Number(c.close);
      const volume = Number(c.tick_volume ?? c.volume ?? 0);
      if (!t || !open || !high || !low || !close) return null;
      return {
        time: roundToBucket(t, interval),
        open,
        high: Math.max(high, open, close),
        low: Math.min(low, open, close),
        close,
        volume: Math.max(1, volume || 1),
      } as Candle;
    })
    .filter((c): c is Candle => Boolean(c))
    .filter((c) => c.time >= startTime && c.time <= endTime)
    .sort((a, b) => a.time - b.time);

  const byTime = new Map<number, Candle>();
  sanitized.forEach((c) => byTime.set(c.time, c));

  const output: Candle[] = [];
  let prevClose = fallbackPrice > 0 ? fallbackPrice : 4500;
  for (let i = 0; i < count; i++) {
    const t = startTime + i * interval;
    const existing = byTime.get(t);
    if (existing) {
      output.push(existing);
      prevClose = existing.close;
    } else {
      const mock = generateNextCandle(t, prevClose, interval);
      output.push(mock);
      prevClose = mock.close;
    }
  }
  return output;
};

const getRawForTf = (chart: any, tf: Timeframe): RawCandle[] => {
  if (!chart) return [];
  if (Array.isArray(chart)) return chart as RawCandle[];
  if (Array.isArray(chart[tf])) return chart[tf] as RawCandle[];
  return [];
};

const toSeriesData = (candles: Candle[]) =>
  candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));

const hexToRgba = (hex: string, alpha: number) => {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) return `rgba(128,128,128,${alpha})`;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
};

const ChartScreen = () => {
  const { account, openPositions, activeTimeframe, setActiveTimeframe } = useTradeStore();
  const selectedSymbol = account.eaSymbol || 'BTCUSD';
  const [signal, setSignal] = useState<'BUY' | 'SELL' | 'NONE'>('NONE');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isSwitchingTimeframe, setIsSwitchingTimeframe] = useState(false);
  const [chartReady, setChartReady] = useState(false);
  const [cachedCandles, setCachedCandles] = useState<CandleMap>({ M5: [], M15: [], H1: [], H4: [] });
  const cacheRef = useRef<{ updatedAt: number }>({ updatedAt: 0 });
  const chartWebRef = useRef<WebView>(null);
  const fullChartWebRef = useRef<WebView>(null);
  const { width, height } = Dimensions.get('window');
  const [inlineChartSize, setInlineChartSize] = useState({ width: Math.max(120, width - SPACING.m * 2 - SPACING.s * 2), height: 300 });
  const [fullChartSize, setFullChartSize] = useState({ width: Math.max(120, height), height: Math.max(120, width) });
  const [tradeVisuals, setTradeVisuals] = useState<Record<string, TradeVisual>>({});
  const [fadeTick, setFadeTick] = useState(0);

  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => setChartReady(true));
    return () => task.cancel();
  }, []);

  useEffect(() => {
    const now = Date.now();
    if (now - cacheRef.current.updatedAt < 15000 && cacheRef.current.updatedAt !== 0) return;
    const fallback = account.price || 4500;
    const next: CandleMap = {
      M5: normalizeCandles(getRawForTf(account.chart, 'M5'), 'M5', fallback),
      M15: normalizeCandles(getRawForTf(account.chart, 'M15'), 'M15', fallback),
      H1: normalizeCandles(getRawForTf(account.chart, 'H1'), 'H1', fallback),
      H4: normalizeCandles(getRawForTf(account.chart, 'H4'), 'H4', fallback),
    };
    setCachedCandles(next);
    cacheRef.current.updatedAt = now;
  }, [account.chart, account.price]);

  useEffect(() => {
    if (account.fastEMA > account.slowEMA && account.slowEMA > 0) setSignal('BUY');
    else if (account.fastEMA < account.slowEMA && account.fastEMA > 0) setSignal('SELL');
    else setSignal('NONE');
  }, [account.fastEMA, account.slowEMA]);

  useEffect(() => {
    setTradeVisuals((prev) => {
      const next: Record<string, TradeVisual> = { ...prev };
      const openMap = new Map(openPositions.map((p) => [String(p.ticket), p]));
      const now = Date.now();

      Object.entries(next).forEach(([ticket, visual]) => {
        if (!openMap.has(ticket) && visual.status === 'open') {
          next[ticket] = { ...visual, status: 'closed', closedAt: now };
        }
      });

      openPositions.forEach((pos) => {
        const ticket = String(pos.ticket);
        next[ticket] = {
          ticket,
          symbol: String(pos.symbol || selectedSymbol),
          type: pos.type,
          openPrice: Number(pos.openPrice || 0),
          sl: pos.sl,
          tp: pos.tp,
          status: 'open',
        };
      });

      Object.entries(next).forEach(([ticket, visual]) => {
        if (visual.status === 'closed' && visual.closedAt && now - visual.closedAt > CLOSED_LINE_FADE_MS) {
          delete next[ticket];
        }
      });

      return next;
    });
  }, [openPositions, selectedSymbol]);

  useEffect(() => {
    const id = setInterval(() => setFadeTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const seriesData = useMemo(() => {
    const tf = (activeTimeframe as Timeframe) || 'M15';
    return toSeriesData(cachedCandles[tf] || []);
  }, [activeTimeframe, cachedCandles]);

  const overlays = useMemo<ChartOverlay[]>(() => {
    const now = Date.now();
    const rows: ChartOverlay[] = [];
    const sorted = Object.values(tradeVisuals).filter((t) => t.symbol === selectedSymbol);

    sorted.forEach((t) => {
      const fadeRatio =
        t.status === 'closed' && t.closedAt
          ? Math.max(0, 1 - (now - t.closedAt) / CLOSED_LINE_FADE_MS)
          : 1;
      if (fadeRatio <= 0) return;

      const alpha = Math.max(0.18, fadeRatio);
      const sideColor = t.type === 'BUY' ? '#1E88E5' : '#E53935';
      const slColor = '#FB8C00';
      const tpColor = '#43A047';

      if (t.openPrice > 0) {
        rows.push({
          id: `${t.ticket}-entry`,
          price: t.openPrice,
          label: `#${t.ticket} ENTRY`,
          color: hexToRgba(sideColor, alpha),
        });
      }
      if ((t.sl || 0) > 0) {
        rows.push({
          id: `${t.ticket}-sl`,
          price: Number(t.sl),
          label: `#${t.ticket} SL`,
          color: hexToRgba(slColor, alpha),
        });
      }
      if ((t.tp || 0) > 0) {
        rows.push({
          id: `${t.ticket}-tp`,
          price: Number(t.tp),
          label: `#${t.ticket} TP`,
          color: hexToRgba(tpColor, alpha),
        });
      }
    });

    return rows;
  }, [tradeVisuals, selectedSymbol, fadeTick]);

  const postDataToChart = (target: React.RefObject<WebView>, chartWidth: number, chartHeight: number) => {
    if (!target.current || seriesData.length === 0) return;
    requestAnimationFrame(() => {
      target.current?.postMessage(
        JSON.stringify({ type: 'RESIZE', payload: { width: Math.floor(chartWidth), height: Math.floor(chartHeight) } }),
      );
      target.current?.postMessage(JSON.stringify({ type: 'SET_DATA', payload: { candles: seriesData } }));
      target.current?.postMessage(JSON.stringify({ type: 'SET_OVERLAYS', payload: { overlays } }));
    });
  };

  useEffect(() => {
    if (!chartReady || isSwitchingTimeframe) return;
    postDataToChart(chartWebRef, inlineChartSize.width, inlineChartSize.height);
  }, [chartReady, seriesData, overlays, isSwitchingTimeframe, inlineChartSize.width, inlineChartSize.height]);

  useEffect(() => {
    if (!chartReady || !isFullscreen || isSwitchingTimeframe) return;
    postDataToChart(fullChartWebRef, fullChartSize.width, fullChartSize.height);
  }, [chartReady, seriesData, overlays, isFullscreen, isSwitchingTimeframe, fullChartSize.width, fullChartSize.height]);

  const onChangeTimeframe = (tf: Timeframe) => {
    if (tf === activeTimeframe) return;
    setIsSwitchingTimeframe(true);
    setActiveTimeframe(tf);
    setTimeout(() => setIsSwitchingTimeframe(false), 220);
  };

  const openFullscreen = async () => {
    setIsFullscreen(true);
    // Use InteractionManager to ensure the modal starts opening before the orientation lock blocks the thread
    InteractionManager.runAfterInteractions(async () => {
      try {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
      } catch (e) {
        console.log('[CHART] Orientation lock failed', e);
      }
    });
  };

  const closeFullscreen = async () => {
    // Immediately hide the modal for instant feedback
    setIsFullscreen(false);
    
    // Perform the orientation change in the background
    InteractionManager.runAfterInteractions(async () => {
      try {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      } catch (e) {
        console.log('[CHART] Orientation unlock failed', e);
      }
    });
  };

  useEffect(() => {
    if (isFullscreen) {
      const backAction = () => {
        closeFullscreen();
        return true;
      };
      const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
      return () => backHandler.remove();
    }
  }, [isFullscreen]);

  useEffect(() => {
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    };
  }, []);

  const chartHtml = useMemo(
    () => makeChartHtml(inlineChartSize.width, inlineChartSize.height),
    [inlineChartSize.width, inlineChartSize.height],
  );
  const fullChartHtml = useMemo(
    () => makeChartHtml(fullChartSize.width, fullChartSize.height),
    [fullChartSize.width, fullChartSize.height],
  );

  const onInlineChartLayout = (e: LayoutChangeEvent) => {
    const w = Math.max(120, Math.floor(e.nativeEvent.layout.width));
    const h = Math.max(220, Math.floor(e.nativeEvent.layout.height));
    setInlineChartSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
  };

  const onFullChartLayout = (e: LayoutChangeEvent) => {
    const w = Math.max(120, Math.floor(e.nativeEvent.layout.width));
    const h = Math.max(120, Math.floor(e.nativeEvent.layout.height));
    setFullChartSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
  };

  return (
    <View style={styles.container}>
      <ScrollView 
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View>
            <Text style={TYPOGRAPHY.h2}>{selectedSymbol}</Text>
            <Text style={[TYPOGRAPHY.h3, { color: COLORS.primary, marginTop: 4 }]}>
              {account.price ? account.price.toFixed(5) : '-'}
            </Text>
          </View>
          <View style={styles.timeframeContainer}>
            {timeframes.map((tf) => (
              <TouchableOpacity
                key={tf}
                style={[styles.tfButton, activeTimeframe === tf && styles.tfButtonActive]}
                onPress={() => onChangeTimeframe(tf)}
              >
                <Text style={[styles.tfText, activeTimeframe === tf && styles.tfTextActive]}>{tf}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={styles.chartContainer} pointerEvents="box-none">
          <View style={styles.chartHeader}>
            <Text style={styles.chartTitle}>Live Chart</Text>
            <TouchableOpacity onPress={openFullscreen}>
              <MaterialCommunityIcons name="fullscreen" size={24} color={COLORS.primary} />
            </TouchableOpacity>
          </View>

          {isSwitchingTimeframe ? (
            <View style={styles.loaderWrap}>
              <ActivityIndicator color={COLORS.primary} />
            </View>
          ) : (
            <View style={styles.webChart} onLayout={onInlineChartLayout}>
              <WebView
                key={`inline-${inlineChartSize.width}x${inlineChartSize.height}`}
                ref={chartWebRef}
                source={{ html: chartHtml }}
                style={styles.webChartInner}
                originWhitelist={['*']}
                javaScriptEnabled
                domStorageEnabled
                scrollEnabled={false}
                nestedScrollEnabled
                androidLayerType="hardware"
                onLoadEnd={() => postDataToChart(chartWebRef, inlineChartSize.width, inlineChartSize.height)}
              />
            </View>
          )}
        </View>

        <View style={styles.signalSection}>
          <Text style={styles.sectionTitle}>Technical Analysis</Text>
          <SignalBadge signal={signal} />
          <View style={styles.indicators}>
            <View style={styles.indicatorRow}>
              <Text style={TYPOGRAPHY.bodySecondary}>EMA 8</Text>
              <Text style={[TYPOGRAPHY.body, { color: COLORS.primary }]}>{account.fastEMA ? account.fastEMA.toFixed(5) : '-'}</Text>
            </View>
            <View style={styles.indicatorRow}>
              <Text style={TYPOGRAPHY.bodySecondary}>EMA 21</Text>
              <Text style={[TYPOGRAPHY.body, { color: '#FFA000' }]}>{account.slowEMA ? account.slowEMA.toFixed(5) : '-'}</Text>
            </View>
            <View style={styles.indicatorRow}>
              <Text style={TYPOGRAPHY.bodySecondary}>Bollinger Bands</Text>
              <Text style={TYPOGRAPHY.body}>
                {account.bbLower ? account.bbLower.toFixed(5) : '-'} - {account.bbUpper ? account.bbUpper.toFixed(5) : '-'}
              </Text>
            </View>
            <View style={styles.indicatorRow}>
              <Text style={TYPOGRAPHY.bodySecondary}>RSI (M5)</Text>
              <Text style={[TYPOGRAPHY.body, { color: COLORS.primary }]}>{account.rsi ? account.rsi.toFixed(2) : '-'}</Text>
            </View>
          </View>
        </View>
      </ScrollView>

      <Modal visible={isFullscreen} animationType="slide" transparent={false} statusBarTranslucent>
        <View style={styles.fullscreenContainer}>
          <View style={styles.fullscreenHeader}>
            <View style={styles.fullscreenTitleRow}>
              <Text style={styles.fullscreenTitle}>{selectedSymbol} ({activeTimeframe})</Text>
              <Text style={styles.fullscreenPrice}>{account.price ? account.price.toFixed(5) : '-'}</Text>
            </View>
            <TouchableOpacity 
              onPress={closeFullscreen} 
              style={styles.fullscreenCloseBtn}
              activeOpacity={0.7}
            >
              <MaterialCommunityIcons name="close-circle" size={32} color={COLORS.primary} />
            </TouchableOpacity>
          </View>
          {isSwitchingTimeframe ? (
            <View style={styles.fullLoaderWrap}>
              <ActivityIndicator color={COLORS.primary} size="large" />
            </View>
          ) : (
            <View style={styles.webChartFull} onLayout={onFullChartLayout}>
              <WebView
                key={`full-${fullChartSize.width}x${fullChartSize.height}`}
                ref={fullChartWebRef}
                source={{ html: fullChartHtml }}
                style={styles.webChartFullInner}
                originWhitelist={['*']}
                javaScriptEnabled
                domStorageEnabled
                scrollEnabled={false}
                nestedScrollEnabled
                androidLayerType="hardware"
                onLoadEnd={() => postDataToChart(fullChartWebRef, fullChartSize.width, fullChartSize.height)}
              />
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  scrollContent: { paddingBottom: SPACING.xl },
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
  tfButton: { paddingHorizontal: SPACING.s, paddingVertical: 4, borderRadius: 6 },
  tfButtonActive: { backgroundColor: COLORS.primary },
  tfText: { ...TYPOGRAPHY.caption, color: COLORS.textSecondary },
  tfTextActive: { color: COLORS.black, fontWeight: 'bold' },
  chartContainer: {
    backgroundColor: COLORS.card,
    marginHorizontal: SPACING.m,
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
  chartTitle: { ...TYPOGRAPHY.caption, color: COLORS.textSecondary, fontWeight: 'bold' },
  webChart: { height: 300, backgroundColor: '#FFFFFF', borderRadius: 12, overflow: 'hidden' },
  webChartInner: { flex: 1, backgroundColor: '#FFFFFF' },
  loaderWrap: { height: 300, justifyContent: 'center', alignItems: 'center' },
  fullscreenContainer: { flex: 1, backgroundColor: '#FFFFFF' },
  fullscreenHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.s,
    borderBottomColor: '#E0E0E0',
    borderBottomWidth: 1,
    backgroundColor: '#FFFFFF',
    zIndex: 10,
  },
  fullscreenTitleRow: { flexDirection: 'row', alignItems: 'center' },
  fullscreenTitle: { fontSize: 18, fontWeight: 'bold', color: '#000', marginRight: SPACING.m },
  fullscreenPrice: { fontSize: 16, color: COLORS.primary, fontWeight: '600' },
  fullscreenCloseBtn: { padding: SPACING.s },
  webChartFull: { flex: 1, backgroundColor: '#FFFFFF' },
  webChartFullInner: { flex: 1, backgroundColor: '#FFFFFF' },
  fullLoaderWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  signalSection: { padding: SPACING.m },
  sectionTitle: { ...TYPOGRAPHY.h3, marginBottom: SPACING.m, textAlign: 'center' },
  indicators: {
    marginTop: SPACING.m,
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
