import React, { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Provider as PaperProvider, MD3DarkTheme, Snackbar } from 'react-native-paper';
import { View, Text } from 'react-native';
import ErrorBoundary from './src/components/ErrorBoundary';
import { COLORS } from './src/theme/colors';
import AppNavigator from './src/navigation/AppNavigator';

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
  const [appReady, setAppReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const initializeApp = async () => {
      try {
        console.log('[APP] Starting app initialization...');

        // Simulate app loading
        await new Promise(resolve => setTimeout(resolve, 1000));
        setAppReady(true);
        console.log('[APP] App initialized successfully');
      } catch (err) {
        console.error('[APP] Error initializing app:', err);
        setError(`App initialization failed: ${err}`);
      }
    };

    initializeApp();
  }, []);

  if (!appReady) {
    return (
      <SafeAreaProvider>
        <PaperProvider theme={theme}>
          <ErrorBoundary>
            <StatusBar style="light" />
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.background }}>
              <Text style={{ color: COLORS.textPrimary, fontSize: 18 }}>Loading FxScalpKing...</Text>
            </View>
          </ErrorBoundary>
        </PaperProvider>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <PaperProvider theme={theme}>
        <ErrorBoundary>
          <StatusBar style="light" />
          <AppNavigator />
          {error && (
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
          )}
        </ErrorBoundary>
      </PaperProvider>
    </SafeAreaProvider>
  );
}
