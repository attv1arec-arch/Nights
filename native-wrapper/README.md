# Nights v6 native wrapper

This Capacitor wrapper keeps the existing Android app id `com.walkmemory.app` for in-place upgrades. It loads the Nights web UI plus the native background geolocation bridge.

Build with:

```bash
npm install
npm run build
npx cap add android   # once per fresh folder
npx cap sync android
npx cap open android
```

Keep Android Location set to Allow all the time, Precise on, Battery Unrestricted, notifications allowed, and Remove permissions if unused off for the most reliable locked-screen recording.
