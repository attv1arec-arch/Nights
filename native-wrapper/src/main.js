import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

window.WalkMemoryNative = {
  isAvailable() { return Capacitor.isNativePlatform(); },
  async start(onLocation, onError) {
    try { await LocalNotifications.requestPermissions(); } catch {}
    return BackgroundGeolocation.addWatcher({
      backgroundMessage: 'Nights is recording your activity. Tap to return.',
      backgroundTitle: 'Nights tracking',
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
