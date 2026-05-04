import React, { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';

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
}

const Terminal: React.FC<TerminalProps> = ({ logs, onClear, keyLevelDistance }) => {
  const scrollViewRef = useRef<ScrollView>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    // Auto-scroll to bottom when new logs arrive
    if (scrollViewRef.current) {
      scrollViewRef.current.scrollToEnd({ animated: true });
    }
  }, [logs]);

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

  const formatTime = (timestamp: Date) => {
    return timestamp.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });
  };

  return (
    <View style={[styles.container, isExpanded && styles.expanded]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <MaterialCommunityIcons name="console" size={20} color={COLORS.textPrimary} />
          <Text style={styles.title}>System Terminal</Text>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{logs.length}</Text>
          </View>
        </View>
        
        <View style={styles.headerRight}>
          {keyLevelDistance && (
            <View style={styles.keyLevelInfo}>
              <MaterialCommunityIcons name="map-marker" size={16} color={COLORS.warning} />
              <Text style={styles.keyLevelText}>
                Next {keyLevelDistance.type}: {keyLevelDistance.level} ({Math.abs(keyLevelDistance.distance).toFixed(2)}pts)
              </Text>
            </View>
          )}
          
          <TouchableOpacity onPress={() => setIsExpanded(!isExpanded)} style={styles.expandBtn}>
            <MaterialCommunityIcons 
              name={isExpanded ? "chevron-down" : "chevron-up"} 
              size={20} 
              color={COLORS.textPrimary} 
            />
          </TouchableOpacity>
          
          <TouchableOpacity onPress={onClear} style={styles.clearBtn}>
            <MaterialCommunityIcons name="delete" size={20} color={COLORS.error} />
          </TouchableOpacity>
        </View>
      </View>

      {isExpanded && (
        <ScrollView 
          ref={scrollViewRef}
          style={styles.logContainer}
          showsVerticalScrollIndicator={false}
        >
          {logs.length === 0 ? (
            <View style={styles.emptyState}>
              <MaterialCommunityIcons name="console" size={40} color={COLORS.textSecondary} />
              <Text style={styles.emptyText}>No logs yet...</Text>
            </View>
          ) : (
            logs.map((log) => (
              <View key={log.id} style={styles.logEntry}>
                <View style={styles.logHeader}>
                  <Text style={[styles.logTime, { color: COLORS.textSecondary }]}>
                    {formatTime(log.timestamp)}
                  </Text>
                  <Text style={[styles.logComponent, { color: getComponentColor(log.component) }]}>
                    [{log.component}]
                  </Text>
                  <Text style={[styles.logLevel, { color: getLevelColor(log.level) }]}>
                    {log.level.toUpperCase()}
                  </Text>
                </View>
                <Text style={[styles.logMessage, { color: COLORS.textPrimary }]}>
                  {log.message}
                </Text>
                {log.details && (
                  <Text style={[styles.logDetails, { color: COLORS.textSecondary }]}>
                    {log.details}
                  </Text>
                )}
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
    backgroundColor: COLORS.card,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    maxHeight: 200,
  },
  expanded: {
    maxHeight: 400,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: SPACING.s,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textPrimary,
    marginLeft: SPACING.xs,
    fontWeight: 'bold',
  },
  badge: {
    backgroundColor: COLORS.primary,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: SPACING.s,
  },
  badgeText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.white,
    fontSize: 10,
    fontWeight: 'bold',
  },
  keyLevelInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    paddingHorizontal: SPACING.s,
    paddingVertical: SPACING.xs,
    borderRadius: 4,
    marginRight: SPACING.s,
  },
  keyLevelText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textPrimary,
    marginLeft: SPACING.xs,
  },
  expandBtn: {
    padding: SPACING.xs,
  },
  clearBtn: {
    padding: SPACING.xs,
  },
  logContainer: {
    maxHeight: 350,
    padding: SPACING.s,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.xl,
  },
  emptyText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textSecondary,
    marginTop: SPACING.s,
  },
  logEntry: {
    marginBottom: SPACING.s,
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  logHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  logTime: {
    ...TYPOGRAPHY.caption,
    fontSize: 10,
    marginRight: SPACING.s,
  },
  logComponent: {
    ...TYPOGRAPHY.caption,
    fontSize: 10,
    fontWeight: 'bold',
    marginRight: SPACING.s,
  },
  logLevel: {
    ...TYPOGRAPHY.caption,
    fontSize: 10,
    fontWeight: 'bold',
  },
  logMessage: {
    ...TYPOGRAPHY.caption,
    fontSize: 11,
    lineHeight: 14,
  },
  logDetails: {
    ...TYPOGRAPHY.caption,
    fontSize: 10,
    marginTop: 2,
    fontStyle: 'italic',
  },
});

export default Terminal;
