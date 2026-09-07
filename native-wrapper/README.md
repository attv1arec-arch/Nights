# Walk Memory Final — native Android/iOS wrapper

This wrapper keeps the web UI but uses native background geolocation when a walk is running.

## Fresh Android setup

```bash
npm install
npm run build
npx cap add android
npx cap sync android
npx cap open android
```

Then select the phone in Android Studio and press Run.

## Updating an Android project you already created

Copy this new `native-wrapper` over your working wrapper, but you can keep your existing `android/` folder. Then run:

```bash
npm install
npm run build
npx cap sync android
npx cap open android
```

In Android, keep Location = Allow all the time, Precise location on, Battery = Unrestricted, notifications allowed, and "Remove permissions if app is unused" off if your phone otherwise revokes background access.

In the Android app, set Data > Server URL to the HTTPS URL where you deployed the main Walk Memory server.
