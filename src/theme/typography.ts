import { Platform } from 'react-native';

export const TYPOGRAPHY = {
  h1: {
    fontSize: 32,
    fontWeight: '700' as const,
    color: '#FFFFFF',
    fontFamily: Platform.OS === 'ios' ? 'System' : 'sans-serif',
  },
  h2: {
    fontSize: 24,
    fontWeight: '700' as const,
    color: '#FFFFFF',
    fontFamily: Platform.OS === 'ios' ? 'System' : 'sans-serif',
  },
  h3: {
    fontSize: 20,
    fontWeight: '600' as const,
    color: '#FFFFFF',
    fontFamily: Platform.OS === 'ios' ? 'System' : 'sans-serif',
  },
  body: {
    fontSize: 16,
    color: '#FFFFFF',
    fontFamily: Platform.OS === 'ios' ? 'System' : 'sans-serif',
  },
  bodySecondary: {
    fontSize: 14,
    color: '#8A8A9A',
    fontFamily: Platform.OS === 'ios' ? 'System' : 'sans-serif',
  },
  caption: {
    fontSize: 12,
    color: '#8A8A9A',
    textTransform: 'uppercase' as const,
    letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'System' : 'sans-serif',
  },
  mono: {
    fontSize: 16,
    color: '#FFFFFF',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  button: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: '#FFFFFF',
    fontFamily: Platform.OS === 'ios' ? 'System' : 'sans-serif-medium',
  },
};
