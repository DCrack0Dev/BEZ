import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';

interface TradeButtonProps {
  title: string;
  type: 'BUY' | 'SELL';
  onPress: () => void;
  style?: ViewStyle;
  disabled?: boolean;
}

const TradeButton: React.FC<TradeButtonProps> = ({ title, type, onPress, style, disabled }) => {
  const handlePress = () => {
    if (disabled) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    onPress();
  };

  return (
    <TouchableOpacity
      style={[
        styles.button,
        { backgroundColor: type === 'BUY' ? COLORS.buy : COLORS.sell },
        disabled && styles.disabled,
        style,
      ]}
      onPress={handlePress}
      activeOpacity={disabled ? 1 : 0.8}
      disabled={disabled}
    >
      <Text style={styles.text}>{title}</Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  button: {
    height: 56,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    flex: 1,
    marginHorizontal: SPACING.xs,
  },
  disabled: {
    opacity: 0.5,
  },
  text: {
    ...TYPOGRAPHY.button,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
});

export default TradeButton;
