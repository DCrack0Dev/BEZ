import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Provider as PaperProvider, MD3DarkTheme, Snackbar } from 'react-native-paper';
import AppNavigator from './src/navigation/AppNavigator';
import OfflineBanner from './src/components/OfflineBanner';
import { useSettingsStore } from './src/store/useSettingsStore';
import { useTradeStore } from './src/store/useTradeStore';
import { COLORS } from './src/theme/colors';

const theme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: COLORS.primary,
    background: COLORS.background,
    surface: COLORS.card,
    onSurface: COLORS.textPrimary,
  },
};

export default function App() {
  const { loadSettings } = useSettingsStore();
  const { error, setError } = useTradeStore();

  useEffect(() => {
    loadSettings();
  }, []);

  return (
    <SafeAreaProvider>
      <PaperProvider theme={theme}>
        <StatusBar style="light" />
        <OfflineBanner />
        <AppNavigator />
        <Snackbar
          visible={!!error}
          onDismiss={() => setError(null)}
          action={{
            label: 'OK',
            onPress: () => setError(null),
          }}
          duration={3000}
          style={{ backgroundColor: COLORS.card, borderLeftWidth: 4, borderLeftColor: COLORS.error }}
        >
          {error}
        </Snackbar>
      </PaperProvider>
    </SafeAreaProvider>
  );
}
