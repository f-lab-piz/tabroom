const previews = new Map();

export const defaultPreviewSettings = {format:'png', width:320, limit:'total', fps:30};

export function normalizePreviewSettings(value) {
  const fps = Number(value?.fps);
  const width = Number(value?.width);
  return {
    format: value?.format === 'jpeg' ? 'jpeg' : 'png',
    width: [240, 320, 480].includes(width) ? width : defaultPreviewSettings.width,
    limit: ['tab','total','none','auto','active'].includes(value?.limit) ? value.limit : defaultPreviewSettings.limit,
    fps: Number.isInteger(fps) && fps >= 1 && fps <= 240 ? fps : defaultPreviewSettings.fps,
  };
}

export function groupPreviewTabs(tabs, groupId) {
  if (!Number.isInteger(groupId) || groupId < 0) return [];
  return tabs.filter(tab => tab.groupId === groupId);
}

export function ungroupedTabs(tabs, windowId) {
  return tabs.filter(tab => tab.windowId === windowId && tab.groupId === -1);
}

export function previewTabs(tabs, groupId, pickerIds) {
  if (!Array.isArray(pickerIds)) return groupPreviewTabs(tabs, groupId);
  const candidates = new Set(pickerIds);
  return tabs.filter(tab => candidates.has(tab.id));
}

export function releasePreviews(id, ticket) {
  if (id === undefined) {
    for (const key of previews.keys()) releasePreviews(key);
    return;
  }
  const entry = previews.get(id);
  if (ticket && entry?.ticket !== ticket) return;
  previews.delete(id);
  entry?.bitmap?.close();
}

export async function acceptPreviewFrame(event, isCurrent, draw, post) {
  const {id, ticket, frameId, data} = event;
  const reply = (ok, drawn = false) => {
    if (frameId !== undefined) post({type:'previewFrameResult', id, ticket, frameId, ok, drawn});
  };
  if (!isCurrent()) { reply(true); return; }

  let entry = previews.get(id);
  if (!entry) {
    entry = {ticket:null, bitmap:null, revision:0};
    previews.set(id, entry);
  }
  const revision = ++entry.revision;
  try {
    const type = event.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const bytes = Uint8Array.fromBase64?.(data) ?? Uint8Array.from(atob(data), character => character.charCodeAt(0));
    const source = new Blob([bytes], {type});
    const bitmap = await createImageBitmap(source);
    if (previews.get(id) !== entry || entry.revision !== revision || !isCurrent()) {
      bitmap.close();
      reply(true);
      return;
    }
    entry.bitmap?.close();
    entry.ticket = ticket;
    entry.bitmap = bitmap;
    reply(true, Boolean(draw()));
  } catch (error) {
    console.debug('Tabroom preview:', error.message);
    reply(false);
  }
}

export function drawPreview(card, ticket, still = false, stillTicket, keepLast = false) {
  const entry = previews.get(card.id);
  const bitmap = entry && (entry.ticket === ticket || entry.ticket === stillTicket) ? entry.bitmap : null;
  const frozen = still || Boolean(bitmap && entry.ticket !== ticket);
  if (frozen) card.drawTimes.length = 0;
  if (card.bitmap === bitmap || (!bitmap && keepLast)) return false;
  const canvas = card.canvas;
  if (!bitmap) {
    canvas.width = 1;
    canvas.height = 1;
    card.drawTimes.length = 0;
  } else {
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    canvas.getContext('2d', {alpha:false}).drawImage(bitmap, 0, 0);
    card.element.style.setProperty('--preview-ratio',`${bitmap.width} / ${bitmap.height}`);
    if (!frozen) card.drawTimes.push(performance.now());
  }
  card.bitmap = bitmap;
  card.element.classList.toggle('has-frame', Boolean(bitmap));
  return Boolean(bitmap);
}

export function samplePreviewFps(card) {
  const timestamps = card.drawTimes;
  const cutoff = performance.now() - 2000;
  while (timestamps[0] < cutoff) timestamps.shift();
  if (timestamps.length < 2) return timestamps.length / 2;
  const latest = timestamps.at(-1);
  const first = timestamps[0];
  const steady = 1000 * (timestamps.length - 1) / Math.max(1, latest - first);
  return Math.min(steady, timestamps.length * 0.5);
}
