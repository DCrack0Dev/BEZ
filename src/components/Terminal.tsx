import React, { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Dimensions, Switch } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../theme/colors';
import { SPACING } from '../theme/spacing';
import type { SetupProgress, SetupRequirement } from '../store/useTradeStore';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const TERMINAL_MAX_HEIGHT = Math.min(SCREEN_HEIGHT * 0.55, 420);

interface LogEntry {
  id: string;
  timestamp: Date;
  component: 'EA' | 'Backend' | 'App' | 'System';
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  details?: string;
}

interface TerminalProps {
  logs: LogEntry[];
  onClear: () => void;
  keyLevelDistance?: { level: number; distance: number; type: string };
  setupProgress?: SetupProgress | null;
  timezoneTradingEnabled?: boolean;
  onTimezoneTradingChange?: (enabled: boolean) => void;
}

const GateRow = ({ gate }: { gate: SetupRequirement }) => (
  <View style={styles.gateRow}>
    <MaterialCommunityIcons
      name={gate.met ? 'check-circle' : 'close-circle-outline'}
      size={14}
      color={gate.met ? COLORS.buy : COLORS.textSecondary}
    />
    <View style={styles.gateTextWrap}>
      <Text style={[styles.gateLabel, gate.met && styles.gateMet]} numberOfLines={1}>
        {gate.label}
      </Text>
      <Text style={styles.gateDetail} numberOfLines={1}>
        need {gate.expected} · now {gate.actual}
      </Text>
    </View>
    <Text style={[styles.gatePct, { color: gate.met ? COLORS.buy : COLORS.warning }]}>
      {Math.round(gate.progress)}%
    </Text>
  </View>
);

const Terminal: React.FC<TerminalProps> = ({
  logs,
  onClear,
  keyLevelDistance,
  setupProgress,
  timezoneTradingEnabled = true,
  onTimezoneTradingChange,
}) => {
  const scrollViewRef = useRef<ScrollView>(null);
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    if (isExpanded && scrollViewRef.current) {
      setTimeout(() => {
        scrollViewRef.current?.scrollTo({ y: 0, animated: false });
      }, 50);
    }
  }, [setupProgress?.summary, isExpanded]);

  const getComponentColor = (component: string) => {
    switch (component) {
      case 'EA': return COLORS.primary;
      case 'Backend': return COLORS.buy;
      case 'App': return COLORS.sell;
      case 'System': return COLORS.warning;
      default: return COLORS.textSecondary;
    }
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'success': return COLORS.buy;
      case 'warning': return COLORS.warning;
      case 'error': return COLORS.error;
      case 'info': return COLORS.textSecondary;
      default: return COLORS.textSecondary;
    }
  };

  const formatTime = (timestamp: Date | string) => {
    if (!timestamp) return '--:--:--';
    const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
    if (isNaN(date.getTime())) return '--:--:--';
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const bias = setupProgress?.bias || 'NONE';
  const progressPct = Math.round(setupProgress?.overallProgress || 0);
  const activeGates =
    bias === 'SELL'
      ? setupProgress?.sellGates || []
      : setupProgress?.buyGates || [];

  return (
    <View style={[styles.container, isExpanded && styles.expanded]}>
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() => setIsExpanded(!isExpanded)}
        style={styles.header}
      >
        <View style={styles.headerLeft}>
          <MaterialCommunityIcons name="radar" size={18} color={COLORS.primary} />
          <Text style={styles.title} numberOfLines={1}>SETUP</Text>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{progressPct}%</Text>
          </View>
        </View>

        <View style={styles.headerRight}>
          {setupProgress && (
            <View style={styles.keyLevelInfo}>
              <Text style={styles.keyLevelText} numberOfLines={1}>
                {setupProgress.trend} · {setupProgress.tradeType} · {setupProgress.session}
              </Text>
            </View>
          )}
          {!setupProgress && keyLevelDistance && (
            <View style={styles.keyLevelInfo}>
              <MaterialCommunityIcons name="map-marker" size={12} color={COLORS.warning} />
              <Text style={styles.keyLevelText} numberOfLines={1}>
                {keyLevelDistance.type}: {keyLevelDistance.level}
              </Text>
            </View>
          )}

          <View style={styles.controls}>
            <TouchableOpacity onPress={onClear} style={styles.controlBtn}>
              <MaterialCommunityIcons name="delete-outline" size={18} color={COLORS.error} />
            </TouchableOpacity>
            <MaterialCommunityIcons
              name={isExpanded ? 'chevron-down' : 'chevron-up'}
              size={22}
              color={COLORS.textPrimary}
            />
          </View>
        </View>
      </TouchableOpacity>

      {isExpanded && (
        <ScrollView
          ref={scrollViewRef}
          style={styles.logContainer}
          showsVerticalScrollIndicator
          nestedScrollEnabled
        >
          {onTimezoneTradingChange && (
            <View style={styles.tzRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.tzTitle}>Timezone trading</Text>
                <Text style={styles.tzHint}>
                  {timezoneTradingEnabled
                    ? 'ON — Asia session blocked'
                    : 'OFF — trade any time if conditions met'}
                </Text>
              </View>
              <Switch
                value={timezoneTradingEnabled}
                onValueChange={onTimezoneTradingChange}
                trackColor={{ false: COLORS.border, true: COLORS.primary + '50' }}
                thumbColor={timezoneTradingEnabled ? COLORS.primary : COLORS.textSecondary}
              />
            </View>
          )}

          {setupProgress ? (
            <View style={styles.setupCard}>
              <Text style={styles.setupSummary}>{setupProgress.summary}</Text>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${progressPct}%`,
                      backgroundColor:
                        progressPct >= 100
                          ? COLORS.buy
                          : bias === 'BUY'
                            ? COLORS.buy
                            : bias === 'SELL'
                              ? COLORS.sell
                              : COLORS.primary,
                    },
                  ]}
                />
              </View>
              <Text style={styles.setupMeta}>
                Looking for: {bias === 'NONE' ? 'setup' : bias} · ATR / levels update every heartbeat
              </Text>

              <Text style={styles.sectionLabel}>HARD GATES</Text>
              {setupProgress.hardGates.map((g) => (
                <GateRow key={g.id} gate={g} />
              ))}

              <Text style={styles.sectionLabel}>
                {bias === 'SELL' ? 'SELL ENTRY' : 'BUY ENTRY'} REQUIREMENTS
              </Text>
              {activeGates.map((g) => (
                <GateRow key={g.id} gate={g} />
              ))}

              {setupProgress.blockers.length > 0 && progressPct < 100 && (
                <Text style={styles.blockers}>
                  Still need: {setupProgress.blockers.join(' · ')}
                </Text>
              )}
            </View>
          ) : (
            <View style={styles.emptyState}>
              <MaterialCommunityIcons name="lan-pending" size={28} color="#333" />
              <Text style={styles.emptyText}>Waiting for EA heartbeat…</Text>
            </View>
          )}

          <Text style={styles.sectionLabel}>LOGS ({logs.length})</Text>
          {logs.length === 0 ? (
            <Text style={styles.emptyText}>No logs yet…</Text>
          ) : (
            [...logs].slice(0, 40).map((log) => (
              <View key={log.id} style={styles.logEntry}>
                <View style={styles.logHeader}>
                  <Text style={[styles.logTime, { color: '#666' }]}>
                    {formatTime(log.timestamp)}
                  </Text>
                  <Text style={[styles.logComponent, { color: getComponentColor(log.component) }]}>
                    [{log.component}]
                  </Text>
                  <Text style={[styles.logLevel, { color: getLevelColor(log.level) }]}>
                    {log.level.toUpperCase()}
                  </Text>
                </View>
                <Text style={[styles.logMessage, { color: '#ccc' }]}>{log.message}</Text>
                {log.details ? (
                  <Text style={[styles.logDetails, { color: '#888' }]}>{log.details}</Text>
                ) : null}
              </View>
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#0a0a0a',
    borderTopWidth: 2,
    borderTopColor: COLORS.primary,
    elevation: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.5,
    shadowRadius: 5,
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  expanded: {
    height: TERMINAL_MAX_HEIGHT,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    backgroundColor: '#151515',
    height: 45,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '35%',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flex: 1,
  },
  title: {
    fontSize: 12,
    color: COLORS.primary,
    marginLeft: SPACING.xs,
    fontWeight: '900',
    letterSpacing: 2,
  },
  badge: {
    backgroundColor: COLORS.primary,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
    marginLeft: SPACING.s,
  },
  badgeText: {
    color: COLORS.white,
    fontSize: 10,
    fontWeight: 'bold',
  },
  keyLevelInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#222',
    paddingHorizontal: SPACING.s,
    paddingVertical: 4,
    borderRadius: 4,
    marginRight: SPACING.s,
    borderWidth: 1,
    borderColor: '#333',
    maxWidth: '55%',
  },
  keyLevelText: {
    fontSize: 10,
    color: COLORS.warning,
    marginLeft: 4,
    fontWeight: 'bold',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  controlBtn: {
    padding: 4,
    marginRight: SPACING.s,
  },
  logContainer: {
    flex: 1,
    paddingHorizontal: SPACING.m,
    paddingTop: SPACING.s,
  },
  tzRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#121212',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 8,
    padding: SPACING.s,
    marginBottom: SPACING.s,
  },
  tzTitle: {
    color: COLORS.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  tzHint: {
    color: '#888',
    fontSize: 10,
    marginTop: 2,
  },
  setupCard: {
    backgroundColor: '#111',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    padding: SPACING.s,
    marginBottom: SPACING.m,
  },
  setupSummary: {
    color: '#eee',
    fontSize: 12,
    fontFamily: 'monospace',
    marginBottom: 8,
  },
  progressTrack: {
    height: 6,
    backgroundColor: '#222',
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 6,
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  setupMeta: {
    color: '#777',
    fontSize: 10,
    marginBottom: 8,
  },
  sectionLabel: {
    color: COLORS.primary,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1,
    marginTop: 8,
    marginBottom: 6,
  },
  gateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  gateTextWrap: {
    flex: 1,
    marginLeft: 6,
    marginRight: 6,
  },
  gateLabel: {
    color: '#bbb',
    fontSize: 11,
    fontWeight: '600',
  },
  gateMet: {
    color: '#ddd',
  },
  gateDetail: {
    color: '#666',
    fontSize: 9,
    fontFamily: 'monospace',
  },
  gatePct: {
    fontSize: 10,
    fontWeight: '700',
    width: 36,
    textAlign: 'right',
  },
  blockers: {
    marginTop: 8,
    color: COLORS.warning,
    fontSize: 10,
    fontFamily: 'monospace',
  },
  logEntry: {
    marginBottom: 10,
    borderLeftWidth: 2,
    borderLeftColor: '#222',
    paddingLeft: 10,
  },
  logHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  logTime: {
    fontSize: 10,
    fontFamily: 'monospace',
    marginRight: 8,
  },
  logComponent: {
    fontSize: 10,
    fontWeight: 'bold',
    marginRight: 8,
  },
  logLevel: {
    fontSize: 9,
    fontWeight: '900',
  },
  logMessage: {
    fontSize: 11,
    lineHeight: 15,
    fontFamily: 'monospace',
  },
  logDetails: {
    fontSize: 10,
    marginTop: 2,
    opacity: 0.7,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
  },
  emptyText: {
    fontSize: 12,
    marginTop: SPACING.s,
    color: '#444',
  },
});

export default Terminal;
