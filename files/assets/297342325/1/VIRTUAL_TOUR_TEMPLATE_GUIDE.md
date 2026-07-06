# PlayCanvas Virtual Tour Template Guide

This template is organised so a normal editor can build a new virtual tour without editing one large JSON file or one giant runtime script.

## Main Editing Workflow

1. Select `SuperSplat_Runtime`.
2. Edit the category scripts:
   - `tourBrandingConfig` controls title, subtitle, owner labels, logo, and institution text.
   - `tourLoadingConfig` controls the PlayCanvas app loading screen.
   - `tourModelConfig` controls Gaussian Splat model URLs, default quality, LOD settings, model loading progress copy, and quality button labels.
   - `tourCameraConfig` controls the starting camera view and camera mode.
   - `tourCollisionConfig` controls the collision model used by walk mode and hotspot picking.
   - `tourAnnotationConfig` controls annotation source mode, sidebar appearance, intro annotation, autoplay, and editor sync actions.
   - `tourMovementConfig` controls walk/fly movement tuning.
   - `tourExploreSpacesConfig` controls the Explore Spaces panel.
3. Edit annotation points under `Tour_Annotations`.
4. Edit Explore Space items under `Explore_Spaces`.

## Replacing The 3D Model

Open `SuperSplat_Runtime > tourModelConfig`.

Set:

- `Streamed LOD URL` to the `lod-meta.json` URL.
- `High Quality SOG URL` to the high quality `.sog` URL.
- `Environment URL` if the tour has a separate environment/background asset.
- `Default Quality Mode` to `streamed-lod` or `high`.

The `streamedGsplat` script still performs the model loading, but `tourModelConfig` is the normal editor-facing source of truth. `streamedGsplat.loadOnInitialize` should remain off so the model does not load once with old values and then reload.

## Model Loading Progress

Open `SuperSplat_Runtime > tourModelConfig`.

Configure:

- `Show Model Loading Progress`
- `Model Loading Title`
- `Model Loading Subtitle`
- `Model Loading Progress Bar Color`
- `Show Model Loading Percentage`
- `Show Model Loading Status Text`
- `Model Loading Complete Fade Seconds`
- status text fields for requesting, downloading, decoding, environment, ready, and error states

The runtime listens for `model-load-start`, `model-load-progress`, `model-load-complete`, and `model-load-error` events from `streamedGsplat`.

## Annotation Source Modes

Open `SuperSplat_Runtime > tourAnnotationConfig`.

Choose:

- `json-asset`: use `annotations.json`.
- `central-json`: use the pasted JSON field.
- `child-entities`: read enabled children under `Tour_Annotations`.

The launched runtime can read these sources. Permanent syncing between `annotations.json` and `Tour_Annotations` is an editor-side operation and requires the PlayCanvas Editor helper/extension or manual export fallback.

## Creating Annotation Points

Create a child entity under `Tour_Annotations`, for example:

```text
Tour_Annotations
├── Annotation_001
├── Annotation_002
└── Annotation_003
```

Add `tourAnnotationPoint` to each annotation entity.

Set:

- `Enabled`
- `Order Index`
- `Annotation ID`
- `Title`
- `Description`
- `Camera Position`
- `Camera Target`
- `Camera FOV`
- `Hotspot Position Mode`
- `Show Hotspot Icon`
- `Autoplay Duration Mode`
- `Custom Autoplay Duration Seconds`

Use `entity-position` when you want to move the annotation entity visually in the Editor. Use `manual-position` when you want exact numeric hotspot coordinates.

## Adding Media To An Annotation

For one quick media item, you may still use the media fields on `tourAnnotationPoint`.

For the recommended workflow, create media child entities:

```text
Annotation_001
├── Media_001_pdf
├── Media_002_image
├── Media_003_video
└── Media_004_model
```

Add `tourAnnotationMediaItem` to each media child.

Set:

- `Enabled`
- `Sort Order`
- `Media Type`
- `Media URL`
- `Media Title`
- `Media Thumbnail URL`
- `Media Open Label`
- `Additional Media JSON`

Supported media types are `pdf`, `image`, `video`, `link`, and `model`. The runtime shows compact thumbnails in the sidebar and opens media in the shared modal viewer where supported.

## Editor-Side Annotation Sync Helper

The project includes a helper source asset:

```text
playcanvas-annotation-editor-extension.js
```

This helper is intentionally stored as a project reference asset and is not included in the launched runtime script order. It is editor-side tooling only.

Use it when you need permanent project changes:

- import `annotations.json` into `Tour_Annotations`
- regenerate missing annotation child entities
- create/update `Media_###` child entities
- export `Tour_Annotations` back to `annotations.json`
- validate JSON/entity counts

The launched tour can read annotations and media, but it cannot permanently create Editor hierarchy entities or save PlayCanvas assets without editor-side automation.

## Syncing annotations.json And Tour_Annotations

Use the editor helper/extension or the boolean triggers in `tourAnnotationConfig`:

- `Import From annotations.json`
- `Refresh Tour_Annotations`
- `Export Tour_Annotations To JSON`
- `Sync From JSON`
- `Sync To JSON`
- `Sync Both`
- `Validate Sync`
- `Dry Run Sync`

Important limitation:

- Runtime-only code cannot permanently save PlayCanvas Editor assets.
- Real writeback to `annotations.json` requires editor-side automation.
- If direct writeback is not available, use `Generated Export JSON` as the manual fallback.
- When direct writeback succeeds, `Generated Export JSON` stays empty so the Inspector does not become a giant JSON dump.

The sync system uses `annotationId` as the primary key, not the entity name. Unknown annotation fields are preserved in `Additional Annotation JSON`.

## Setting Camera Views

1. Move the PlayCanvas Editor camera to the desired view.
2. Copy or capture the current camera position.
3. Copy or capture the camera target/look-at point.
4. Set `Camera Position` in the selected annotation.
5. Set `Camera Target`.
6. Set `Camera FOV`.
7. Launch and preview the annotation.

Troubleshooting:

- Camera too close: move `Camera Position` farther from `Camera Target`.
- Camera too far: move closer or reduce FOV.
- Looking at the wrong item: adjust `Camera Target`.
- Hotspot too high: lower hotspot Y.
- Hotspot hidden in geometry: move the hotspot outward.
- Hotspot not clickable: check `Show Hotspot Icon` and `Icon Show`.

## Guided Tour And Autoplay

The guided tour uses the available enabled annotations in sorted order. If you add 30 annotations, autoplay can progress through all 30 without a hardcoded path.

Global duration comes from `tourAnnotationConfig > Annotation Autoplay Seconds`.

Per-annotation duration comes from:

- `Autoplay Duration Mode = custom`
- `Custom Autoplay Duration Seconds`

If the mode is `default`, the global duration is used.

The intro annotation is virtual and has no hotspot. If `Show Tour Intro Annotation` is off, nothing should show until Annotation 1 officially starts.

## Explore Spaces

Create child entities under `Explore_Spaces`:

```text
Explore_Spaces
├── Explore_Item_001
├── Explore_Item_002
└── Explore_Item_003
```

Each child uses `tourExploreSpaceItem`.

Set:

- `Enabled`
- `Title`
- `Description`
- `URL`
- `Thumbnail URL`
- `Open Mode`
- `Sort Order`

The Explore Spaces panel keeps its header and footer visible. Only the item list scrolls.

## Testing A New Tour

Before publishing:

1. Launch the scene.
2. Confirm there are no critical console errors.
3. Confirm the model loading overlay appears while the Gaussian Splat loads.
4. Test Streamed LOD and High Quality switching.
5. Test desktop sidebar, mobile sidebar, and mobile media horizontal scroll.
6. Test PDF/image/video/model media modal opening.
7. Test previous/next annotation navigation.
8. Test autoplay pause/resume and custom annotation duration.
9. Test Explore Spaces with many items.
10. Validate or dry-run annotation sync before exporting back to `annotations.json`.
