# Walk Memory — Final v4

A local-first walk journal with native background GPS support, accounts, partner sharing, route maps, photo landmarks, ratings/notes/categories, visit detection, backups, and a 2000s red/metal interface.

## New in Final v4

- User accounts with password hashing and session tokens.
- One-to-one partner linking using invite codes.
- Each account has its own cloud snapshot. Linked partners can see each other's synced walks and landmarks.
- 2000s-inspired metallic interface with red accents.
- Landmark categories, 0–5 star ratings, separate notes, descriptions, photos, and radius settings.
- Approximate walking time and distance from current GPS location to each landmark. This estimate uses straight-line distance with a path factor and average walking speed; it is not turn-by-turn routing.
- Map selector for your data, partner data, or both.
- Memories selector for your walks or partner walks.
- Full/walk-only/landmark-only import/export remains supported.
- Native background GPS wrapper remains included.

## Deploy the website/server

Requires Node.js 18+.

```bash
npm start
```

Deploy the repository as a Node web service. Build command: `npm install`. Start command: `npm start`.

For the normal hosted website, leave Data > Server URL blank. For the native Android app, put your deployed HTTPS URL in Data > Server URL.

## IMPORTANT: persistent server data

Accounts, password hashes, partner links, and cloud snapshots are stored in `walk-memory-data.json` by default. A hosting service with an ephemeral filesystem can delete that file during a restart/redeploy.

For a real long-term deployment, attach persistent storage and set:

```text
WALK_MEMORY_DATA=/data/walk-memory-data.json
```

The local phone database still exists independently, but account credentials and partner/cloud data need persistent server storage.

## Account flow

1. Each person opens the deployed app and creates a separate account.
2. One person opens Account and copies their invite code.
3. The other person enters that code under Connect Partner.
4. Both accounts are linked. Each person's data remains separate, but synced walks and landmarks are visible to the other.
5. Use Map > Mine + partner and Memories > Partner walks to view the other person's data.

## Native background GPS

See `native-wrapper/README.md`. The regular PWA can be throttled with the screen off; the native wrapper uses the Capacitor background geolocation plugin.

## Backups

Use Data to export full backups, walks only, or landmarks only. Stable UIDs are used when importing so matching records update instead of blindly duplicating.
