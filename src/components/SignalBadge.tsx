import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';

interface SignalBadgeProps {
  signal: 'BUY' | 'SELL' | 'NONE';
}

const SignalBadge: React.FC<SignalBadgeProps> = ({ signal }) => {
  const getColors = () => {
    switch (signal) {
      case 'BUY': return { bg: COLORS.buy + '20', text: COLORS.buy };
      case 'SELL': return { bg: COLORS.sell + '20', text: COLORS.sell };
      default: return { bg: COLORS.border, text: COLORS.textSecondary };
    }
  };

  const { bg, text } = getColors();

  return (
    <View style={[styles.container, { backgroundColor: bg }]}>
      <View style={[styles.dot, { backgroundColor: text }]} />
      <Text style={[styles.text, { color: text }]}>
        {signal} SIGNAL
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    borderRadius: 20,
    alignSelf: 'center',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: SPACING.s,
  },
  text: {
    ...TYPOGRAPHY.button,
    fontSize: 14,
    letterSpacing: 1,
  },
});

export default SignalBadge;
