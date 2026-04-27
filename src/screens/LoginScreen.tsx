import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useAuthStore } from '../store/useAuthStore';
import { validateApiKey } from '../api/account';
import { COLORS } from '../theme/colors';
import { TYPOGRAPHY } from '../theme/typography';
import { SPACING } from '../theme/spacing';

const LoginScreen = () => {
  const [apiKey, setApiKey] = useState('');
  const [serverUrl, setServerUrl] = useState('https://api.scalpking.com');
  const [loading, setLoading] = useState(false);
  const { setAuth } = useAuthStore();

  const handleConnect = async () => {
    if (!apiKey || !serverUrl) {
      Alert.alert('Error', 'Please enter both API Key and Server URL');
      return;
    }

    setLoading(true);
    try {
      const response = await validateApiKey(apiKey);
      if (response.token) {
        await setAuth(apiKey, serverUrl, response.token);
      } else {
        throw new Error('Invalid response');
      }
    } catch (error) {
      Alert.alert('Connection Failed', 'Invalid API Key or server unreachable');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Text style={TYPOGRAPHY.h2}>Welcome to FxScalpKing</Text>
          <Text style={styles.subtitle}>Enter your details to connect to the trading engine</Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Backend Server URL</Text>
          <TextInput
            style={styles.input}
            placeholder="https://api.fxscalpking.com"
            placeholderTextColor={COLORS.textSecondary}
            value={serverUrl}
            onChangeText={setServerUrl}
            autoCapitalize="none"
            keyboardType="url"
          />

          <Text style={styles.label}>API Key</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter your API key"
            placeholderTextColor={COLORS.textSecondary}
            value={apiKey}
            onChangeText={setApiKey}
            secureTextEntry
            autoCapitalize="none"
          />

          <TouchableOpacity 
            style={[styles.button, loading && styles.buttonDisabled]} 
            onPress={handleConnect}
            disabled={loading}
          >
            <Text style={styles.buttonText}>{loading ? 'Connecting...' : 'Connect'}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.linkButton}>
            <Text style={styles.linkText}>
              Don't have a key? <Text style={{ color: COLORS.primary }}>Subscribe at fxscalpking.com</Text>
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scrollContent: {
    flexGrow: 1,
    padding: SPACING.l,
    justifyContent: 'center',
  },
  header: {
    marginBottom: SPACING.xl,
  },
  subtitle: {
    ...TYPOGRAPHY.bodySecondary,
    marginTop: SPACING.s,
  },
  form: {
    width: '100%',
  },
  label: {
    ...TYPOGRAPHY.caption,
    marginBottom: SPACING.s,
    marginTop: SPACING.m,
  },
  input: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: SPACING.m,
    color: COLORS.textPrimary,
    borderWidth: 1,
    borderColor: COLORS.border,
    fontSize: 16,
  },
  button: {
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    padding: SPACING.m,
    alignItems: 'center',
    marginTop: SPACING.xl,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    ...TYPOGRAPHY.button,
    color: COLORS.black,
  },
  linkButton: {
    marginTop: SPACING.l,
    alignItems: 'center',
  },
  linkText: {
    ...TYPOGRAPHY.bodySecondary,
    fontSize: 14,
  },
});

export default LoginScreen;
