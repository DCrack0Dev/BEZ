import React from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity } from 'react-native';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';

interface ConfirmModalProps {
  visible: boolean;
  symbol: string;
  direction: 'BUY' | 'SELL';
  lots: number;
  sl?: number;
  tp?: number;
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmModal: React.FC<ConfirmModalProps> = ({
  visible,
  symbol,
  direction,
  lots,
  sl,
  tp,
  onConfirm,
  onCancel,
}) => {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.overlay}>
        <View style={styles.content}>
          <Text style={TYPOGRAPHY.h3}>Confirm Order</Text>
          <View style={styles.details}>
            <View style={styles.row}>
              <Text style={TYPOGRAPHY.bodySecondary}>Symbol</Text>
              <Text style={TYPOGRAPHY.body}>{symbol}</Text>
            </View>
            <View style={styles.row}>
              <Text style={TYPOGRAPHY.bodySecondary}>Type</Text>
              <Text style={[TYPOGRAPHY.body, { color: direction === 'BUY' ? COLORS.buy : COLORS.sell, fontWeight: '700' }]}>
                {direction}
              </Text>
            </View>
            <View style={styles.row}>
              <Text style={TYPOGRAPHY.bodySecondary}>Lots</Text>
              <Text style={TYPOGRAPHY.body}>{lots}</Text>
            </View>
            {sl && (
              <View style={styles.row}>
                <Text style={TYPOGRAPHY.bodySecondary}>Stop Loss</Text>
                <Text style={TYPOGRAPHY.body}>{sl} pts</Text>
              </View>
            )}
            {tp && (
              <View style={styles.row}>
                <Text style={TYPOGRAPHY.bodySecondary}>Take Profit</Text>
                <Text style={TYPOGRAPHY.body}>{tp} pts</Text>
              </View>
            )}
          </View>
          <View style={styles.footer}>
            <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.confirmButton} onPress={onConfirm}>
              <Text style={styles.confirmText}>Confirm Order</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: COLORS.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.l,
  },
  content: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: SPACING.l,
    width: '100%',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  details: {
    marginVertical: SPACING.l,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: SPACING.s,
  },
  footer: {
    flexDirection: 'row',
    marginTop: SPACING.m,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: SPACING.m,
    marginRight: SPACING.s,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  confirmButton: {
    flex: 2,
    backgroundColor: COLORS.primary,
    paddingVertical: SPACING.m,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelText: {
    ...TYPOGRAPHY.button,
    color: COLORS.textSecondary,
  },
  confirmText: {
    ...TYPOGRAPHY.button,
    color: COLORS.black,
  },
});

export default ConfirmModal;
