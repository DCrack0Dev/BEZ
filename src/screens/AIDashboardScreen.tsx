import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  Alert,
  Dimensions,
} from 'react-native';
import Svg, { Polyline, Line } from 'react-native-svg';
import {
  fetchAIDashboard,
  startAITraining,
  promoteAIModel,
  waitForTraining,
  AIDashboardData,
} from '../api/ai';
import { fetchMonitoring, fetchLearningStatus, runBacktest } from '../api/ops';
import SkeletonLoader from '../components/SkeletonLoader';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';

const CHART_WIDTH = Dimensions.get('window').width - SPACING.m * 4;
const CHART_HEIGHT = 120;

const pct = (n: number | null | undefined, digits = 1) =>
  n == null || !Number.isFinite(Number(n)) ? '—' : `${(Number(n) * 100).toFixed(digits)}%`;

const num = (n: number | null | undefined, digits = 2) =>
  n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(digits);

function MiniEquityChart({ data }: { data: number[] }) {
  if (!data || data.length < 2) {
    return (
      <View style={styles.chartEmpty}>
        <Text style={TYPOGRAPHY.bodySecondary}>No equity data yet</Text>
      </View>
    );
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * CHART_WIDTH;
      const y = CHART_HEIGHT - ((v - min) / range) * (CHART_HEIGHT - 8) - 4;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
      <Line x1={0} y1={CHART_HEIGHT - 1} x2={CHART_WIDTH} y2={CHART_HEIGHT - 1} stroke={COLORS.border} strokeWidth={1} />
      <Polyline points={points} fill="none" stroke={COLORS.primary} strokeWidth={2} />
    </Svg>
  );
}

function MetricTile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <View style={styles.metricTile}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, accent ? { color: accent } : null]}>{value}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const AIDashboardScreen = () => {
  const [data, setData] = useState<AIDashboardData | null>(null);
  const [monitoring, setMonitoring] = useState<any>(null);
  const [learning, setLearning] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [training, setTraining] = useState(false);
  const [backtesting, setBacktesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [dash, mon, learn] = await Promise.all([
        fetchAIDashboard().catch(() => null),
        fetchMonitoring().catch(() => null),
        fetchLearningStatus().catch(() => null),
      ]);
      if (dash) setData(dash);
      if (mon) setMonitoring(mon);
      if (learn) setLearning(learn);
    } catch (e) {
      console.warn('AI dashboard load failed', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const handleBacktest = async () => {
    setBacktesting(true);
    try {
      const result = await runBacktest({ modelVersion: data?.productionVersion || undefined });
      if (result.success === false) {
        Alert.alert('Backtest Failed', result.error || 'Unknown error');
      } else {
        Alert.alert(
          'Backtest Complete',
          `WR ${pct(result.win_rate)} · PF ${num(result.profit_factor)} · Sharpe ${num(result.sharpe_ratio)}\n` +
            `Max DD ${pct(result.max_drawdown)} · Trades ${result.n_trades}\n` +
            `Reports exported to backend/python/reports/`
        );
      }
    } catch (e: any) {
      Alert.alert('Backtest Failed', e?.message || String(e));
    } finally {
      setBacktesting(false);
    }
  };

  const handleTrain = async () => {
    Alert.alert(
      'Train on Cloud',
      'Starts training on your hosted backend (Render). Uses live learning dataset when available. Production is NOT replaced until you tap Promote.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start Training',
          onPress: async () => {
            setTraining(true);
            try {
              const result = await startAITraining({ epochs: 40 });
              if (result.success === false && !result.accepted) {
                Alert.alert('Training Failed', result.error || 'Could not start');
                return;
              }

              // Poll server until COMPLETED / FAILED (async cloud job)
              const finalStatus = await waitForTraining({
                onTick: (s) => {
                  if (s.status === 'RUNNING') {
                    setData((prev) =>
                      prev
                        ? {
                            ...prev,
                            trainingStatus: 'RUNNING',
                            currentTrainingVersion: s.currentVersion,
                          }
                        : prev
                    );
                  }
                },
              });

              if (finalStatus.status === 'COMPLETED' || finalStatus.lastResult?.success) {
                Alert.alert(
                  'Training Complete',
                  `Candidate ${finalStatus.lastResult?.best_candidate || finalStatus.currentVersion || ''} saved on the server.\n` +
                    `Recommendation: ${finalStatus.lastResult?.deployment_recommendation || 'NO'}\n` +
                    `Promote from the model list when ready.`
                );
              } else {
                Alert.alert(
                  'Training Failed',
                  finalStatus.lastResult?.error || finalStatus.lastResult?.message || 'Unknown error'
                );
              }
              await load();
            } catch (e: any) {
              Alert.alert('Training Failed', e?.message || String(e));
            } finally {
              setTraining(false);
            }
          },
        },
      ]
    );
  };

  const handlePromote = (version: string, rec: string) => {
    if (rec !== 'YES') {
      Alert.alert(
        'Not Recommended',
        `${version} does not consistently outperform production. Promote anyway?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Promote Anyway',
            style: 'destructive',
            onPress: () => confirmPromote(version),
          },
        ]
      );
      return;
    }
    confirmPromote(version);
  };

  const confirmPromote = (version: string) => {
    Alert.alert('Promote to Production', `Replace production with ${version}? This is a manual action.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Promote',
        onPress: async () => {
          try {
            const result = await promoteAIModel(version);
            if (result.success) {
              Alert.alert('Promoted', `${version} is now production.`);
              load();
            } else {
              Alert.alert('Failed', result.error || 'Promote failed');
            }
          } catch (e: any) {
            Alert.alert('Failed', e?.message || String(e));
          }
        },
      },
    ]);
  };

  if (loading && !data) {
    return (
      <View style={styles.container}>
        <SkeletonLoader />
      </View>
    );
  }

  const conf = data?.aiConfidence;
  const confColor =
    conf == null ? COLORS.textSecondary : conf >= 0.7 ? COLORS.success : conf >= 0.45 ? COLORS.warning : COLORS.error;

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
      >
        <View style={styles.hero}>
          <View>
            <Text style={styles.heroLabel}>PRODUCTION MODEL</Text>
            <Text style={styles.heroVersion}>{data?.productionVersion || 'None'}</Text>
            <Text style={styles.readOnly}>
              {data?.cloudMode ? 'Cloud backend · ' : 'Local backend · '}
              view only — promote candidates below
            </Text>
          </View>
          <View style={styles.confBlock}>
            <Text style={styles.heroLabel}>AI CONFIDENCE</Text>
            <Text style={[styles.confValue, { color: confColor }]}>{pct(conf, 0)}</Text>
          </View>
        </View>

        <View style={styles.statusRow}>
          <Text style={TYPOGRAPHY.bodySecondary}>Training</Text>
          <Text
            style={[
              styles.statusBadge,
              {
                color:
                  data?.trainingStatus === 'RUNNING'
                    ? COLORS.warning
                    : data?.trainingStatus === 'FAILED'
                      ? COLORS.error
                      : COLORS.success,
              },
            ]}
          >
            {training || data?.trainingStatus === 'RUNNING' ? 'RUNNING' : data?.trainingStatus || 'IDLE'}
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.trainBtn, (training || data?.trainingStatus === 'RUNNING') && styles.trainBtnDisabled]}
          onPress={handleTrain}
          disabled={training || data?.trainingStatus === 'RUNNING'}
        >
          <Text style={styles.trainBtnText}>
            {training || data?.trainingStatus === 'RUNNING' ? 'Training on cloud…' : 'Train on Cloud'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.secondaryBtn, backtesting && styles.trainBtnDisabled]}
          onPress={handleBacktest}
          disabled={backtesting}
        >
          <Text style={styles.secondaryBtnText}>
            {backtesting ? 'Backtesting…' : 'Backtest Production Model'}
          </Text>
        </TouchableOpacity>

        <Section title="System Monitoring">
          <View style={styles.metricGrid}>
            <MetricTile label="API p95" value={`${num(monitoring?.latency?.api?.p95Ms, 0)} ms`} />
            <MetricTile label="Inference p95" value={`${num(monitoring?.latency?.inference?.p95Ms, 0)} ms`} />
            <MetricTile label="Execution p95" value={`${num(monitoring?.latency?.execution?.p95Ms, 0)} ms`} />
            <MetricTile label="DB p95" value={`${num(monitoring?.latency?.database?.p95Ms, 0)} ms`} />
            <MetricTile label="CPU" value={`${num(monitoring?.system?.cpuPercent, 0)}%`} />
            <MetricTile label="RAM" value={`${num(monitoring?.system?.ramPercent, 0)}%`} />
            <MetricTile
              label="Open Alerts"
              value={String(monitoring?.alerts?.open ?? 0)}
              accent={(monitoring?.alerts?.open ?? 0) > 0 ? COLORS.warning : COLORS.success}
            />
            <MetricTile
              label="Broker Fail %"
              value={pct(monitoring?.broker?.failRate)}
              accent={(monitoring?.broker?.failRate ?? 0) > 0.1 ? COLORS.error : COLORS.success}
            />
          </View>
          {(monitoring?.alerts?.recent || []).slice(0, 3).map((a: any) => (
            <Text key={a.id} style={[TYPOGRAPHY.bodySecondary, { marginTop: 6 }]}>
              [{a.severity}] {a.message}
            </Text>
          ))}
        </Section>

        <Section title="Continuous Learning">
          <View style={styles.metricGrid}>
            <MetricTile label="Dataset" value={String(learning?.datasetSize ?? 0)} />
            <MetricTile label="Since Train" value={String(learning?.completedTradesSinceTrain ?? 0)} />
            <MetricTile label="Last Rec" value={learning?.lastRecommendation || '—'} />
            <MetricTile label="Last Model" value={learning?.lastTrainVersion || '—'} />
          </View>
          <Text style={[TYPOGRAPHY.bodySecondary, { marginTop: SPACING.s }]}>
            Live watch: {learning?.liveWatch?.watching ?? 0} open · ready to train:{' '}
            {learning?.readyToTrain ? 'YES' : `need ${(learning?.minSamplesToTrain ?? 20) - (learning?.datasetSize ?? 0)} more`}
          </Text>
          {(learning?.liveWatch?.openTrades || []).slice(0, 5).map((t: any) => (
            <Text key={t.ticket} style={[TYPOGRAPHY.bodySecondary, { marginTop: 4 }]} numberOfLines={2}>
              #{t.ticket} grade {t.lastRating || '—'} ({t.lastScore ?? '—'}) · MFE {num(t.mfePips, 1)} / MAE{' '}
              {num(t.maePips, 1)} · {t.lastAdjustment || 'HOLD'}
            </Text>
          ))}
          {(learning?.recentAnalyses || []).slice(0, 3).map((a: any) => (
            <Text key={a.ticket} style={[TYPOGRAPHY.bodySecondary, { marginTop: 6 }]} numberOfLines={2}>
              {a.ticket}: {a.analysis?.summary}
            </Text>
          ))}
        </Section>

        <Section title="Equity Curve">
          <MiniEquityChart data={data?.equityCurve || []} />
          <View style={styles.metricRow}>
            <MetricTile label="Drawdown" value={pct(data?.drawdown)} accent={COLORS.error} />
            <MetricTile label="Risk Exposure" value={`${num(data?.riskExposure, 1)}%`} accent={COLORS.warning} />
          </View>
        </Section>

        <Section title="Trade Analytics">
          <View style={styles.metricGrid}>
            <MetricTile label="Win Rate" value={pct(data?.tradeAnalytics?.winRate)} />
            <MetricTile label="Profit Factor" value={num(data?.tradeAnalytics?.profitFactor)} />
            <MetricTile label="Avg RR" value={num(data?.tradeAnalytics?.averageRr)} />
            <MetricTile
              label="Total PnL"
              value={num(data?.tradeAnalytics?.totalPnl)}
              accent={(data?.tradeAnalytics?.totalPnl ?? 0) >= 0 ? COLORS.success : COLORS.error}
            />
          </View>
        </Section>

        <Section title="Model Performance">
          {data?.modelPerformance?.production ? (
            <View style={styles.prodCard}>
              <Text style={styles.cardTitle}>Production ({data.productionVersion}) — read only</Text>
              <View style={styles.metricGrid}>
                <MetricTile label="Accuracy" value={pct(data.modelPerformance.production.accuracy)} />
                <MetricTile label="F1" value={pct(data.modelPerformance.production.f1)} />
                <MetricTile label="PF" value={num(data.modelPerformance.production.profit_factor)} />
                <MetricTile label="Sharpe" value={num(data.modelPerformance.production.sharpe_ratio)} />
                <MetricTile label="Max DD" value={pct(data.modelPerformance.production.max_drawdown)} />
                <MetricTile label="Stability" value={pct(data.modelPerformance.production.stability)} />
              </View>
            </View>
          ) : (
            <Text style={TYPOGRAPHY.bodySecondary}>No production metrics yet. Train a candidate first.</Text>
          )}

          {(data?.models || [])
            .filter((m) => !m.is_production)
            .slice(0, 5)
            .map((m) => (
              <View key={m.version} style={styles.candidateCard}>
                <View style={styles.candidateHeader}>
                  <Text style={styles.cardTitle}>{m.version}</Text>
                  <Text
                    style={{
                      color:
                        m.deployment_recommendation === 'YES'
                          ? COLORS.success
                          : m.deployment_recommendation === 'MONITOR'
                            ? COLORS.warning
                            : COLORS.textSecondary,
                      fontWeight: '700',
                    }}
                  >
                    {m.deployment_recommendation || 'NO'}
                  </Text>
                </View>
                <Text style={TYPOGRAPHY.bodySecondary} numberOfLines={2}>
                  {m.recommendation_reason || 'Candidate — compare before promote'}
                </Text>
                <View style={styles.metricGrid}>
                  <MetricTile label="Win Rate" value={pct(m.metrics?.win_rate)} />
                  <MetricTile label="PF" value={num(m.metrics?.profit_factor)} />
                  <MetricTile label="F1" value={pct(m.metrics?.f1)} />
                  <MetricTile label="DD" value={pct(m.metrics?.max_drawdown)} />
                </View>
                <TouchableOpacity
                  style={styles.promoteBtn}
                  onPress={() => handlePromote(m.version, m.deployment_recommendation || 'NO')}
                >
                  <Text style={styles.promoteBtnText}>Promote to Production</Text>
                </TouchableOpacity>
              </View>
            ))}
        </Section>

        <Section title="Prediction History">
          {(data?.predictionHistory || []).length === 0 ? (
            <Text style={TYPOGRAPHY.bodySecondary}>No predictions logged yet</Text>
          ) : (
            (data?.predictionHistory || []).slice(0, 12).map((p) => (
              <View key={p.id} style={styles.rowItem}>
                <Text style={styles.rowMain}>
                  {p.predictedAction} · {pct(p.confidence, 0)}
                </Text>
                <Text style={TYPOGRAPHY.bodySecondary}>
                  {p.modelVersion} {p.symbol ? `· ${p.symbol}` : ''}
                </Text>
              </View>
            ))
          )}
        </Section>

        <Section title="Trade History">
          {(data?.tradeHistory || []).length === 0 ? (
            <Text style={TYPOGRAPHY.bodySecondary}>No journal trades yet</Text>
          ) : (
            (data?.tradeHistory || []).slice(0, 15).map((t, idx) => (
              <View key={`${t.ticket}-${idx}`} style={styles.rowItem}>
                <Text style={styles.rowMain}>
                  {t.direction} {t.symbol} · {t.outcome}
                </Text>
                <Text
                  style={{
                    color: Number(t.profitDollars) >= 0 ? COLORS.success : COLORS.error,
                    fontFamily: TYPOGRAPHY.mono.fontFamily,
                  }}
                >
                  {num(t.profitDollars)} ({num(t.profitPips, 1)} pips)
                </Text>
              </View>
            ))
          )}
        </Section>

        <Section title="Training Runs">
          {(data?.trainingRuns || []).length === 0 ? (
            <Text style={TYPOGRAPHY.bodySecondary}>No training runs yet</Text>
          ) : (
            (data?.trainingRuns || []).slice(0, 8).map((r, idx) => (
              <View key={`${r.version}-${idx}`} style={styles.rowItem}>
                <Text style={styles.rowMain}>
                  {r.version} · {r.status}
                </Text>
                <Text style={TYPOGRAPHY.bodySecondary}>
                  loss {num(r.history_summary?.final_train_loss, 4)} / val{' '}
                  {num(r.history_summary?.final_val_loss, 4)} · F1 {pct(r.history_summary?.final_f1)}
                </Text>
              </View>
            ))
          )}
        </Section>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    padding: SPACING.m,
    paddingBottom: SPACING.xxl,
  },
  hero: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: COLORS.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.m,
    marginBottom: SPACING.m,
  },
  heroLabel: {
    ...TYPOGRAPHY.caption,
    marginBottom: 4,
  },
  heroVersion: {
    ...TYPOGRAPHY.h2,
    color: COLORS.primary,
  },
  readOnly: {
    ...TYPOGRAPHY.bodySecondary,
    marginTop: 4,
    fontSize: 12,
  },
  confBlock: {
    alignItems: 'flex-end',
  },
  confValue: {
    fontSize: 36,
    fontWeight: '700',
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: SPACING.s,
  },
  statusBadge: {
    fontWeight: '700',
    letterSpacing: 1,
  },
  trainBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: SPACING.l,
  },
  trainBtnDisabled: {
    opacity: 0.5,
  },
  trainBtnText: {
    ...TYPOGRAPHY.button,
    color: COLORS.black,
    fontWeight: '700',
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: COLORS.primary,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: SPACING.l,
  },
  secondaryBtnText: {
    ...TYPOGRAPHY.button,
    color: COLORS.primary,
    fontWeight: '700',
  },
  section: {
    marginBottom: SPACING.l,
  },
  sectionTitle: {
    ...TYPOGRAPHY.h3,
    marginBottom: SPACING.s,
  },
  chartEmpty: {
    height: CHART_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 8,
  },
  metricRow: {
    flexDirection: 'row',
    marginTop: SPACING.s,
    gap: SPACING.s,
  },
  metricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.s,
  },
  metricTile: {
    width: '47%',
    backgroundColor: COLORS.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.s,
  },
  metricLabel: {
    ...TYPOGRAPHY.caption,
    fontSize: 10,
  },
  metricValue: {
    ...TYPOGRAPHY.mono,
    fontSize: 18,
    marginTop: 4,
  },
  prodCard: {
    backgroundColor: COLORS.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.primary,
    padding: SPACING.m,
    marginBottom: SPACING.s,
  },
  candidateCard: {
    backgroundColor: COLORS.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.m,
    marginTop: SPACING.s,
  },
  candidateHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  cardTitle: {
    ...TYPOGRAPHY.body,
    fontWeight: '700',
    marginBottom: SPACING.s,
  },
  promoteBtn: {
    marginTop: SPACING.s,
    borderWidth: 1,
    borderColor: COLORS.primary,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  promoteBtnText: {
    color: COLORS.primary,
    fontWeight: '600',
  },
  rowItem: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  rowMain: {
    ...TYPOGRAPHY.body,
    marginBottom: 2,
  },
});

export default AIDashboardScreen;
