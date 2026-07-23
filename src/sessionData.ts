// Video links and lessons used to live in Google Apps Script's
// PropertiesService (see the VLINK_PREFIX / LESSON_PREFIX comments in
// Code.gs) - global, ever-growing key/value storage shared by every user of
// the script, with no real query ability and real per-project size limits.
// Everything else this app treats as "session-ish" data (sessions,
// pptx_meta) already lives in Supabase instead, so this moves video links
// and lessons there too, for the same reasons: no artificial growth limit,
// a real database instead of a flat property bag, and one consistent place
// instead of two. Google Apps Script itself is only still needed for
// actual Drive/Slides operations (uploading, converting PPTX/Slides to
// PDF) - nothing here touches Drive, so none of it needs to go through GAS
// at all anymore.
//
// The vlink_ / lesson_ prefixes are kept on the generated IDs purely for
// readability while debugging (e.g. in the Network tab or Supabase table
// view) - nothing parses them to decide routing anymore the way Code.gs
// used to; resolveVirtualFileId below just checks for the prefix directly.

import { supabase } from './supabaseClient';

export const VLINK_PREFIX = 'vlink_';
export const LESSON_PREFIX = 'lesson_';

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

// Drop-in check to run BEFORE falling back to GAS's getPdf action. Returns
// null if fileId isn't a vlink_/lesson_ id at all - callers should fall
// through to the normal GAS fetch in that case. Returns a GAS-getPdf-shaped
// response object otherwise (same {status, fileType, ...} shape callers
// already handle), so this is a drop-in replacement, not a new code path
// callers need to branch on.
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
  return null;
}
