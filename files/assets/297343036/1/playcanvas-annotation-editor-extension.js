(async function installPermanentTourAnnotationSync() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitForEditor = async () => {
    const started = Date.now();
    while (!window.editor || !window.config?.self?.branch?.id) {
      if (Date.now() - started > 60000) {
        throw new Error('PlayCanvas Editor API was not ready after 60 seconds.');
      }
      await wait(250);
    }
    return window.editor;
  };

  const editor = await waitForEditor();
  if (window.tourAnnotationSync?.destroy) {
    window.tourAnnotationSync.destroy();
  }

  const SCRIPT_NAME = 'tourAnnotationPoint';
  const MEDIA_SCRIPT_NAME = 'tourAnnotationMediaItem';
  const CONFIG_SCRIPT_NAME = 'tourAnnotationConfig';
  const ASSET_NAME = 'annotations.json';
  const PARENT_NAME = 'Tour_Annotations';
  const INTRO_ENTITY_NAME = 'Intro_Annotation';
  const INTRO_ID = '__intro__';
  const state = {
    destroyed: false,
    syncing: false,
    ignoreEntityUntil: 0,
    ignoreAssetUntil: 0,
    entityTimer: 0,
    assetTimer: 0,
    watchTimer: 0,
    events: [],
    watchedEntityIds: new Set(),
    watchedConfigIds: new Set(),
    lastSync: '',
    lastResult: null
  };

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const asNumber = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const asVec3 = (value, fallback = [0, 0, 0]) => {
    if (Array.isArray(value) && value.length >= 3) {
      return [asNumber(value[0], fallback[0]), asNumber(value[1], fallback[1]), asNumber(value[2], fallback[2])];
    }
    if (value && typeof value === 'object') {
      return [asNumber(value.x, fallback[0]), asNumber(value.y, fallback[1]), asNumber(value.z, fallback[2])];
    }
    return fallback.slice();
  };
  const slug = (value, fallback) => (value || fallback || 'annotation')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^\d+\.\s*/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || fallback;

  const getEntities = () => editor.call('entities:list') || [];
  const getAssets = () => editor.call('assets:list') || [];
  const getAnnotationAsset = () => getAssets().find((asset) => asset.get('name') === ASSET_NAME);
  const getParent = () => getEntities().find((entity) => entity.get('name') === PARENT_NAME);
  const getChildPoints = () => {
    const parent = getParent();
    const childIds = parent?.get('children') || [];
    return childIds
      .map((id) => editor.call('entities:get', id))
      .filter(Boolean)
      .filter((entity) => entity.has(`components.script.scripts.${SCRIPT_NAME}.attributes`));
  };
  const getPointAttrs = (entity) => entity?.get?.(`components.script.scripts.${SCRIPT_NAME}.attributes`) || {};
  const isIntroAttrs = (attrs = {}) => attrs.annotationType === 'intro' ||
    attrs.annotationId === INTRO_ID ||
    attrs.annotationId === '__tour_intro__';
  const isIntroEntity = (entity) => entity?.get?.('name') === INTRO_ENTITY_NAME || isIntroAttrs(getPointAttrs(entity));
  const getIntroPoint = () => getChildPoints().find(isIntroEntity) || null;
  const getNormalChildPoints = () => getChildPoints().filter((entity) => !isIntroEntity(entity));
  const getMediaChildren = (annotationEntity) => {
    const childIds = annotationEntity?.get?.('children') || [];
    return childIds
      .map((id) => editor.call('entities:get', id))
      .filter(Boolean)
      .filter((entity) => entity.has(`components.script.scripts.${MEDIA_SCRIPT_NAME}.attributes`));
  };
  const getConfigEntities = () => getEntities()
    .filter((entity) => entity.has(`components.script.scripts.${CONFIG_SCRIPT_NAME}.attributes`));
  const getSyncOptions = () => {
    const config = getConfigEntities()[0];
    const attrs = config?.get(`components.script.scripts.${CONFIG_SCRIPT_NAME}.attributes`) || {};
    return {
      config,
      dryRun: attrs.dryRunSync === true,
      conflictStrategy: ['prefer-json', 'prefer-child-entities', 'warn-only'].includes(attrs.conflictStrategy) ? attrs.conflictStrategy : 'warn-only',
      archiveMissing: attrs.archiveMissingJsonAnnotations !== false,
      preserveUnknown: attrs.preserveUnknownFields !== false
    };
  };
  const updateConfigStatus = (status, report, generatedExportJson = undefined) => {
    const time = new Date().toISOString();
    getConfigEntities().forEach((entity) => {
      const base = `components.script.scripts.${CONFIG_SCRIPT_NAME}.attributes`;
      try {
        entity.set(`${base}.lastSyncStatus`, status);
        entity.set(`${base}.lastSyncTime`, time);
        entity.set(`${base}.lastSyncReport`, report);
        if (generatedExportJson !== undefined) {
          entity.set(`${base}.generatedExportJson`, generatedExportJson);
        }
      } catch {}
    });
  };
  const CORE_ANNOTATION_KEYS = new Set([
    'id', 'annotationId', 'annotationType', 'type', 'isTourIntro', 'enabled', 'annotationEnabled', 'orderIndex', 'title', 'name',
    'description', 'text', 'position', 'target', 'fov', 'hotspot', 'marker',
    'hotspotPosition', 'annotationPosition', 'hasHotspot', 'showHotspot', 'icon',
    'media', 'pdfUrl', 'pdfURL', 'pdf', 'pdfTitle', 'mediaTitle',
    'autoplay', 'autoplayDurationMode', 'autoplayDurationSeconds', 'durationMode',
    'durationSeconds'
  ]);
  const CORE_MEDIA_KEYS = new Set([
    'type', 'mediaType', 'url', 'src', 'href', 'title', 'name',
    'thumbnailUrl', 'thumbnail', 'poster', 'openLabel', 'mediaOpenLabel',
    'sortOrder', 'enabled', 'mediaEnabled'
  ]);
  const getExtraAnnotationJson = (annotation) => {
    const extra = {};
    for (const [key, value] of Object.entries(annotation || {})) {
      if (key === 'icon' && value && typeof value === 'object' && !Array.isArray(value)) {
        const iconExtra = { ...value };
        delete iconExtra.show;
        if (Object.keys(iconExtra).length) {
          extra.icon = iconExtra;
        }
        continue;
      }
      if (key === 'autoplay' && value && typeof value === 'object' && !Array.isArray(value)) {
        const autoplayExtra = { ...value };
        delete autoplayExtra.durationMode;
        delete autoplayExtra.durationSeconds;
        if (Object.keys(autoplayExtra).length) {
          extra.autoplay = autoplayExtra;
        }
        continue;
      }
      if (!CORE_ANNOTATION_KEYS.has(key)) {
        extra[key] = value;
      }
    }
    return Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '';
  };
  const getExtraMediaJson = (media) => {
    const extra = {};
    for (const [key, value] of Object.entries(media || {})) {
      if (!CORE_MEDIA_KEYS.has(key)) {
        extra[key] = value;
      }
    }
    return Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '';
  };
  const isIntroAnnotation = (annotation) => annotation?.type === 'intro' ||
    annotation?.isTourIntro === true ||
    annotation?.id === INTRO_ID ||
    annotation?.id === '__tour_intro__' ||
    annotation?.annotationId === INTRO_ID ||
    annotation?.annotationId === '__tour_intro__';
  const parseAnnotationDocument = (value) => {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    let annotations = [];
    let introAnnotation = null;
    let schemaVersion = 2;
    let legacyArray = false;
    if (Array.isArray(parsed)) {
      legacyArray = true;
      annotations = parsed;
    } else if (parsed && typeof parsed === 'object') {
      schemaVersion = asNumber(parsed.schemaVersion, 2);
      introAnnotation = parsed.introAnnotation || null;
      if (Array.isArray(parsed.annotations)) {
        annotations = parsed.annotations;
      } else if (parsed.id || parsed.title || parsed.name || parsed.position || parsed.target) {
        legacyArray = true;
        annotations = [parsed];
      }
    }
    if (!introAnnotation) {
      const introIndex = annotations.findIndex(isIntroAnnotation);
      if (introIndex !== -1) {
        introAnnotation = annotations[introIndex];
        annotations = annotations.filter((_, index) => index !== introIndex);
      }
    }
    return {
      schemaVersion,
      introAnnotation,
      annotations,
      legacyArray
    };
  };
  const parseAnnotations = (value) => {
    return parseAnnotationDocument(value).annotations;
  };
  const getMediaItems = (annotation) => {
    if (Array.isArray(annotation.media)) {
      return annotation.media
        .filter((item) => item && typeof item === 'object' && (item.url || item.src || item.href))
        .map((item, index) => normalizeMediaItem(item, index));
    }
    if (annotation.media && typeof annotation.media === 'object') {
      return [normalizeMediaItem(annotation.media, 0)];
    }
    if (annotation.pdfUrl || annotation.pdfURL || annotation.pdf) {
      return [{
        type: 'pdf',
        url: annotation.pdfUrl || annotation.pdfURL || annotation.pdf,
        title: annotation.pdfTitle || annotation.mediaTitle || annotation.title || '',
        sortOrder: 1
      }];
    }
    return [];
  };
  const normalizeMediaItem = (media, index = 0) => {
    const type = ['pdf', 'image', 'video', 'link', 'model'].includes(media.type || media.mediaType)
      ? (media.type || media.mediaType)
      : 'link';
    return {
      ...media,
      type,
      url: media.url || media.src || media.href || '',
      title: media.title || media.name || '',
      thumbnailUrl: media.thumbnailUrl || media.thumbnail || media.poster || '',
      openLabel: media.openLabel || media.mediaOpenLabel || 'Click to view more details',
      sortOrder: asNumber(media.sortOrder, index + 1)
    };
  };
  const getAutoplayDurationMode = (annotation) => {
    const mode = (annotation.autoplay?.durationMode || annotation.autoplayDurationMode || annotation.durationMode || '').toString().toLowerCase();
    return mode === 'custom' ? 'custom' : 'default';
  };
  const getAutoplayDurationSeconds = (annotation, fallback = 6) => {
    const value = annotation.autoplay?.durationSeconds ?? annotation.autoplayDurationSeconds ?? annotation.durationSeconds;
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
  };
  const annotationToAttributes = (annotation, index) => {
    const isIntro = isIntroAnnotation(annotation);
    const id = isIntro ? (annotation.id || annotation.annotationId || INTRO_ID) : (annotation.id || annotation.annotationId || slug(annotation.title, `annotation-${index + 1}`));
    const mediaItems = getMediaItems(annotation);
    const media = mediaItems[0] || null;
    const mediaType = ['image', 'video', 'pdf', 'link', 'model'].includes(media?.type) ? media.type : 'none';
    const explicitHotspot = annotation.hotspot || annotation.marker || annotation.hotspotPosition || annotation.annotationPosition;
    const hotspot = asVec3(explicitHotspot, asVec3(annotation.target || annotation.position, [0, 0, 0]));
    return {
      annotationType: isIntro ? 'intro' : 'normal',
      annotationEnabled: annotation.enabled !== false && annotation.annotationEnabled !== false,
      orderIndex: isIntro ? 0 : asNumber(annotation.orderIndex, index + 1),
      annotationId: id,
      title: annotation.title || annotation.name || (isIntro ? 'Welcome to the Virtual Tour' : `Annotation ${index + 1}`),
      description: annotation.description || annotation.text || '',
      hotspotPositionMode: isIntro || explicitHotspot ? 'manual-position' : 'entity-position',
      manualHotspotPosition: hotspot,
      cameraPosition: asVec3(annotation.camera?.initial?.position || annotation.camera?.position || annotation.initial?.position || annotation.position, [0, 1.6, 3]),
      cameraTarget: asVec3(annotation.target || annotation.camera?.target || annotation.camera?.initial?.target || annotation.initial?.target, [0, 1.6, 0]),
      cameraFov: asNumber(annotation.fov || annotation.camera?.fov || annotation.camera?.initial?.fov || annotation.initial?.fov, 75),
      mediaType,
      mediaUrl: mediaType !== 'none' ? (media.url || media.src || media.href || '') : '',
      mediaTitle: mediaType !== 'none' ? (media.title || media.name || annotation.title || '') : '',
      mediaThumbnailUrl: mediaType !== 'none' ? (media.thumbnailUrl || media.thumbnail || media.poster || '') : '',
      mediaOpenLabel: mediaType !== 'none' ? (media.openLabel || media.mediaOpenLabel || 'Click to view more details') : 'Click to view more details',
      mediaItemsJson: '',
      showHotspot: isIntro ? false : annotation.showHotspot !== false && annotation.hasHotspot !== false,
      iconShow: isIntro ? false : annotation.icon?.show !== false && annotation.showHotspot !== false && annotation.hasHotspot !== false,
      pdfUrl: annotation.pdfUrl || annotation.pdfURL || annotation.pdf || (mediaItems.find((item) => item.type === 'pdf')?.url || ''),
      autoplayDurationMode: getAutoplayDurationMode(annotation),
      autoplayDurationSeconds: getAutoplayDurationSeconds(annotation, isIntro ? 8 : 6),
      additionalJson: getExtraAnnotationJson(annotation)
    };
  };
  const parseJsonField = (value, fallback) => {
    if (!value || !value.trim()) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  };
  const getMediaItemsFromAttributes = (attrs) => {
    const parsed = parseJsonField(attrs.mediaItemsJson, null);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item) => item && typeof item === 'object' && (item.url || item.src || item.href))
        .map((item, index) => normalizeMediaItem(item, index));
    }
    const mediaType = ['image', 'video', 'pdf', 'link', 'model'].includes(attrs.mediaType) ? attrs.mediaType : 'none';
    if (mediaType === 'none' || !attrs.mediaUrl) return [];
    return [{
      type: mediaType,
      url: attrs.mediaUrl,
      title: attrs.mediaTitle || attrs.title || '',
      ...(attrs.mediaThumbnailUrl ? { thumbnailUrl: attrs.mediaThumbnailUrl } : {}),
      ...(attrs.mediaOpenLabel ? { openLabel: attrs.mediaOpenLabel } : {}),
      sortOrder: 1
    }];
  };
  const mediaAttributesToItem = (entity) => {
    const attrs = entity.get(`components.script.scripts.${MEDIA_SCRIPT_NAME}.attributes`) || {};
    if (attrs.mediaEnabled === false || !attrs.mediaUrl) return null;
    const type = ['pdf', 'image', 'video', 'link', 'model'].includes(attrs.mediaType) ? attrs.mediaType : 'link';
    const extra = parseJsonField(attrs.additionalJson, {});
    return {
      ...(extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {}),
      type,
      url: attrs.mediaUrl,
      title: attrs.mediaTitle || entity.get('name') || type.toUpperCase(),
      thumbnailUrl: attrs.mediaThumbnailUrl || extra?.thumbnailUrl || extra?.thumbnail || extra?.poster || '',
      openLabel: attrs.mediaOpenLabel || extra?.openLabel || 'Click to view more details',
      sortOrder: asNumber(attrs.sortOrder, 0)
    };
  };
  const getMediaItemsFromEntity = (entity, attrs) => {
    const childItems = getMediaChildren(entity)
      .map(mediaAttributesToItem)
      .filter(Boolean)
      .sort((a, b) => asNumber(a.sortOrder, 0) - asNumber(b.sortOrder, 0));
    return childItems.length ? childItems : getMediaItemsFromAttributes(attrs);
  };
  const attributesToAnnotation = (entity) => {
    const attrs = entity.get(`components.script.scripts.${SCRIPT_NAME}.attributes`) || {};
    const isIntro = isIntroAttrs(attrs) || entity.get('name') === INTRO_ENTITY_NAME;
    const hotspot = attrs.hotspotPositionMode === 'manual-position'
      ? asVec3(attrs.manualHotspotPosition, [0, 0, 0])
      : asVec3(entity.get('position'), asVec3(attrs.manualHotspotPosition, [0, 0, 0]));
    const id = isIntro ? (attrs.annotationId || INTRO_ID) : (attrs.annotationId || entity.get('name'));
    const mediaItems = getMediaItemsFromEntity(entity, attrs);
    const durationMode = attrs.autoplayDurationMode === 'custom' ? 'custom' : 'default';
    const durationSeconds = Math.max(0.5, asNumber(attrs.autoplayDurationSeconds, isIntro ? 8 : 6));
    const extra = parseJsonField(attrs.additionalJson, {});
    const annotation = {
      ...(extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {}),
      id,
      annotationId: id,
      ...(isIntro ? { type: 'intro', isTourIntro: true, enabled: attrs.annotationEnabled !== false } : {}),
      orderIndex: isIntro ? 0 : asNumber(attrs.orderIndex, 0),
      title: attrs.title || entity.get('name'),
      description: attrs.description || '',
      position: asVec3(attrs.cameraPosition, [0, 1.6, 3]),
      target: asVec3(attrs.cameraTarget, [0, 1.6, 0]),
      fov: asNumber(attrs.cameraFov, 75),
      ...(!isIntro ? { hotspot } : {}),
      showHotspot: isIntro ? false : attrs.showHotspot !== false,
      icon: { ...(extra?.icon || {}), show: isIntro ? false : attrs.iconShow !== false && attrs.showHotspot !== false },
      autoplay: {
        ...(extra?.autoplay || {}),
        durationMode,
        durationSeconds
      },
      autoplayDurationMode: durationMode,
      autoplayDurationSeconds: durationSeconds
    };
    if (mediaItems.length === 1) {
      annotation.media = mediaItems[0];
    } else if (mediaItems.length > 1) {
      annotation.media = mediaItems;
    }
    const hasPdfMedia = mediaItems.some((item) => item.type === 'pdf' && item.url);
    if (!hasPdfMedia && attrs.pdfUrl) {
      annotation.pdfUrl = attrs.pdfUrl;
    }
    return annotation;
  };
  const setIfChanged = (entity, path, value) => {
    if (JSON.stringify(entity.get(path)) !== JSON.stringify(value)) {
      entity.set(path, clone(value));
    }
  };
  const mediaToAttributes = (media, index) => {
    const item = normalizeMediaItem(media, index);
    return {
      mediaEnabled: media.enabled !== false && media.mediaEnabled !== false,
      sortOrder: asNumber(item.sortOrder, index + 1),
      mediaType: item.type,
      mediaUrl: item.url || '',
      mediaTitle: item.title || '',
      mediaThumbnailUrl: item.thumbnailUrl || '',
      mediaOpenLabel: item.openLabel || 'Click to view more details',
      additionalJson: getExtraMediaJson(media)
    };
  };
  const ensureMediaChildEntities = async (annotationEntity, mediaItems) => {
    const existing = getMediaChildren(annotationEntity);
    const touched = new Set();
    const byOrderAndType = new Map();
    existing.forEach((entity) => {
      const attrs = entity.get(`components.script.scripts.${MEDIA_SCRIPT_NAME}.attributes`) || {};
      byOrderAndType.set(`${asNumber(attrs.sortOrder, 0)}:${attrs.mediaType || ''}`, entity);
    });

    for (let i = 0; i < mediaItems.length; i++) {
      const attrs = mediaToAttributes(mediaItems[i], i);
      const key = `${attrs.sortOrder}:${attrs.mediaType}`;
      const fallback = existing[i];
      let mediaEntity = byOrderAndType.get(key) || fallback;
      if (mediaEntity) {
        if (!mediaEntity.has('components.script')) {
          mediaEntity.set('components.script', { enabled: true, order: [], scripts: {} });
        }
        if (!mediaEntity.has(`components.script.scripts.${MEDIA_SCRIPT_NAME}`)) {
          mediaEntity.set(`components.script.scripts.${MEDIA_SCRIPT_NAME}`, { enabled: true, attributes: attrs });
          const order = mediaEntity.get('components.script.order') || [];
          if (!order.includes(MEDIA_SCRIPT_NAME)) {
            mediaEntity.insert('components.script.order', MEDIA_SCRIPT_NAME);
          }
        }
        setIfChanged(mediaEntity, `components.script.scripts.${MEDIA_SCRIPT_NAME}.attributes`, attrs);
      } else {
        const created = editor.api.globals.entities.create({
          name: `Media_${String(i + 1).padStart(3, '0')}_${attrs.mediaType}`,
          parent: annotationEntity.get('resource_id'),
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          enabled: true,
          components: {
            script: {
              enabled: true,
              order: [MEDIA_SCRIPT_NAME],
              scripts: { [MEDIA_SCRIPT_NAME]: { enabled: true, attributes: attrs } }
            }
          },
          children: [],
          tags: []
        }, { history: true, select: false });
        await wait(0);
        mediaEntity = created?.observer || editor.call('entities:get', created?.get?.('resource_id'));
      }
      if (mediaEntity) {
        touched.add(mediaEntity.get('resource_id'));
        const readableName = `Media_${String(i + 1).padStart(3, '0')}_${attrs.mediaType}`;
        if (mediaEntity.get('name') !== readableName) {
          mediaEntity.set('name', readableName);
        }
      }
    }

    existing.forEach((entity) => {
      if (!touched.has(entity.get('resource_id'))) {
        entity.set(`components.script.scripts.${MEDIA_SCRIPT_NAME}.attributes.mediaEnabled`, false);
      }
    });
  };
  const ensurePointEntity = async (parent, annotation, index, existingById, existingByIndex) => {
    const attrs = annotationToAttributes(annotation, index);
    const mediaItems = getMediaItems(annotation);
    const isIntro = attrs.annotationType === 'intro';
    const existing = isIntro
      ? (getIntroPoint() || existingById.get(attrs.annotationId) || existingById.get('__tour_intro__'))
      : (existingById.get(attrs.annotationId) || existingByIndex.get(index + 1));
    const entityPosition = isIntro
      ? asVec3(attrs.cameraPosition, [0, 1.6, 3])
      : asVec3(attrs.manualHotspotPosition, [0, 0, 0]);
    const readableName = isIntro
      ? INTRO_ENTITY_NAME
      : `Annotation_${String(index + 1).padStart(3, '0')}_${slug(attrs.annotationId, `annotation-${index + 1}`)}`;
    if (existing) {
      if (!existing.has('components.script')) {
        existing.set('components.script', { enabled: true, order: [], scripts: {} });
      }
      if (!existing.has(`components.script.scripts.${SCRIPT_NAME}`)) {
        existing.set(`components.script.scripts.${SCRIPT_NAME}`, { enabled: true, attributes: attrs });
        if (!existing.get('components.script.order')?.includes(SCRIPT_NAME)) {
          existing.insert('components.script.order', SCRIPT_NAME);
        }
      }
      setIfChanged(existing, `components.script.scripts.${SCRIPT_NAME}.attributes`, attrs);
      setIfChanged(existing, 'position', entityPosition);
      if (existing.get('name') !== readableName) {
        existing.set('name', readableName);
      }
      await ensureMediaChildEntities(existing, mediaItems);
      return existing;
    }
    const entity = editor.api.globals.entities.create({
      name: readableName,
      parent: parent.get('resource_id'),
      position: entityPosition,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      enabled: true,
      components: {
        script: {
          enabled: true,
          order: [SCRIPT_NAME],
          scripts: { [SCRIPT_NAME]: { enabled: true, attributes: attrs } }
        }
      },
      children: [],
      tags: []
    }, { history: true, select: false });
    await wait(0);
    const createdEntity = entity?.observer || editor.call('entities:get', entity?.get?.('resource_id'));
    if (createdEntity) {
      await ensureMediaChildEntities(createdEntity, mediaItems);
    }
    return createdEntity;
  };
  const readAnnotationsJson = async () => {
    const asset = getAnnotationAsset();
    if (!asset) throw new Error(`${ASSET_NAME} asset was not found`);
    const url = asset.get('file.url');
    const response = await fetch(url + (url.includes('?') ? '&' : '?') + 'annotationSync=' + Date.now(), { credentials: 'include' });
    if (!response.ok) throw new Error(`Could not fetch ${ASSET_NAME}: HTTP ${response.status}`);
    return parseAnnotationDocument(await response.json());
  };
  const writeAnnotationsJson = async (document) => {
    const asset = getAnnotationAsset();
    if (!asset) throw new Error(`${ASSET_NAME} asset was not found`);
    const source = JSON.stringify(document, null, 2);
    const form = new FormData();
    form.append('branchId', window.config.self.branch.id);
    form.append('filename', ASSET_NAME);
    form.append('file', new Blob([source], { type: 'application/json' }), ASSET_NAME);
    const response = await fetch(`/api/assets/${asset.get('id')}`, { method: 'PUT', credentials: 'include', body: form });
    const text = await response.text();
    if (!response.ok) throw new Error(`Could not update ${ASSET_NAME}: HTTP ${response.status} ${text.slice(0, 160)}`);
    return JSON.parse(text);
  };
  const syncJsonToEntities = async () => {
    if (state.destroyed) return null;
    state.syncing = true;
    state.ignoreEntityUntil = Date.now() + 1200;
    try {
      const options = getSyncOptions();
      const document = await readAnnotationsJson();
      const annotations = document.annotations || [];
      const parent = getParent();
      if (!parent) throw new Error(`${PARENT_NAME} entity was not found`);
      const children = getChildPoints();
      const existingById = new Map();
      const existingByIndex = new Map();
      for (const child of children) {
        const attrs = child.get(`components.script.scripts.${SCRIPT_NAME}.attributes`) || {};
        if (attrs.annotationId) existingById.set(attrs.annotationId, child);
        if (attrs.orderIndex) existingByIndex.set(Number(attrs.orderIndex), child);
      }
      if (options.dryRun) {
        const jsonIds = new Set(annotations.map((annotation, index) => annotation.id || annotation.annotationId || slug(annotation.title, `annotation-${index + 1}`)));
        if (document.introAnnotation) {
          jsonIds.add(document.introAnnotation.id || document.introAnnotation.annotationId || INTRO_ID);
        }
        const existingIds = new Set(children.map((child) => (child.get(`components.script.scripts.${SCRIPT_NAME}.attributes`) || {}).annotationId).filter(Boolean));
        const create = [...jsonIds].filter((id) => !existingIds.has(id));
        const archive = [...existingIds].filter((id) => !jsonIds.has(id));
        const update = [...jsonIds].filter((id) => existingIds.has(id));
        const report = `[AnnotationSync] Dry run JSON -> Tour_Annotations: create ${create.length}, update ${update.length}, archive ${archive.length}.`;
        state.lastSync = 'json-to-entities-dry-run';
        state.lastResult = { direction: state.lastSync, count: annotations.length, create: create.length, update: update.length, archive: archive.length, at: new Date().toISOString() };
        updateConfigStatus('Dry run complete', report);
        setPanelStatus('Dry run complete');
        return state.lastResult;
      }
      const touched = new Set();
      if (document.introAnnotation) {
        const introPoint = await ensurePointEntity(parent, {
          ...document.introAnnotation,
          id: document.introAnnotation.id || document.introAnnotation.annotationId || INTRO_ID,
          annotationId: document.introAnnotation.annotationId || document.introAnnotation.id || INTRO_ID,
          type: 'intro',
          isTourIntro: true,
          showHotspot: false,
          icon: {
            ...(document.introAnnotation.icon || {}),
            show: false
          }
        }, -1, existingById, existingByIndex);
        if (introPoint) touched.add(introPoint.get('resource_id'));
      }
      for (let i = 0; i < annotations.length; i++) {
        const point = await ensurePointEntity(parent, annotations[i], i, existingById, existingByIndex);
        if (point) touched.add(point.get('resource_id'));
      }
      if (options.archiveMissing) {
        for (const child of children) {
          if (!touched.has(child.get('resource_id'))) {
            child.set(`components.script.scripts.${SCRIPT_NAME}.attributes.annotationEnabled`, false);
          }
        }
      }
      state.lastSync = 'json-to-entities';
      state.lastResult = { direction: state.lastSync, count: annotations.length, at: new Date().toISOString() };
      updateConfigStatus('Refresh complete', `[AnnotationSync] Refreshed ${annotations.length} annotations from annotations.json.`);
      setPanelStatus(`Refreshed ${annotations.length} annotations`);
      return state.lastResult;
    } finally {
      state.syncing = false;
    }
  };
  const syncEntitiesToJson = async () => {
    if (state.destroyed) return null;
    state.syncing = true;
    state.ignoreAssetUntil = Date.now() + 4000;
    try {
      const options = getSyncOptions();
      const introEntity = getIntroPoint();
      const introAnnotation = introEntity &&
        introEntity.get(`components.script.scripts.${SCRIPT_NAME}.attributes.annotationEnabled`) !== false
        ? attributesToAnnotation(introEntity)
        : null;
      const annotations = getNormalChildPoints()
        .filter((entity) => entity.get(`components.script.scripts.${SCRIPT_NAME}.attributes.annotationEnabled`) !== false)
        .sort((a, b) => asNumber(a.get(`components.script.scripts.${SCRIPT_NAME}.attributes.orderIndex`), 0) - asNumber(b.get(`components.script.scripts.${SCRIPT_NAME}.attributes.orderIndex`), 0))
        .map(attributesToAnnotation);
      const document = {
        schemaVersion: 2,
        ...(introAnnotation ? { introAnnotation } : {}),
        annotations
      };
      const source = JSON.stringify(document, null, 2);
      if (options.dryRun) {
        const report = `[AnnotationSync] Dry run Tour_Annotations -> JSON: would export ${annotations.length} annotations${introAnnotation ? ' plus introAnnotation' : ''}.`;
        state.lastSync = 'entities-to-json-dry-run';
        state.lastResult = { direction: state.lastSync, count: annotations.length, intro: !!introAnnotation, at: new Date().toISOString() };
        updateConfigStatus('Dry run complete', report, source);
        setPanelStatus('Dry run complete');
        return state.lastResult;
      }
      const result = await writeAnnotationsJson(document);
      state.lastSync = 'entities-to-json';
      state.lastResult = { direction: state.lastSync, count: annotations.length, intro: !!introAnnotation, hash: result?.file?.hash || null, at: new Date().toISOString() };
      // Direct editor-side export succeeded, so keep the Inspector tidy.
      // Dry-run is the only path that fills Generated Export JSON.
      updateConfigStatus('Export complete', `[AnnotationSync] Exported ${annotations.length} annotations${introAnnotation ? ' plus introAnnotation' : ''} to annotations.json.`, '');
      setPanelStatus(`Exported ${annotations.length}${introAnnotation ? ' + intro' : ''}`);
      return state.lastResult;
    } finally {
      state.syncing = false;
    }
  };
  const debounceEntitiesToJson = () => {
    if (state.destroyed || state.syncing || Date.now() < state.ignoreEntityUntil) return;
    window.clearTimeout(state.entityTimer);
    state.entityTimer = window.setTimeout(() => {
      syncEntitiesToJson().catch((error) => setPanelStatus(error.message, true));
    }, 900);
  };
  const debounceJsonToEntities = () => {
    if (state.destroyed || state.syncing || Date.now() < state.ignoreAssetUntil) return;
    window.clearTimeout(state.assetTimer);
    state.assetTimer = window.setTimeout(() => {
      syncJsonToEntities().catch((error) => setPanelStatus(error.message, true));
    }, 900);
  };
  const resetConfigTrigger = (entity, field) => {
    const path = `components.script.scripts.${CONFIG_SCRIPT_NAME}.attributes.${field}`;
    window.setTimeout(() => {
      try {
        if (entity.get(path) === true) entity.set(path, false);
      } catch {}
    }, 0);
  };
  const watchEntity = (entity) => {
    const id = entity?.get?.('resource_id');
    if (!entity || !id || state.watchedEntityIds.has(id)) return;
    state.watchedEntityIds.add(id);
    const onChanged = (path) => {
      if (path === 'position' ||
          path.startsWith(`components.script.scripts.${SCRIPT_NAME}.attributes`) ||
          path.startsWith(`components.script.scripts.${MEDIA_SCRIPT_NAME}.attributes`)) {
        debounceEntitiesToJson();
      }
    };
    for (const eventName of ['*:set', '*:unset', '*:insert', '*:remove']) {
      try { state.events.push(entity.on(eventName, onChanged)); } catch {}
    }
  };
  const watchConfigEntity = (entity) => {
    const id = entity?.get?.('resource_id');
    if (!entity || !id || state.watchedConfigIds.has(id)) return;
    state.watchedConfigIds.add(id);
    const onChanged = (path, value) => {
      const prefix = `components.script.scripts.${CONFIG_SCRIPT_NAME}.attributes.`;
      if (!path?.startsWith?.(prefix)) return;
      const nextValue = value === undefined ? entity.get(path) : value;
      if (nextValue !== true) return;
      const field = path.slice(prefix.length);
      if (field === 'refreshAnnotationsFromJson' || field === 'importAnnotationsFromJson' || field === 'syncFromJson') {
        syncJsonToEntities().catch((error) => setPanelStatus(error.message, true)).finally(() => resetConfigTrigger(entity, field));
      } else if (field === 'exportAnnotationsToJson' || field === 'syncToJson') {
        syncEntitiesToJson().catch((error) => setPanelStatus(error.message, true)).finally(() => resetConfigTrigger(entity, field));
      } else if (field === 'syncBoth') {
        const opts = getSyncOptions();
        const first = opts.conflictStrategy === 'prefer-child-entities' ? syncEntitiesToJson : syncJsonToEntities;
        const second = opts.conflictStrategy === 'prefer-child-entities' ? syncJsonToEntities : syncEntitiesToJson;
        first().then(() => second()).catch((error) => setPanelStatus(error.message, true)).finally(() => resetConfigTrigger(entity, field));
      } else if (field === 'validateSync') {
        Promise.all([readAnnotationsJson(), Promise.resolve(getChildPoints())])
          .then(([document, childPoints]) => {
            const report = `[AnnotationSync] Validate: JSON annotations ${document.annotations.length}; introAnnotation ${document.introAnnotation ? 'yes' : 'no'}; Tour_Annotations children ${childPoints.length}.`;
            updateConfigStatus('Validation complete', report);
            setPanelStatus('Validated');
          })
          .catch((error) => setPanelStatus(error.message, true))
          .finally(() => resetConfigTrigger(entity, field));
      }
    };
    try { state.events.push(entity.on('*:set', onChanged)); } catch {}
  };
  const watchAllEntities = () => {
    const points = getChildPoints();
    points.forEach((point) => {
      watchEntity(point);
      getMediaChildren(point).forEach(watchEntity);
    });
    getConfigEntities().forEach(watchConfigEntity);
  };

  let statusDom = null;
  const setPanelStatus = (message, error = false) => {
    if (!statusDom) return;
    statusDom.textContent = message;
    statusDom.style.color = error ? '#ffb4a6' : '#c8f7d0';
  };
  const createPanel = () => {
    if (document.getElementById('tourAnnotationSyncPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'tourAnnotationSyncPanel';
    panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;background:#1d2a2f;color:#fff;border:1px solid rgba(255,255,255,.18);box-shadow:0 10px 28px rgba(0,0,0,.35);border-radius:6px;padding:8px;font:12px/1.3 Arial,sans-serif;display:flex;gap:6px;align-items:center;';
    const label = document.createElement('strong');
    label.textContent = 'Annotations';
    label.style.marginRight = '4px';
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = 'Refresh';
    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.textContent = 'Export';
    for (const button of [refresh, exportButton]) {
      button.style.cssText = 'border:1px solid rgba(255,255,255,.2);background:#314148;color:#fff;border-radius:4px;padding:4px 8px;font-weight:700;cursor:pointer;';
    }
    statusDom = document.createElement('span');
    statusDom.textContent = 'Ready';
    statusDom.style.minWidth = '54px';
    refresh.addEventListener('click', () => syncJsonToEntities().catch((error) => setPanelStatus(error.message, true)));
    exportButton.addEventListener('click', () => syncEntitiesToJson().catch((error) => setPanelStatus(error.message, true)));
    panel.append(label, refresh, exportButton, statusDom);
    document.body.appendChild(panel);
  };

  watchAllEntities();
  state.watchTimer = window.setInterval(watchAllEntities, 2000);
  const addEvent = editor.on('entities:add', (entity) => {
    const parent = getParent();
    if (!parent) return;
    const parentId = parent.get('resource_id');
    const parentEntity = editor.call('entities:get', entity.get('parent'));
    const parentIsAnnotation = parentEntity?.has?.(`components.script.scripts.${SCRIPT_NAME}.attributes`);
    if (entity.get('parent') === parentId ||
        parentIsAnnotation ||
        entity.has(`components.script.scripts.${SCRIPT_NAME}.attributes`) ||
        entity.has(`components.script.scripts.${MEDIA_SCRIPT_NAME}.attributes`)) {
      window.setTimeout(() => {
        watchEntity(entity);
        debounceEntitiesToJson();
      }, 0);
    }
  });
  state.events.push(addEvent);
  const asset = getAnnotationAsset();
  if (asset) {
    state.events.push(asset.on('file:set', debounceJsonToEntities));
    state.events.push(asset.on('file.hash:set', debounceJsonToEntities));
    state.events.push(asset.on('file.url:set', debounceJsonToEntities));
  }
  createPanel();

  window.tourAnnotationSync = {
    syncJsonToEntities,
    syncEntitiesToJson,
    refresh: syncJsonToEntities,
    exportToJson: syncEntitiesToJson,
    status() {
      return {
        installed: !state.destroyed,
        lastSync: state.lastSync,
        lastResult: state.lastResult,
        watchedPoints: getChildPoints().length,
        annotationAssetId: getAnnotationAsset()?.get('id') || null,
        annotationParentId: getParent()?.get('resource_id') || null
      };
    },
    destroy() {
      state.destroyed = true;
      window.clearTimeout(state.entityTimer);
      window.clearTimeout(state.assetTimer);
      window.clearInterval(state.watchTimer);
      for (const event of state.events) {
        try { event?.unbind?.(); } catch {}
      }
      state.events.length = 0;
      document.getElementById('tourAnnotationSyncPanel')?.remove();
    }
  };
  setPanelStatus(`Watching ${getChildPoints().length}`);
  console.log('[Tour Annotation Sync Extension] installed:', window.tourAnnotationSync.status());
})();
