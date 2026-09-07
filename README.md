# Walk Memory v3

Walk Memory is a local-first walk journal/PWA with route maps, landmark memories, photo landmarks, visit detection, per-walk maps, separate imports/exports, and optional read-only sharing.

## What changed in v3

- Tap any local landmark to edit its name, description, detection radius, and photo gallery.
- Add multiple photos to a landmark and remove individual photos.
- Delete a landmark together with its saved landmark-visit records.
- Tap a walk in **Memories** to open a dedicated map showing that exact walk line, start, and end.
- Export/import a full backup, walks only, or landmarks only.
- Old v2 records are migrated to stable unique IDs so imports and syncing do not rely on per-device IndexedDB numbers.
- High-accuracy browser GPS filtering rejects very inaccurate fixes and implausible jumps.
- Optional sharing server creates a read-only friend link. Friends can see the synced routes, landmarks, photos, visit counts, and Memories data.
- A Capacitor native wrapper is included for reliable background/locked-screen GPS on Android/iOS.

## Run it locally

Requires Node.js 18+.

```bash
npm start
```

Then open `http://localhost:8080` on the same computer.

For GPS on a phone, deploy behind **HTTPS**. Browser geolocation requires a secure context on normal remote sites.

## Deploy it for sharing

This folder is both the website and its small Node sharing server. Deploy it to a Node-compatible HTTPS host and run:

```bash
npm start
```

The server writes shared rooms to `shared-data.json` by default. On a hosting provider with an ephemeral filesystem, attach persistent storage and set:

```bash
WALK_MEMORY_DATA=/data/shared-data.json
```

After deployment:

1. Open Walk Memory on the owner's phone.
2. Go to **Data → Shared room**.
3. If the web app and API use the same URL, leave **Sync server URL** blank.
4. Tap **Enable sharing**.
5. Copy the generated share link and send it to a friend.
6. Friends opening that link get a read-only shared view.

The room identifier in the URL acts like a secret viewing link. Anyone who has that link can see exact route coordinates and landmark photos, so only share it with people you trust.

## PWA vs locked-screen GPS

The normal website/PWA uses `navigator.geolocation.watchPosition()` with high accuracy. It works well while the browser/PWA remains active, but mobile operating systems can suspend or throttle a web page after the screen locks or another app takes over.

The `native-wrapper/` folder adds `@capacitor-community/background-geolocation` through Capacitor. Build that version when you need dependable background/locked-screen route recording. See `native-wrapper/README.md`.

## Backup format

- **Full backup**: walks + landmarks + visits.
- **Walks only**: route histories and GPS points.
- **Landmarks only**: landmarks, photos, radii, and their visit history.

Imports merge records by stable UID instead of blindly duplicating them.
