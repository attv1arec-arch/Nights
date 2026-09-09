# Walk Memory v5

Walk Memory v5 adds a learned ETA model, walk/drive recording, activity photos with GPS positions, landmark-visit summaries inside Memories, and live slope/elevation readouts.

## Learned ETA
ETA estimates now learn from recorded **walks** (drives are excluded). The model uses your historical walking speed, time-of-day pace, trip-length pace, historical route indirectness, historical elevation gain, and the live slope around your current location. Until enough walks exist it falls back toward a normal walking-speed estimate. This is still an estimate rather than turn-by-turn pedestrian routing; future route terrain is inferred from your history rather than downloaded from a routing/elevation service.

## Activities
Choose Walk or Drive before pressing Start. Both use background GPS in the native wrapper. Drives are stored separately in Memories and do not train walking ETA.

## Activity photos
Start a walk/drive, open Photos, and take/add a photo. Each photo is saved with timestamp and GPS coordinates and appears in that activity's Memory detail and as a marker on its route map.

## Memories
Opening an activity now shows landmarks visited during it, elevation gain, photos, and the exact route. Photo markers show where each picture was taken.

## Live terrain
The Map tab shows current GPS elevation and estimated local grade/slope. Grade is calculated from recent GPS altitude changes over horizontal movement, so phone GPS altitude noise can affect it.

## Deploy
Render: Build command `npm install`; Start command `npm start`. Keep persistent storage configured with `WALK_MEMORY_DATA=/data/walk-memory-data.json`.

## Android
From `native-wrapper`: `npm install`, `npm run build`, `npx cap add android` (first time only), `npx cap sync android`, `npx cap open android`. Keep Location = Allow all the time, Precise = on, Battery = Unrestricted, Remove permissions if unused = off. Put your Render URL in Data > Server URL.
