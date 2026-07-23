// Video links and lessons used to live in Google Apps Script's
// PropertiesService (see the VLINK_PREFIX / LESSON_PREFIX comments in
// Code.gs) - global, ever-growing key/value storage shared by every user of
// the script, with no real query ability and real per-project size limits.
// Everything else this app treats as "session-ish" data (sessions,
// pptx_meta) already lives in Supabase instead, so this moves video links
// and lessons there too, for the same reasons: no artificial growth limit,
// a real database instead of a flat property bag, and one consistent place
// instead of two. Google Apps Script itself is only still needed for
// actual Drive/Slides operations (uploading, converting PPTX to PDF,
// reading an existing Google Slides deck's slide count/notes) - nothing
// here touches Drive, so none of it needs to go through GAS at all anymore.
//
// The vlink_ / lesson_ / gslides_ prefixes are kept on the generated IDs
// purely for readability while debugging (e.g. in the Network tab or
// Supabase table view) - nothing parses them to decide routing anymore the
// way Code.gs used to; resolveVirtualFileId below just checks for the
// prefix directly.

import { supabase } from './supabaseClient';

const GAS_URL = 'https://script.google.com/macros/s/AKfycbyg305xVtU66xkx9wpiQekiYukNpTrdQVns-u7QZMXe_bmYNBXYX7s--X9HE_tPEiSn/exec';

export const VLINK_PREFIX = 'vlink_';
export const LESSON_PREFIX = 'lesson_';
export const GSLIDES_PREFIX = 'gslides_';

function generateId(prefix: string): string {
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Mirrors Code.gs's parseVideoLink() function - kept in sync by hand since
// they're two different languages. If you ever add a new supported
// platform, add it in both places.
export function parseVideoLink(url: string): { platform: string; embedUrl: string } | null {
  let m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{6,})/);
  if (m) return { platform: 'youtube', embedUrl: 'https://www.youtube.com/embed/' + m[1] };

  m = url.match(/vimeo\.com\/(?:.*\/)?(\d+)/);
  if (m) return { platform: 'vimeo', embedUrl: 'https://player.vimeo.com/video/' + m[1] };

  m = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([-\w]{25,})/);
  if (m) return { platform: 'google-drive', embedUrl: 'https://drive.google.com/file/d/' + m[1] + '/preview' };

  return null;
}

export async function createVideoLink(originalUrl: string): Promise<{ fileId: string; platform: string; embedUrl: string } | null> {
  const parsed = parseVideoLink(originalUrl);
  if (!parsed) return null;
  const fileId = generateId(VLINK_PREFIX);
  const { error } = await supabase.from('video_links').insert({
    id: fileId, platform: parsed.platform, embed_url: parsed.embedUrl, original_url: originalUrl,
  });
  if (error) throw new Error(error.message);
  return { fileId, platform: parsed.platform, embedUrl: parsed.embedUrl };
}

export async function createLesson(slides: { fileId: string; fileType: string; name: string }[]): Promise<string> {
  const fileId = generateId(LESSON_PREFIX);
  const { error } = await supabase.from('lessons').insert({ id: fileId, slides });
  if (error) throw new Error(error.message);
  return fileId;
}

// Registers an existing Google Slides deck WITHOUT converting anything to
// PDF and WITHOUT creating any new file in Drive - shown natively via
// Google's own embed viewer instead (see the render branch in Present.tsx),
// so transitions/animations/formatting are exactly as authored, not an
// approximation. GAS is used here purely to READ metadata (slide count +
// speaker notes) via the SlidesApp service - it never writes anything to
// Drive for this action.
export async function createGoogleSlidesImport(url: string): Promise<{ fileId: string; slideCount: number } | { error: string }> {
  const params = new URLSearchParams();
  params.append('action', 'getSlidesInfo');
  params.append('url', url);
  let json: any;
  try {
    const response = await fetch(GAS_URL, { method: 'POST', body: params });
    json = JSON.parse(await response.text());
  } catch {
    return { error: 'Google sent an invalid response' };
  }
  if (json.status !== 'success') return { error: json.message || 'Could not import that presentation' };

  const fileId = GSLIDES_PREFIX + json.presentationId;
  const { error } = await supabase.from('google_slides_decks').upsert({
    presentation_id: json.presentationId,
    slide_count: json.slideCount,
    notes_by_page: json.notesByPage || {},
  });
  if (error) return { error: error.message };
  return { fileId, slideCount: json.slideCount };
}

// Drop-in check to run BEFORE falling back to GAS's getPdf action. Returns
// null if fileId isn't a vlink_/lesson_/gslides_ id at all - callers
// should fall through to the normal GAS fetch in that case. Returns a
// GAS-getPdf-shaped response object otherwise (same {status, fileType,
// ...} shape callers already handle), so this is a drop-in replacement,
// not a new code path callers need to branch on.
export async function resolveVirtualFileId(fileId: string): Promise<any | null> {
  if (fileId.startsWith(VLINK_PREFIX)) {
    const { data, error } = await supabase.from('video_links').select('platform, embed_url').eq('id', fileId).maybeSingle();
    if (error || !data) return { status: 'error', message: 'Video link not found (it may have expired).' };
    return { status: 'success', fileType: 'video-link', platform: data.platform, embedUrl: data.embed_url };
  }
  if (fileId.startsWith(LESSON_PREFIX)) {
    const { data, error } = await supabase.from('lessons').select('slides').eq('id', fileId).maybeSingle();
    if (error || !data) return { status: 'error', message: 'Lesson not found (it may have expired).' };
    return { status: 'success', fileType: 'lesson', slides: data.slides };
  }
  if (fileId.startsWith(GSLIDES_PREFIX)) {
    const presentationId = fileId.slice(GSLIDES_PREFIX.length);
    const { data, error } = await supabase.from('google_slides_decks').select('slide_count, notes_by_page').eq('presentation_id', presentationId).maybeSingle();
    if (error || !data) return { status: 'error', message: 'This Google Slides import was not found (it may have expired).' };
    return { status: 'success', fileType: 'google-slides', presentationId, slideCount: data.slide_count, notesByPage: data.notes_by_page || {} };
  }
  return null;
}
