import React from 'react';
import { View, Text, StyleSheet, ScrollView, Switch, TextInput, TouchableOpacity, Alert } from 'react-native';
import { useAuthStore } from '../store/useAuthStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';

const SettingsScreen = () => {
  const { logout, apiKey, serverUrl } = useAuthStore();
  const { botSettings, notifications, subscription, updateBotSettings, updateNotifications } = useSettingsStore();

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Logout', style: 'destructive', onPress: logout },
    ]);
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Bot Settings</Text>
        <View style={styles.card}>
          <View style={styles.inputRow}>
            <Text style={TYPOGRAPHY.body}>Default Lot Size</Text>
            <TextInput
              style={styles.smallInput}
              value={botSettings.defaultLots.toString()}
              onChangeText={(text) => updateBotSettings({ defaultLots: parseFloat(text) || 0 })}
              keyboardType="decimal-pad"
              placeholderTextColor={COLORS.textSecondary}
            />
          </View>
          <View style={styles.inputRow}>
            <Text style={TYPOGRAPHY.body}>Stop Loss (Points)</Text>
            <TextInput
              style={styles.smallInput}
              value={botSettings.stopLoss.toString()}
              onChangeText={(text) => updateBotSettings({ stopLoss: parseInt(text) || 0 })}
              keyboardType="number-pad"
              placeholderTextColor={COLORS.textSecondary}
            />
          </View>
          <View style={styles.inputRow}>
            <Text style={TYPOGRAPHY.body}>Take Profit (Points)</Text>
            <TextInput
              style={styles.smallInput}
              value={botSettings.takeProfit.toString()}
              onChangeText={(text) => updateBotSettings({ takeProfit: parseInt(text) || 0 })}
              keyboardType="number-pad"
              placeholderTextColor={COLORS.textSecondary}
            />
          </View>
          <View style={styles.toggleRow}>
            <Text style={TYPOGRAPHY.body}>Trailing Stop</Text>
            <Switch
              value={botSettings.trailingStopEnabled}
              onValueChange={(val) => updateBotSettings({ trailingStopEnabled: val })}
              trackColor={{ false: COLORS.border, true: COLORS.primary + '50' }}
              thumbColor={botSettings.trailingStopEnabled ? COLORS.primary : COLORS.textSecondary}
            />
          </View>
          <View style={styles.toggleRow}>
            <Text style={TYPOGRAPHY.body}>Auto Trading</Text>
            <Switch
              value={botSettings.autoTradingEnabled}
              onValueChange={(val) => updateBotSettings({ autoTradingEnabled: val })}
              trackColor={{ false: COLORS.border, true: COLORS.primary + '50' }}
              thumbColor={botSettings.autoTradingEnabled ? COLORS.primary : COLORS.textSecondary}
            />
          </View>
          <View style={styles.toggleRow}>
            <Text style={TYPOGRAPHY.body}>Session Filter (07:00 - 20:00)</Text>
            <Switch
              value={botSettings.sessionFilterEnabled}
              onValueChange={(val) => updateBotSettings({ sessionFilterEnabled: val })}
              trackColor={{ false: COLORS.border, true: COLORS.primary + '50' }}
              thumbColor={botSettings.sessionFilterEnabled ? COLORS.primary : COLORS.textSecondary}
            />
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notifications</Text>
        <View style={styles.card}>
          <View style={styles.toggleRow}>
            <Text style={TYPOGRAPHY.body}>Trade Opened</Text>
            <Switch
              value={notifications.tradeOpened}
              onValueChange={(val) => updateNotifications({ tradeOpened: val })}
            />
          </View>
          <View style={styles.toggleRow}>
            <Text style={TYPOGRAPHY.body}>Trade Closed</Text>
            <Switch
              value={notifications.tradeClosed}
              onValueChange={(val) => updateNotifications({ tradeClosed: val })}
            />
          </View>
          <View style={styles.toggleRow}>
            <Text style={TYPOGRAPHY.body}>EA Disconnected</Text>
            <Switch
              value={notifications.eaDisconnected}
              onValueChange={(val) => updateNotifications({ eaDisconnected: val })}
            />
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.card}>
          <View style={styles.infoRow}>
            <Text style={TYPOGRAPHY.bodySecondary}>Subscription</Text>
            <Text style={[TYPOGRAPHY.body, { color: COLORS.primary }]}>{subscription.plan}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={TYPOGRAPHY.bodySecondary}>Expires</Text>
            <Text style={TYPOGRAPHY.body}>{subscription.expiry}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={TYPOGRAPHY.bodySecondary}>Server</Text>
            <Text style={TYPOGRAPHY.body} numberOfLines={1}>{serverUrl}</Text>
          </View>
          <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
            <Text style={styles.logoutText}>Logout</Text>
          </TouchableOpacity>
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
  section: {
    padding: SPACING.m,
  },
  sectionTitle: {
    ...TYPOGRAPHY.caption,
    marginBottom: SPACING.s,
    marginLeft: SPACING.s,
  },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: SPACING.m,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  inputRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: SPACING.s,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: SPACING.s,
  },
  smallInput: {
    backgroundColor: COLORS.background,
    borderRadius: 8,
    paddingHorizontal: SPACING.s,
    paddingVertical: 4,
    color: COLORS.textPrimary,
    width: 80,
    textAlign: 'right',
    ...TYPOGRAPHY.mono,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: SPACING.s,
  },
  logoutButton: {
    marginTop: SPACING.l,
    paddingVertical: SPACING.m,
    borderRadius: 8,
    backgroundColor: COLORS.sell + '20',
    alignItems: 'center',
  },
  logoutText: {
    ...TYPOGRAPHY.button,
    color: COLORS.sell,
  },
});

export default SettingsScreen;
