# Closed-app partner notifications

Nights v7 uses Firebase Cloud Messaging for Android notifications that arrive while the app is closed.

1. Create a Firebase Android app with package id `com.walkmemory.app`.
2. Download `google-services.json` and place it in the generated Capacitor Android project at `native-wrapper/android/app/google-services.json`.
3. Create a Firebase service account and make its JSON file available to the server (do not commit it).
4. Set server environment variables:
   - `FIREBASE_PROJECT_ID` to the Firebase project id.
   - `GOOGLE_APPLICATION_CREDENTIALS` to the service-account JSON path.
5. Run `npm install` in the project root and in `native-wrapper`, then run `npm run sync` from `native-wrapper`.

Without these credentials, Nights still runs; the server reports push as disabled and all local tracking/recovery features continue working.

Push events currently include shared-activity invitations, partner joins, contributed photos, and activity completion. Registration tokens are tied to the signed-in account and invalid tokens are removed automatically.
