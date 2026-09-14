'use strict';
const path = require('path');
const {
  atomicWriteJson, readJsonFileOrNull, CorruptJsonError,
} = require('./build-manifest');

const ROOT = path.resolve(__dirname, '..');

function findCatalogEntry(catalog, episode, shotId, takeId) {
  return catalog.find(e =>
    e.episode === episode && e.shot_id === shotId && e.take_id === takeId
  );
}

/**
 * 保证同一 (shot, stage) 在 catalog 中至多一条 selected,并与 manifest 的
 * selected_take / selected_keyframe 对齐。
 */
function syncCatalogSelection(catalog, episode, shotId, selectedTakeId, stage = 'video') {
  for (const e of catalog) {
    if (e.episode !== episode || e.shot_id !== shotId) continue;
    if ((e.stage || 'video') !== stage) continue;
    if (selectedTakeId && e.take_id === selectedTakeId) {
      if (e.status !== 'rejected') e.status = 'selected';
    } else if (e.status === 'selected') {
      e.status = 'candidate';
    }
  }
}

function appendCatalog(absEpDir, shotId, opts, manifest, createdTakeId, catalogPath) {
  catalogPath = catalogPath || path.join(ROOT, 'catalog.json');
  const catRead = readJsonFileOrNull(catalogPath, { label: 'catalog.json' });
  if (catRead.corrupt) {
    throw new CorruptJsonError(catRead.guidance);
  }
  let catalog = catRead.value || [];

  const stage = opts.stage === 'keyframe' ? 'keyframe' : 'video';
  const takeField = stage === 'keyframe' ? 'keyframe_takes' : 'takes';
  const selectedField = stage === 'keyframe' ? 'selected_keyframe' : 'selected_take';

  const episode = manifest.episode;
  const shot = (manifest.shots || []).find(s => s.id === shotId);
  const shotTakes = shot ? (shot[takeField] || []) : [];
  const manifestSelected = shot ? shot[selectedField] : null;

  if ((opts.action === 'take' || opts.action === 'done') && createdTakeId) {
    const manifestTake = shotTakes.find(t => t.id === createdTakeId);
    const desiredStatus = manifestTake ? manifestTake.status : (opts.action === 'done' ? 'selected' : 'candidate');
    const existing = findCatalogEntry(catalog, episode, shotId, createdTakeId);
    if (existing) {
      if (existing.path && opts.path && existing.path !== opts.path) {
        throw new Error(`catalog conflict for ${episode}/${shotId}/${createdTakeId}: existing path '${existing.path}', new path '${opts.path}' — refusing to overwrite. Recovery: inspect ${catalogPath} and resolve the duplicate (keep the intended path or remove the stale entry), then re-run.`);
      }
      existing.model = opts.model || existing.model;
      existing.status = desiredStatus;
      existing.rendered_at = new Date().toISOString();
      existing.error = null;
    } else {
      catalog.push({
        episode, shot_id: shotId, take_id: createdTakeId, stage,
        model: opts.model || 'unknown', path: opts.path,
        status: desiredStatus,
        rendered_at: new Date().toISOString(), error: null
      });
    }
    syncCatalogSelection(catalog, episode, shotId, manifestSelected, stage);
  } else if (opts.action === 'select' && opts.takeId) {
    const entry = findCatalogEntry(catalog, episode, shotId, opts.takeId);
    if (entry && entry.status !== 'rejected') entry.status = 'selected';
    syncCatalogSelection(catalog, episode, shotId, manifestSelected || opts.takeId, stage);
  } else if (opts.action === 'reject' && opts.takeId) {
    const entry = findCatalogEntry(catalog, episode, shotId, opts.takeId);
    if (entry) entry.status = 'rejected';
    syncCatalogSelection(catalog, episode, shotId, manifestSelected, stage);
  } else if (opts.action === 'review' && opts.takeId) {
    const take = shotTakes.find(t => t.id === opts.takeId);
    const entry = findCatalogEntry(catalog, episode, shotId, opts.takeId);
    if (entry) {
      if (take) entry.human_review = take.human_review;
      if (opts.conclusion === 'reject') entry.status = 'rejected';
    }
    syncCatalogSelection(catalog, episode, shotId, manifestSelected, stage);
  } else if (opts.action === 'failed') {
    catalog.push({
      episode, shot_id: shotId, take_id: null, stage,
      model: null, path: null, status: 'failed',
      rendered_at: new Date().toISOString(), error: opts.error
    });
  }

  atomicWriteJson(catalogPath, catalog);
}

module.exports = {
  findCatalogEntry, syncCatalogSelection, appendCatalog,
};
