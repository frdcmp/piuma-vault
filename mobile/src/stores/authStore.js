import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { create } from 'zustand';

// SecureStore has no web implementation in Expo SDK 55, so fall back
// to AsyncStorage on web. Native platforms keep using SecureStore.
const storage = {
  get: (key) =>
    Platform.OS === 'web'
      ? AsyncStorage.getItem(key)
      : SecureStore.getItemAsync(key),
  set: (key, value) =>
    Platform.OS === 'web'
      ? AsyncStorage.setItem(key, value)
      : SecureStore.setItemAsync(key, value),
  remove: (key) =>
    Platform.OS === 'web'
      ? AsyncStorage.removeItem(key)
      : SecureStore.deleteItemAsync(key),
};

const ACCESS_KEY = 'token';
const REFRESH_KEY = 'refresh_token';
// Long-lived (30d) device handle that lets us skip OTP on this device for
// subsequent logins. Stored in SecureStore on native, AsyncStorage on web.
const TRUSTED_DEVICE_KEY = 'trusted_device';

export const useAuthStore = create((set, get) => ({
  token: null,
  refreshToken: null,
  trustedDeviceToken: null,
  user: null,
  isLoading: true,

  init: async () => {
    try {
      const [token, refreshToken, trustedDeviceToken] = await Promise.all([
        storage.get(ACCESS_KEY),
        storage.get(REFRESH_KEY),
        storage.get(TRUSTED_DEVICE_KEY),
      ]);
      set({ token, refreshToken, trustedDeviceToken, isLoading: false });
    } catch (e) {
      console.error('[auth] init failed', e);
      set({ isLoading: false });
    }
  },

  setAuth: async ({ accessToken, refreshToken, user, trustedDeviceToken }) => {
    set({
      token: accessToken,
      refreshToken,
      user,
      ...(trustedDeviceToken ? { trustedDeviceToken } : {}),
    });
    try {
      await Promise.all([
        storage.set(ACCESS_KEY, accessToken),
        refreshToken
          ? storage.set(REFRESH_KEY, refreshToken)
          : Promise.resolve(),
        trustedDeviceToken
          ? storage.set(TRUSTED_DEVICE_KEY, trustedDeviceToken)
          : Promise.resolve(),
      ]);
    } catch (e) {
      console.error('[auth] failed to persist tokens', e);
    }
  },

  // Used by the axios refresh flow when only the access token rotates.
  setAccessToken: async (accessToken) => {
    set({ token: accessToken });
    try {
      await storage.set(ACCESS_KEY, accessToken);
    } catch (e) {
      console.error('[auth] failed to persist access token', e);
    }
  },

  getRefreshToken: () => get().refreshToken,

  // Logout intentionally keeps the trusted-device token: it is bound to *this
  // device*, not to the session. To revoke it the user must visit the web
  // settings page and remove the device explicitly.
  logout: async () => {
    set({ token: null, refreshToken: null, user: null });
    try {
      await Promise.all([
        storage.remove(ACCESS_KEY),
        storage.remove(REFRESH_KEY),
      ]);
    } catch (e) {
      console.error('[auth] failed to clear tokens', e);
    }
  },

  // Force-clear the trusted-device handle (e.g. if the server reports it as
  // revoked / expired). Triggers an OTP prompt on next login.
  clearTrustedDevice: async () => {
    set({ trustedDeviceToken: null });
    try {
      await storage.remove(TRUSTED_DEVICE_KEY);
    } catch (e) {
      console.error('[auth] failed to clear trusted device token', e);
    }
  },
}));
