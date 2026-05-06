import React, { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const TERMINAL_MAX_HEIGHT = SCREEN_HEIGHT / 3;

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
  const [isExpanded, setIsExpanded] = useState(false); // Default to collapsed as requested

  useEffect(() => {
    // Auto-scroll to bottom when new logs arrive and it's expanded
    if (isExpanded && scrollViewRef.current) {
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [logs, isExpanded]);

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
    const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
    return date.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });
  };

  return (
    <View style={[styles.container, isExpanded && styles.expanded]}>
      <TouchableOpacity 
        activeOpacity={0.8}
        onPress={() => setIsExpanded(!isExpanded)}
        style={styles.header}
      >
        <View style={styles.headerLeft}>
          <MaterialCommunityIcons name="console" size={18} color={COLORS.primary} />
          <Text style={styles.title} numberOfLines={1}>TERMINAL</Text>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{logs.length}</Text>
          </View>
        </View>
        
        <View style={styles.headerRight}>
          {keyLevelDistance && (
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
              name={isExpanded ? "chevron-down" : "chevron-up"} 
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
          showsVerticalScrollIndicator={true}
          nestedScrollEnabled={true}
        >
          {logs.length === 0 ? (
            <View style={styles.emptyState}>
              <MaterialCommunityIcons name="console" size={30} color="#333" />
              <Text style={styles.emptyText}>No logs yet...</Text>
            </View>
          ) : (
            [...logs].reverse().map((log) => (
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
                <Text style={[styles.logMessage, { color: '#ccc' }]}>
                  {log.message}
                </Text>
                {log.details && (
                  <Text style={[styles.logDetails, { color: '#888' }]}>
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
    maxWidth: '40%',
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
    maxWidth: '60%',
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
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
  },
  emptyText: {
    fontSize: 12,
    marginTop: SPACING.s,
    color: '#444',
  },
});

export default Terminal;
