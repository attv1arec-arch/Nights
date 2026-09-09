# Nights v6

Nights is a local-first walk/drive memory journal with linked partner accounts, background GPS, landmarks, activity photos, personalized ETA, terrain/slope readouts, and shared partner activities.

## Upgrade safety

- The Android app keeps the existing app id `com.walkmemory.app` so installing v6 over an older version preserves the same app storage.
- The IndexedDB database name remains `WalkMemory`; existing walks, drives, landmarks, visits, and photos remain compatible.
- Make a Full Backup before upgrades anyway.

## New in v6

- App/brand name changed to **Nights**.
- Settings tab with GUI scale, compact UI, photo-marker visibility, tracking auto-center, and default map ownership view.
- Main Map shows camera markers where activity photos were taken. Landmark markers remain the landmark photos.
- Password recovery using the current invite code of the account's already-linked partner. The partner code works as a recovery secret, so keep it private.
- Shared activity mode: the host starts a Walk or Drive with **Let my partner sync to this activity** enabled. The linked partner taps **SYNC WITH PARTNER**. Only the host records the track line; the joined partner can add GPS-stamped photos to that same activity. When the host saves, contributed photos are attached to the host activity and then cloud-synced.

## Render

Build: `npm install`

Start: `npm start`

For persistent accounts and shared data, keep persistent storage and set:

`WALK_MEMORY_DATA=/data/walk-memory-data.json`

## Android

From `native-wrapper`:

```bash
npm install
npm run build
npx cap add android   # only if android/ does not exist
npx cap sync android
npx cap open android
```

Install over the existing app instead of uninstalling it if you want to preserve local data. The app id intentionally remains unchanged.
