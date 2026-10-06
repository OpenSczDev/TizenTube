import { configRead } from '../config.js';

const HISTORY_KEY = 'tt-watched-history';
const HISTORY_LIMIT = 500;
// A video counts as watched locally once this fraction of it has played.
const LOCAL_WATCHED_FRACTION = 0.8;

function readHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function rememberVideo(videoId) {
  if (!videoId) return;
  const history = readHistory();
  if (history.includes(videoId)) return;
  history.push(videoId);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_LIMIT)));
  } catch (_) { /* storage unavailable */ }
}

function tileVideoId(item) {
  return item?.tileRenderer?.contentId
    || item?.lockupViewModel?.contentId
    || item?.tileRenderer?.onSelectCommand?.watchEndpoint?.videoId;
}

function tileWatchEndpoint(item) {
  return item?.tileRenderer?.onSelectCommand?.watchEndpoint
    || item?.lockupViewModel?.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint;
}

// Same fields hideVideo() in adblock.js reads for the progress bar.
function tilePercentWatched(item) {
  const bar = item?.tileRenderer
    ? item.tileRenderer.header?.tileHeaderRenderer?.thumbnailOverlays
      ?.find((o) => o.thumbnailOverlayResumePlaybackRenderer)?.thumbnailOverlayResumePlaybackRenderer
    : item?.lockupViewModel?.contentImage?.thumbnailViewModel?.overlays
      ?.find((o) => o.thumbnailBottomOverlayViewModel?.progressBar)
      ?.thumbnailBottomOverlayViewModel?.progressBar?.thumbnailOverlayProgressBarViewModel;
  return bar?.percentDurationWatched || bar?.startPercent || 0;
}

function collectTiles(sectionListContents) {
  const tiles = [];
  for (const section of sectionListContents || []) {
    const items = section?.shelfRenderer?.content?.horizontalListRenderer?.items
      || section?.itemSectionRenderer?.contents;
    for (const item of items || []) {
      if (tileWatchEndpoint(item) && tileVideoId(item)) tiles.push(item);
    }
  }
  return tiles;
}

// Every shape the autoplay endpoint is known to take (see SmartTube's MediaServiceCore).
function autoplayEndpointHolders(set) {
  const holders = [];
  for (const key of ['autoplayVideoRenderer', 'nextVideoRenderer']) {
    const renderer = set?.[key];
    if (!renderer) continue;
    for (const holder of [
      renderer.maybeHistoryEndpointRenderer,
      renderer.autoplayEndpointRenderer,
      renderer.autoplayVideoWrapperRenderer?.primaryEndpointRenderer?.autoplayEndpointRenderer
    ]) {
      if (holder?.endpoint?.watchEndpoint) holders.push(holder);
    }
  }
  return holders;
}

/**
 * Replaces the autoplay target with the first related video that has not been watched.
 * Leaves the response untouched when the current target is fine or no candidate exists.
 * `history` is the set of locally remembered video ids.
 */
export function skipWatchedAutoplayInResponse(r, threshold, history = new Set()) {
  const watchNext = r?.contents?.singleColumnWatchNextResults;
  const set = watchNext?.autoplay?.autoplay?.sets?.[0];
  if (!set) return false;

  const holders = autoplayEndpointHolders(set);
  if (!holders.length) return false;

  const tiles = collectTiles(watchNext.pivot?.sectionListRenderer?.contents);
  const byId = new Map(tiles.map((t) => [tileVideoId(t), t]));
  const isWatched = (videoId) => {
    if (history.has(videoId)) return true;
    const tile = byId.get(videoId);
    return !!tile && tilePercentWatched(tile) > threshold;
  };

  const currentId = holders[0].endpoint.watchEndpoint.videoId;
  if (!isWatched(currentId)) return false;

  const candidate = tiles.find((t) => !isWatched(tileVideoId(t)));
  if (!candidate) return false;

  const endpoint = JSON.parse(JSON.stringify(tileWatchEndpoint(candidate)));
  const title = candidate.tileRenderer?.metadata?.tileMetadataRenderer?.title;
  for (const holder of holders) {
    holder.endpoint.watchEndpoint = endpoint;
    const preview = holder.item?.previewButtonRenderer;
    if (preview && title) preview.title = title;
  }
  return true;
}

export function skipWatchedAutoplay(r) {
  if (!configRead('enableSkipWatchedAutoplay')) return;
  skipWatchedAutoplayInResponse(r, configRead('skipWatchedAutoplayThreshold'), new Set(readHistory()));
}

function trackPlayedVideos() {
  let lastRecorded = null;
  // Media events do not bubble, so listen in the capture phase.
  document.addEventListener('timeupdate', (ev) => {
    const video = ev.target;
    if (!video?.duration || video.currentTime / video.duration < LOCAL_WATCHED_FRACTION) return;
    const player = document.querySelector('.html5-video-player');
    const videoId = player?.getVideoData?.()?.video_id;
    if (!videoId || videoId === lastRecorded) return;
    lastRecorded = videoId;
    rememberVideo(videoId);
  }, true);
}

if (typeof document !== 'undefined') trackPlayedVideos();
