import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

window.WalkMemoryNative = {
  isAvailable() { return Capacitor.isNativePlatform(); },
  async start(onLocation, onError) {
    try { await LocalNotifications.requestPermissions(); } catch {}
    return BackgroundGeolocation.addWatcher({
      backgroundMessage: 'Walk Memory is recording your walk. Tap to return.',
      backgroundTitle: 'Walk Memory tracking',
      requestPermissions: true,
      stale: false,
      distanceFilter: 2
    }, (location, error) => {
      if (error) return onError?.(error);
      if (location) onLocation?.(location);
    });
  },
  async stop(id) { if (id != null) await BackgroundGeolocation.removeWatcher({id}); },
  async openSettings() { await BackgroundGeolocation.openSettings(); }
};
