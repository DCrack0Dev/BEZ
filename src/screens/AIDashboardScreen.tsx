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
  Platform,
} from 'react-native';
import Svg, { Polyline, Line } from 'react-native-svg';
import {
  fetchAIDashboard,
  startAITraining,
  promoteAIModel,
  waitForTraining,
  fetchTrainingStatus,
  cancelAITraining,
  AIDashboardData,
  TrainingStatusPayload,
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

const formatSeconds = (s: number | null | undefined) => {
  const v = Math.max(0, Math.floor(Number(s ?? 0)));
  const m = Math.floor(v / 60);
  const r = v % 60;
  return m > 0 ? `${m}m ${r.toString().padStart(2, '0')}s` : `${r}s`;
};

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
  const [cancelTrainRunning, setCancelTrainRunning] = useState(false);
  const [tailExpanded, setTailExpanded] = useState(false);
  const [trainingProgress, setTrainingProgress] = useState<{
    progressPct: number; elapsedSec: number; remainingSec: number; epochsTotal: number; epochSecondsEstimate: number; deadlineSec?: number; deadlineLeftSec?: number;
  } | null>(null);
  const [latestTrainingTick, setLatestTrainingTick] = useState<TrainingStatusPayload | null>(null);

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

  /**
   * If dashboard reports RUNNING training (e.g. user left the screen then came back)
   * keep a parallel 4s poll on /training/status to drive the progress bar + elapsed timer.
   * The dedicated waitForTraining() poll inside handleTrain ALREADY sets this while the
   * dialog flow is live — this effect just ensures the bar moves after navigating back.
   */
  useEffect(() => {
    if (data?.trainingStatus !== 'RUNNING' && !training) {
      if (trainingProgress && data?.trainingStatus) {
        setTrainingProgress(null);
      }
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        const s = await fetchTrainingStatus();
        if (!alive) return;
        setLatestTrainingTick(s);
        if (s.progress) setTrainingProgress(s.progress);
        if (s.status === 'COMPLETED' || s.status === 'FAILED') {
          setTrainingProgress(null);
          await load();
          if (timer) clearInterval(timer);
        }
      } catch { /* ignore poll failures */ }
    };
    tick();
    timer = setInterval(tick, 4000);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.trainingStatus, training]);

  /**
   * Frontend watchdog: if user sits on RUNNING and we've been at progress>0.9 for
   * significantly longer than 2× the original total estimate → auto-fire cancel
   * (server-side watchdog also does this, but belt-and-suspenders prevents a
   * broken server-watchdog from causing "99% forever" on the client).
   */
  useEffect(() => {
    if (!trainingProgress || !latestTrainingTick || (latestTrainingTick.status !== 'RUNNING')) return;
    const totalEst = Math.max(60, (trainingProgress.epochsTotal || 40) * (trainingProgress.epochSecondsEstimate || 90));
    const elapsed = trainingProgress.elapsedSec ?? 0;
    if (elapsed > 2 * totalEst && trainingProgress.progressPct >= 0.9) {
      // Auto-cancel once after 2× estimate and high progress stalled
      cancelAITraining(`Frontend watchdog: past 2× estimate (${2 * totalEst}s) at progress=${(trainingProgress.progressPct * 100).toFixed(0)}%`)
        .then(async () => {
          const s = await fetchTrainingStatus();
          setLatestTrainingTick(s);
          if (s.progress) setTrainingProgress(s.progress);
          setData((prev) => prev ? { ...prev, trainingStatus: s.status, currentTrainingVersion: s.currentVersion } : prev);
          await load();
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trainingProgress?.elapsedSec]);

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

              const refreshDashboard = async () => {
                try {
                  const fresh = await fetchAIDashboard();
                  setData(fresh);
                } catch { /* swallow — poll continues */ }
              };

              const finalStatus = await waitForTraining({
                onTick: (s) => {
                  setLatestTrainingTick(s);
                  if (s.progress) setTrainingProgress(s.progress);
                  setData((prev) =>
                    prev
                      ? {
                          ...prev,
                          trainingStatus: s.status,
                          currentTrainingVersion: s.currentVersion,
                        }
                      : prev
                  );
                  if ((s.progress?.elapsedSec ?? 0) % 12 < 4) {
                    refreshDashboard();
                  }
                },
              });
              setTrainingProgress(null);
              setLatestTrainingTick(finalStatus);

              await refreshDashboard();

              if (finalStatus.status === 'COMPLETED' || finalStatus.lastResult?.success) {
                const promotedNow = finalStatus.bestCandidate?.version;
                Alert.alert(
                  'Training Complete',
                  `Candidate ${finalStatus.lastResult?.best_candidate || finalStatus.currentVersion || promotedNow || ''} saved on the server.\n` +
                    `Recommendation: ${finalStatus.lastResult?.deployment_recommendation || finalStatus.bestCandidate?.deployment_recommendation || 'NO'}\n` +
                    `Promote from the model list below, or use the "Promote now" banner at the top of Model Performance.`
                );
              } else {
                const parts: string[] = [];
                if (finalStatus.lastResult?.error) parts.push(finalStatus.lastResult.error);
                if (finalStatus.stderrTail) parts.push('stderr tail:\n' + finalStatus.stderrTail);
                if (finalStatus.stdoutTail) parts.push('stdout tail:\n' + finalStatus.stdoutTail);
                Alert.alert(
                  'Training Failed',
                  parts.join('\n----\n') || finalStatus.lastResult?.message || 'Unknown error'
                );
              }
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

  const handleCancelTrain = () => {
    Alert.alert('Cancel Training', 'Kill the running training job on the server? Progress is lost.', [
      { text: 'Keep waiting', style: 'cancel' },
      {
        text: 'Cancel job',
        style: 'destructive',
        onPress: async () => {
          setCancelTrainRunning(true);
          try {
            await cancelAITraining('User canceled from AI Lab screen');
            const s = await fetchTrainingStatus();
            setLatestTrainingTick(s);
            if (s.progress) setTrainingProgress(s.progress);
            setData((prev) =>
              prev ? { ...prev, trainingStatus: s.status, currentTrainingVersion: s.currentVersion } : prev
            );
            await load();
          } catch (e: any) {
            Alert.alert('Cancel failed', e?.message || String(e));
          } finally {
            setCancelTrainRunning(false);
          }
        },
      },
    ]);
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

        {(training || data?.trainingStatus === 'RUNNING') && trainingProgress ? (
          <View style={styles.progressWrap}>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${Math.max(2, Math.min(100, trainingProgress.progressPct * 100)).toFixed(1)}%` as any,
                    backgroundColor:
                      data?.trainingStatus === 'FAILED'
                        ? COLORS.error
                        : data?.trainingStatus === 'COMPLETED'
                          ? COLORS.success
                          : COLORS.primary,
                  },
                ]}
              />
            </View>
            <View style={styles.progressMeta}>
              <Text style={TYPOGRAPHY.bodySecondary}>
                {Math.round(trainingProgress.progressPct * 100)}%
                {' · '}
                {trainingProgress.epochsTotal} epochs
                {' · '}
                ~{trainingProgress.epochSecondsEstimate}s/ep
                {trainingProgress.deadlineLeftSec ? ` · timeout ${formatSeconds(trainingProgress.deadlineLeftSec)} left` : ''}
              </Text>
              <Text style={TYPOGRAPHY.bodySecondary}>
                Elapsed {formatSeconds(trainingProgress.elapsedSec)}
                {' · '}
                Remaining ~{formatSeconds(trainingProgress.remainingSec)}
              </Text>
            </View>
            <View style={styles.cancelTrainRow}>
              <TouchableOpacity
                style={[styles.secondaryBtnSmall, styles.cancelTrainBtn, cancelTrainRunning && styles.trainBtnDisabled]}
                onPress={handleCancelTrain}
                disabled={cancelTrainRunning}
              >
                <Text style={styles.cancelTrainBtnText}>
                  {cancelTrainRunning ? 'Canceling…' : 'Cancel training'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.secondaryBtnSmall}
                onPress={() => setTailExpanded((v) => !v)}
              >
                <Text style={styles.secondaryBtnTextSmall}>
                  {tailExpanded ? 'Hide logs' : 'Show logs'}
                </Text>
              </TouchableOpacity>
            </View>
            {tailExpanded ? (
              <View style={styles.tailPanel}>
                <Text style={[TYPOGRAPHY.bodySecondary, { color: COLORS.textSecondary }]}>stderr</Text>
                <Text selectable style={styles.tailText}>
                  {(latestTrainingTick?.stderrTail || data?.trainingStatus === 'FAILED'
                    ? (latestTrainingTick?.lastResult?.stderrTail ?? '')
                    : '') || '(empty)'}</Text>
                <Text style={[TYPOGRAPHY.bodySecondary, { color: COLORS.textSecondary, marginTop: SPACING.s }]}>stdout</Text>
                <Text selectable style={styles.tailText}>
                  {(latestTrainingTick?.stdoutTail || data?.trainingStatus === 'FAILED'
                    ? (latestTrainingTick?.lastResult?.stdoutTail ?? '')
                    : '') || '(empty)'}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {(data?.trainingStatus === 'FAILED' ||
          (latestTrainingTick && latestTrainingTick.status === 'FAILED')) ? (
          <View style={[styles.tailPanel, { borderColor: COLORS.error, marginTop: -SPACING.m + 4 }]}>
            <Text style={[TYPOGRAPHY.bodySecondary, { color: COLORS.error, fontWeight: '700' }]}>
              Training FAILED
            </Text>
            <Text selectable style={[styles.tailText, { marginBottom: SPACING.s }]}>
              {latestTrainingTick?.lastResult?.error ||
                data?.trainingStatus /* noop */ && (latestTrainingTick?.lastResult?.message || 'See logs below for details.')}
            </Text>
            <Text style={[TYPOGRAPHY.bodySecondary, { color: COLORS.textSecondary }]}>stderr</Text>
            <Text selectable style={styles.tailText}>
              {(latestTrainingTick?.lastResult?.stderrTail ??
                latestTrainingTick?.stderrTail ??
                '') || '(empty)'}
            </Text>
            <Text style={[TYPOGRAPHY.bodySecondary, { color: COLORS.textSecondary, marginTop: SPACING.s }]}>stdout</Text>
            <Text selectable style={styles.tailText}>
              {(latestTrainingTick?.lastResult?.stdoutTail ??
                latestTrainingTick?.stdoutTail ??
                '') || '(empty)'}
            </Text>
          </View>
        ) : null}

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
            <MetricTile
              label="Dataset Samples"
              value={String(data?.tradeAnalytics?.learningDatasetSamples ?? learning?.datasetSize ?? 0)}
              accent={
                (Number(data?.tradeAnalytics?.learningDatasetSamples ?? learning?.datasetSize ?? 0) >= 20)
                  ? COLORS.success
                  : COLORS.warning
              }
            />
          </View>
          {(Number(data?.tradeAnalytics?.learningDatasetSamples ?? learning?.datasetSize ?? 0) < 4) ? (
            <Text style={[TYPOGRAPHY.bodySecondary, { marginTop: SPACING.s, color: COLORS.warning }]}>
              ⚠ Need 4+ labeled closed MT5 trades before training can learn. Continuous learning dataset is cold — use MT5 + EA to build history first.
            </Text>
          ) : null}
        </Section>

        <Section title="Model Performance">
          {(() => {
            const latest: any = (() => {
              // Prefer the newest candidate that is NOT production; fall back to
              // training dashboard modelPerformance.candidates[0] so the quick
              // banner appears even if the full cards list is being filtered.
              const candList = (data?.models || []).filter((m) => !m.is_production);
              if (candList.length) return candList[0];
              return (data?.modelPerformance?.candidates || [])[0] || null;
            })();
            if (latest?.version) {
              const rec = latest.deployment_recommendation || 'NO';
              const recColor =
                rec === 'YES' ? COLORS.success : rec === 'MONITOR' ? COLORS.warning : COLORS.textSecondary;
              return (
                <View style={styles.quickPromoteBanner}>
                  <View style={styles.quickPromoteHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle}>Latest Candidate · {latest.version}</Text>
                      <Text style={[TYPOGRAPHY.bodySecondary, { marginTop: 2 }]}>
                        {latest.recommendation_reason || 'Candidate ready — compare with production before promote.'}
                      </Text>
                    </View>
                    <Text style={{ color: recColor, fontWeight: '700' }}>{rec}</Text>
                  </View>
                  <View style={styles.metricGrid}>
                    <MetricTile label="Win Rate" value={pct(latest.metrics?.win_rate)} />
                    <MetricTile label="PF" value={num(latest.metrics?.profit_factor)} />
                    <MetricTile label="F1" value={pct(latest.metrics?.f1)} />
                    <MetricTile label="DD" value={pct(latest.metrics?.max_drawdown)} accent={COLORS.error} />
                  </View>
                  <TouchableOpacity
                    style={styles.promoteBtn}
                    onPress={() => handlePromote(latest.version, rec)}
                  >
                    <Text style={styles.promoteBtnText}>Promote {latest.version} → Production</Text>
                  </TouchableOpacity>
                </View>
              );
            }
            return null;
          })()}
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
  progressWrap: {
    marginBottom: SPACING.m,
  },
  progressTrack: {
    width: '100%',
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.border,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 5,
  },
  progressMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: SPACING.s,
  },
  cancelTrainRow: {
    flexDirection: 'row',
    gap: SPACING.s,
    marginTop: SPACING.m,
  },
  secondaryBtnSmall: {
    backgroundColor: COLORS.cardAlt || COLORS.surface2,
    paddingVertical: SPACING.s,
    paddingHorizontal: SPACING.m,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  secondaryBtnTextSmall: {
    color: COLORS.textPrimary,
    fontSize: TYPOGRAPHY.bodySecondary.fontSize || 12,
    textAlign: 'center',
    fontWeight: '600',
  },
  cancelTrainBtn: {
    borderColor: COLORS.error,
    flex: 1,
  },
  cancelTrainBtnText: {
    color: COLORS.error,
    fontSize: TYPOGRAPHY.bodySecondary.fontSize || 12,
    textAlign: 'center',
    fontWeight: '700',
  },
  tailPanel: {
    marginTop: SPACING.m,
    padding: SPACING.s,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    backgroundColor: COLORS.cardAlt || COLORS.surface2,
    maxHeight: 220,
  },
  tailText: {
    marginTop: 4,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    color: COLORS.textPrimary,
  },
  quickPromoteBanner: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.primary,
    padding: SPACING.m,
    marginBottom: SPACING.m,
  },
  quickPromoteHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: SPACING.s,
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
