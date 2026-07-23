// --- Client-side PPTX metadata + render-data extraction ---------------------
//
// PPTX is just a ZIP of XML parts. This runs once, in the browser, right at
// upload time (see FileUpload.tsx), completely independent of the existing
// Code.gs pipeline that converts the file to a PDF for on-screen rendering.
// Three things get pulled out here, all keyed by slide position (1-based,
// matching the PDF page numbers Code.gs produces), all best-effort - if
// anything about a given slide can't be parsed, that slide just falls back
// to something reasonable (no notes / a plain cut / the existing PDF page
// image) instead of blowing up the upload or the presentation:
//
//   1. Speaker notes per slide (ppt/notesSlides/notesSlideN.xml)
//   2. The slide's <p:transition> effect + duration, for the whole-slide
//      transition when the presenter advances
//   3. Render data: each slide's shapes/text/images with percentage-based
//      layout, plus which paragraphs/shapes are set to build in one at a
//      time on click - this is what <SlideRenderer/> actually draws,
//      instead of the flattened PDF page image.
//
// SCOPE: this is a *standard, best-effort* renderer, not a pixel-perfect
// PowerPoint clone. Motion paths, Morph, SmartArt, charts, embedded video,
// and grouped shapes are not modeled - they're simply left out of a slide's
// shapes rather than mis-rendered. Every bullet build plays the same
// standard reveal (fade + small rise) regardless of the file's actual
// animation effect, and every transition type this file doesn't explicitly
// recognize falls back to a plain fade. That's a deliberate trade: real
// PowerPoint animation semantics are a huge surface area, and "close and
// consistent" beats "occasionally exact, frequently broken."

import JSZip from 'jszip';

export type TransitionKind = 'fade' | 'slide' | 'cut';
export interface SlideTransition {
  kind: TransitionKind;
  durationMs: number;
  direction?: 'l' | 'r' | 'u' | 'd'; // only meaningful for 'slide'
}

// --- Render data -------------------------------------------------------
export interface SlideRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;     // '#rrggbb'
  sizeCqw?: number;    // font size, pre-converted to "% of slide width" - apply directly as `${sizeCqw}cqw`
}
export interface SlideParagraph {
  runs: SlideRun[];
  bulletLevel: number;   // 0-based indent level
  buildOrder?: number;   // undefined = visible from the start; N = revealed on the Nth "Next"
  isContinuation?: boolean; // a manual line break (<a:br>) within the same source paragraph, not a new bullet - keeps the indent but shows no bullet mark
  bulletChar?: string; // the actual bullet character from <a:buChar>, or a generic marker for <a:buAutoNum> - undefined means the source has no bullet here (very common for titles/plain text - most paragraphs explicitly set <a:buNone/>) and none should be drawn
}
export interface SlideShape {
  id: string;
  kind: 'text' | 'image' | 'rect';
  xPct: number; yPct: number; wPct: number; hPct: number; // % of slide width/height
  z: number;
  paragraphs?: SlideParagraph[];
  imageDataUrl?: string;
  fill?: string;          // '#rrggbb', rect/text-box background
  buildOrder?: number;    // whole-shape build (images/rects, or text shapes with no per-paragraph timing found)
}
export interface SlideRenderData {
  aspectRatio: number;    // slide width / height
  background?: string;    // '#rrggbb'
  shapes: SlideShape[];
  transition: SlideTransition;
  buildCount: number;     // highest buildOrder + 1 found anywhere on the slide; 0 = nothing builds
}

export interface PptxMeta {
  notesByPage: Record<number, string>;
  transitionsByPage: Record<number, SlideTransition>;
  renderDataByPage: Record<number, SlideRenderData>;
  slideCount: number;
}

const parser = new DOMParser();
function parseXml(text: string): Document {
  return parser.parseFromString(text, 'application/xml');
}

// Every real OOXML relationship/content-type lookup we need, done with
// plain tag-name matching (not namespace-aware) - the prefixes PowerPoint
// itself writes (p:, a:, r:, mc:...) are consistent enough in practice that
// this is the same pragmatic approach most lightweight browser-side pptx
// readers use, and it keeps this file dependency-free besides JSZip.
function firstEl(doc: Document | Element, tag: string): Element | null {
  return doc.getElementsByTagName(tag)[0] || null;
}
function allEls(doc: Document | Element, tag: string): Element[] {
  return Array.from(doc.getElementsByTagName(tag));
}
function localName(tag: string): string {
  return tag.includes(':') ? tag.split(':')[1] : tag;
}

// Resolves "../slides/slide3.xml" (relative to ppt/_rels/) etc. into a
// normalized zip-entry path.
function resolveRelPath(basePath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const baseDir = basePath.split('/').slice(0, -1); // drop the file itself
  const parts = target.split('/');
  const stack = [...baseDir];
  for (const part of parts) {
    if (part === '..') stack.pop();
    else if (part === '.') continue;
    else stack.push(part);
  }
  return stack.join('/');
}

async function readXml(zip: JSZip, path: string): Promise<Document | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  const text = await entry.async('text');
  return parseXml(text);
}

function relsPathFor(partPath: string): string {
  const dir = partPath.split('/').slice(0, -1).join('/');
  const file = partPath.split('/').pop()!;
  return `${dir}/_rels/${file}.rels`;
}

async function loadRelMap(zip: JSZip, partPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const relsPath = relsPathFor(partPath);
  const relsDoc = await readXml(zip, relsPath);
  if (!relsDoc) return map;
  for (const rel of allEls(relsDoc, 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    // Resolved against partPath (the part the .rels file describes, e.g.
    // "ppt/presentation.xml"), NOT relsPath (the .rels file's own location,
    // e.g. "ppt/_rels/presentation.xml.rels") - relationship targets are
    // spec'd relative to the owning part's directory. Slide-level rels
    // targets conventionally write an explicit "../" and so happened to
    // resolve correctly either way, which is what let this go unnoticed:
    // presentation.xml.rels targets (e.g. "slides/slide1.xml") don't have
    // that "../", so resolving against relsPath's directory instead of
    // partPath's produced a path with a phantom extra "_rels" segment -
    // silently pointing at a zip entry that doesn't exist.
    if (id && target) map.set(id, resolveRelPath(partPath, target));
  }
  return map;
}

// The ordered list of slideN.xml paths, in actual presentation order (NOT
// necessarily numeric filename order - PowerPoint doesn't guarantee those
// match, especially after slides have been reordered/duplicated).
async function getOrderedSlidePaths(zip: JSZip): Promise<string[]> {
  const presDoc = await readXml(zip, 'ppt/presentation.xml');
  if (!presDoc) return [];
  const relIdToTarget = await loadRelMap(zip, 'ppt/presentation.xml');

  const sldIdLst = firstEl(presDoc, 'p:sldIdLst');
  if (!sldIdLst) return [];
  const paths: string[] = [];
  for (const sldId of allEls(sldIdLst, 'p:sldId')) {
    // r:id - attribute lookup by local name since the namespace prefix on
    // the *attribute itself* is always 'r' in practice for this element.
    const rid = sldId.getAttribute('r:id');
    if (!rid) continue;
    const target = relIdToTarget.get(rid);
    if (target) paths.push(target);
  }
  return paths;
}

// EMU (English Metric Units, the unit every OOXML offset/extent is in) ->
// points, for font sizes: 1pt = 12700 EMU.
function emuToPt(emu: number): number {
  return emu / 12700;
}

export async function getSlideSizeEmu(zip: JSZip): Promise<{ cx: number; cy: number }> {
  const presDoc = await readXml(zip, 'ppt/presentation.xml');
  const sldSz = presDoc && firstEl(presDoc, 'p:sldSz');
  const cx = Number(sldSz?.getAttribute('cx')) || 9144000; // 10in @ 914400 EMU/in - the common 4:3 default
  const cy = Number(sldSz?.getAttribute('cy')) || 6858000;
  return { cx, cy };
}

// --- Speaker notes -----------------------------------------------------
async function extractNotesForSlide(zip: JSZip, slidePath: string): Promise<string | undefined> {
  try {
    const relMap = await loadRelMap(zip, slidePath);
    const relsDoc = await readXml(zip, relsPathFor(slidePath));
    if (!relsDoc) return undefined;

    let notesPath: string | null = null;
    for (const rel of allEls(relsDoc, 'Relationship')) {
      const type = rel.getAttribute('Type') || '';
      if (type.endsWith('/notesSlide')) {
        const id = rel.getAttribute('Id');
        if (id) notesPath = relMap.get(id) || null;
        break;
      }
    }
    if (!notesPath) return undefined;

    const notesDoc = await readXml(zip, notesPath);
    if (!notesDoc) return undefined;

    // Prefer the "body" placeholder (the actual notes text box, as opposed
    // to the slide-thumbnail placeholder or slide-number/date/footer
    // placeholders that also live on a notes page).
    const shapes = allEls(notesDoc, 'p:sp');
    let bodyShape: Element | null = null;
    for (const sp of shapes) {
      const ph = firstEl(sp, 'p:ph');
      const phType = ph?.getAttribute('type');
      if (phType === 'body') { bodyShape = sp; break; }
    }
    // Fallback: whichever shape has the most actual text - in practice
    // that's always the notes body, even when its placeholder type isn't
    // explicitly "body" (some templates omit it).
    if (!bodyShape) {
      let best = { shape: null as Element | null, len: 0 };
      for (const sp of shapes) {
        const ph = firstEl(sp, 'p:ph');
        const phType = ph?.getAttribute('type');
        if (phType === 'sldImg') continue; // the embedded slide thumbnail, never text
        const text = allEls(sp, 'a:t').map((t) => t.textContent || '').join('');
        if (text.length > best.len) best = { shape: sp, len: text.length };
      }
      bodyShape = best.shape;
    }
    if (!bodyShape) return undefined;

    const paragraphs = allEls(bodyShape, 'a:p').map((p) =>
      allEls(p, 'a:t').map((t) => t.textContent || '').join('')
    );
    const text = paragraphs.join('\n').trim();
    return text || undefined;
  } catch {
    return undefined; // best-effort - one bad slide shouldn't break the rest
  }
}

// --- Transitions ---------------------------------------------------------
// Effect tag -> our simplified kind. Anything not listed here (Morph,
// SmartArt-driven effects, the newer p159:* "gallery" transitions, honeycomb,
// ripple, etc.) falls through to the 'fade' fallback below, per the graceful-
// degradation requirement - never skip or break the presentation.
const SLIDE_LIKE = new Set(['push', 'cover', 'pull', 'comb']);
const FADE_LIKE = new Set(['fade']);
const CUT_LIKE = new Set(['cut']);

function parseTransitionEl(transEl: Element): SlideTransition {
  // Duration: modern files use dur="500" (milliseconds); older ones use a
  // spd="slow|med|fast" enum instead.
  let durationMs = 500;
  const dur = transEl.getAttribute('dur');
  const spd = transEl.getAttribute('spd');
  if (dur && !isNaN(Number(dur))) durationMs = Number(dur);
  else if (spd === 'slow') durationMs = 1000;
  else if (spd === 'fast') durationMs = 250;

  // The effect is whichever child element is present - <p:fade/>, <p:push
  // dir="l"/>, <p:cut/>, <p:wipe .../>, etc. Just look at the first
  // element child's local tag name.
  const child = Array.from(transEl.children).find((c) => !c.tagName.includes(':timing'));
  const local = localName(child?.tagName || '');

  if (FADE_LIKE.has(local)) return { kind: 'fade', durationMs };
  if (CUT_LIKE.has(local)) return { kind: 'cut', durationMs: 0 };
  if (SLIDE_LIKE.has(local)) {
    const dir = (child?.getAttribute('dir') || 'l').slice(0, 1) as 'l' | 'r' | 'u' | 'd';
    const validDir = (['l', 'r', 'u', 'd'] as const).includes(dir) ? dir : 'l';
    return { kind: 'slide', durationMs, direction: validDir };
  }
  // Graceful fallback for wipe/wheel/blinds/checker/circle/diamond/random/
  // morph/gallery/anything-we-don't-specifically-model.
  return { kind: 'fade', durationMs };
}

async function extractTransitionForSlide(zip: JSZip, slidePath: string): Promise<SlideTransition | undefined> {
  try {
    const slideDoc = await readXml(zip, slidePath);
    if (!slideDoc) return undefined;
    const transEl = firstEl(slideDoc, 'p:transition');
    if (!transEl) return undefined; // no explicit transition set -> caller defaults to 'cut'
    return parseTransitionEl(transEl);
  } catch {
    return undefined;
  }
}

// --- Build (click-to-reveal) order ---------------------------------------
// Real PowerPoint animation timing is a deeply nested, general tree (par/seq/
// set/animEffect nodes, "with previous" / "after previous" timing, exit and
// emphasis effects mixed in with entrances...). Modeling all of that isn't
// this file's job. What real-world "appear on click, one bullet at a time"
// decks actually need is much narrower: find every entrance effect
// (marked by the standard presetClass="entr" attribute PowerPoint itself
// writes), in the order they appear in the file - that order IS the click
// order for the overwhelming majority of decks. Each one targets either a
// whole shape (<p:spTgt spid="X"/>) or a specific paragraph range within a
// shape's text (<p:spTgt spid="X"><p:txEl><p:pRg st="N" end="N"/>...).
//
// Returns a map: shapeId -> (paragraphIndex | 'whole-shape') -> build order.
interface BuildTarget { shapeId: string; paragraph: number | null; order: number; }
function extractBuildOrder(slideDoc: Document): BuildTarget[] {
  const timing = firstEl(slideDoc, 'p:timing');
  if (!timing) return [];

  const targets: BuildTarget[] = [];
  const seen = new Set<string>(); // dedupe (spid, paragraph) - only first occurrence (the entrance) counts
  let order = 0;

  // Every <p:cTn presetClass="entr" ...> node is one entrance effect. Walk
  // them in document order (their natural order in allEls already is).
  for (const cTn of allEls(timing, 'p:cTn')) {
    if (cTn.getAttribute('presetClass') !== 'entr') continue;
    for (const spTgt of allEls(cTn, 'p:spTgt')) {
      const shapeId = spTgt.getAttribute('spid');
      if (!shapeId) continue;
      const pRg = firstEl(spTgt, 'p:pRg');
      const paragraph = pRg && pRg.getAttribute('st') != null ? Number(pRg.getAttribute('st')) : null;
      const key = `${shapeId}:${paragraph ?? 'whole'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ shapeId, paragraph, order });
    }
    order += 1;
  }
  return targets;
}

// --- Color helpers ---------------------------------------------------------
// Only srgbClr is resolved exactly. schemeClr (theme colors) would need
// theme1.xml parsed too - out of scope for this pass, so it gets a fixed,
// reasonable approximation instead of being dropped silently.
const SCHEME_FALLBACK: Record<string, string> = {
  dk1: '#1a1a1a', tx1: '#1a1a1a', dk2: '#44546a', tx2: '#44546a',
  lt1: '#ffffff', bg1: '#ffffff', lt2: '#e7e6e6', bg2: '#e7e6e6',
  accent1: '#4472c4', accent2: '#ed7d31', accent3: '#a5a5a5',
  accent4: '#ffc000', accent5: '#5b9bd5', accent6: '#70ad47',
  hlink: '#0563c1', folHlink: '#954f72',
};
function extractColor(container: Element | null): string | undefined {
  if (!container) return undefined;
  const fill = firstEl(container, 'a:solidFill');
  if (!fill) return undefined;
  const srgb = firstEl(fill, 'a:srgbClr');
  if (srgb) {
    const val = srgb.getAttribute('val');
    return val ? `#${val}` : undefined;
  }
  const scheme = firstEl(fill, 'a:schemeClr');
  const val = scheme?.getAttribute('val');
  return val ? SCHEME_FALLBACK[val] : undefined;
}

// --- Shapes ----------------------------------------------------------------
// Common placeholder layout fallbacks, used only when a shape has a <p:ph>
// but no explicit <a:xfrm> of its own (very common for title/body text -
// they usually inherit position from the slide layout, which this file
// doesn't parse). Percentages are generous, standard title/content zones.
const PLACEHOLDER_DEFAULTS: Record<string, { xPct: number; yPct: number; wPct: number; hPct: number }> = {
  title: { xPct: 6, yPct: 6, wPct: 88, hPct: 18 },
  ctrTitle: { xPct: 10, yPct: 32, wPct: 80, hPct: 24 },
  subTitle: { xPct: 10, yPct: 58, wPct: 80, hPct: 16 },
  body: { xPct: 6, yPct: 26, wPct: 88, hPct: 66 },
};

function xfrmPct(spPr: Element | null, slideCx: number, slideCy: number): { xPct: number; yPct: number; wPct: number; hPct: number } | null {
  const xfrm = spPr && firstEl(spPr, 'a:xfrm');
  const off = xfrm && firstEl(xfrm, 'a:off');
  const ext = xfrm && firstEl(xfrm, 'a:ext');
  if (!off || !ext) return null;
  const x = Number(off.getAttribute('x')) || 0;
  const y = Number(off.getAttribute('y')) || 0;
  const cx = Number(ext.getAttribute('cx')) || 0;
  const cy = Number(ext.getAttribute('cy')) || 0;
  return { xPct: (x / slideCx) * 100, yPct: (y / slideCy) * 100, wPct: (cx / slideCx) * 100, hPct: (cy / slideCy) * 100 };
}

function extractRun(r: Element, slideWidthPt: number): SlideRun {
  const rPr = firstEl(r, 'a:rPr');
  const text = firstEl(r, 'a:t')?.textContent || '';
  const sizeAttr = rPr?.getAttribute('sz'); // centipoints, e.g. "1800" = 18pt
  const sizePt = sizeAttr ? Number(sizeAttr) / 100 : undefined;
  return {
    text,
    bold: rPr?.getAttribute('b') === '1',
    italic: rPr?.getAttribute('i') === '1',
    color: extractColor(rPr),
    sizeCqw: sizePt ? (sizePt / slideWidthPt) * 100 : undefined,
  };
}

// One <a:p> can contain multiple manual line breaks (<a:br>) mixed in with
// its <a:r> runs - a title box like "Name<br/><br/>Big Heading<br/>Subtitle"
// is genuinely ONE paragraph in the XML, authored as several visual lines.
// Reading only the <a:r> descendants (as if <a:br> didn't exist) runs every
// one of those lines together into a single row, which is what was
// producing garbled, overlapping text. This walks the paragraph's children
// in document order and starts a new line at each <a:br>, so line breaks
// the author actually placed are preserved. Build order and bullet level
// stay tied to the *original* paragraph (that's the granularity PowerPoint
// itself uses for click-to-build), so every line split out of one
// paragraph shares the same buildOrder - only the first line shows a
// bullet mark, continuation lines just keep the indent.
function extractParagraphs(txBody: Element, slideWidthPt: number, buildFor: (paragraphIndex: number) => number | undefined): SlideParagraph[] {
  const paragraphs = allEls(txBody, 'a:p');
  const result: SlideParagraph[] = [];

  paragraphs.forEach((p, idx) => {
    const pPr = firstEl(p, 'a:pPr');
    const bulletLevel = pPr?.getAttribute('lvl') ? Number(pPr.getAttribute('lvl')) : 0;
    const buildOrder = buildFor(idx);
    // Only draw a bullet when the source explicitly says to - most
    // paragraphs (titles, plain text boxes) set <a:buNone/> or specify
    // nothing at all, and inventing a bullet for those was rendering
    // marks that were never in the original slide.
    const buChar = pPr && firstEl(pPr, 'a:buChar');
    const buAutoNum = pPr && firstEl(pPr, 'a:buAutoNum');
    const bulletChar = buChar?.getAttribute('char') || (buAutoNum ? '•' : undefined);

    let currentRuns: SlideRun[] = [];
    let isFirstLine = true;
    const flushLine = () => {
      if (currentRuns.length) {
        result.push({ runs: currentRuns, bulletLevel, buildOrder, isContinuation: !isFirstLine, bulletChar });
        isFirstLine = false;
      }
      currentRuns = [];
    };

    for (const child of Array.from(p.children)) {
      const tag = localName(child.tagName);
      if (tag === 'r') {
        currentRuns.push(extractRun(child, slideWidthPt));
      } else if (tag === 'br') {
        flushLine();
      }
    }
    flushLine();
  });

  return result.filter((p) => p.runs.some((r) => r.text.trim().length > 0));
}

function guessImageMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'bmp') return 'image/bmp';
  return 'image/png';
}

async function extractShapesForSlide(
  zip: JSZip,
  slideDoc: Document,
  slidePath: string,
  slideCx: number,
  slideCy: number
): Promise<SlideShape[]> {
  const slideWidthPt = emuToPt(slideCx);
  const buildTargets = extractBuildOrder(slideDoc);
  const buildForShape = (shapeId: string): number | undefined =>
    buildTargets.find((t) => t.shapeId === shapeId && t.paragraph === null)?.order;
  const buildForParagraph = (shapeId: string, paragraphIndex: number): number | undefined =>
    buildTargets.find((t) => t.shapeId === shapeId && t.paragraph === paragraphIndex)?.order;

  const relMap = await loadRelMap(zip, slidePath);
  const spTree = firstEl(slideDoc, 'p:spTree');
  if (!spTree) return [];

  const shapes: SlideShape[] = [];
  let z = 0;

  // Only direct children of spTree - deliberately not recursing into
  // <p:grpSp> (grouped shapes). Group child coordinates live in the
  // group's own local coordinate space and need a separate transform to
  // resolve correctly; skipping groups is safer than mis-placing their
  // contents, and matches the "leave it out rather than render it wrong"
  // philosophy used throughout this file.
  for (const child of Array.from(spTree.children)) {
    const tag = localName(child.tagName);
    z += 1;

    if (tag === 'sp') {
      const spPr = firstEl(child, 'p:spPr');
      const ph = firstEl(child, 'p:ph');
      const phType = ph?.getAttribute('type') || (ph ? 'body' : undefined);
      const shapeId = firstEl(child, 'p:cNvPr')?.getAttribute('id') || `shape-${z}`;

      let rect = xfrmPct(spPr, slideCx, slideCy);
      if (!rect && phType) rect = PLACEHOLDER_DEFAULTS[phType] || PLACEHOLDER_DEFAULTS.body;
      if (!rect) continue; // no position we can determine even approximately - skip rather than guess at 0,0

      const txBody = firstEl(child, 'p:txBody');
      const paragraphs = txBody
        ? extractParagraphs(txBody, slideWidthPt, (i) => buildForParagraph(shapeId, i))
        : undefined;
      const wholeShapeBuild = buildForShape(shapeId);
      const fill = extractColor(spPr);

      if (paragraphs && paragraphs.length) {
        shapes.push({ id: shapeId, kind: 'text', ...rect, z, paragraphs, fill, buildOrder: wholeShapeBuild });
      } else if (fill) {
        // Text-less shape with an actual fill - render as a plain rect
        // (covers simple decorative boxes/lines). Shapes with neither
        // text nor a resolvable fill add nothing visible, so they're
        // skipped rather than drawn as an invisible placeholder.
        shapes.push({ id: shapeId, kind: 'rect', ...rect, z, fill, buildOrder: wholeShapeBuild });
      }
    } else if (tag === 'pic') {
      const spPr = firstEl(child, 'p:spPr');
      const rect = xfrmPct(spPr, slideCx, slideCy);
      if (!rect) continue;
      const shapeId = firstEl(child, 'p:cNvPr')?.getAttribute('id') || `shape-${z}`;
      const blip = firstEl(child, 'a:blip');
      const embedId = blip?.getAttribute('r:embed');
      const imagePath = embedId ? relMap.get(embedId) : undefined;
      if (!imagePath) continue;
      try {
        const entry = zip.file(imagePath);
        if (!entry) continue;
        const base64 = await entry.async('base64');
        const imageDataUrl = `data:${guessImageMime(imagePath)};base64,${base64}`;
        shapes.push({ id: shapeId, kind: 'image', ...rect, z, imageDataUrl, buildOrder: buildForShape(shapeId) });
      } catch {
        continue; // one bad image reference shouldn't drop the rest of the slide
      }
    }
    // graphicFrame (tables/charts/SmartArt) and grpSp (groups) are
    // deliberately not handled - see the file-level scope note up top.
  }

  return shapes;
}

async function extractBackgroundForSlide(slideDoc: Document): Promise<string | undefined> {
  const cSld = firstEl(slideDoc, 'p:cSld');
  const bg = cSld && firstEl(cSld, 'p:bg');
  const bgPr = bg && firstEl(bg, 'p:bgPr');
  return extractColor(bgPr);
}

export async function extractRenderDataForSlide(zip: JSZip, slidePath: string, slideCx: number, slideCy: number): Promise<SlideRenderData | undefined> {
  try {
    const slideDoc = await readXml(zip, slidePath);
    if (!slideDoc) return undefined;
    const shapes = await extractShapesForSlide(zip, slideDoc, slidePath, slideCx, slideCy);
    if (!shapes.length) return undefined; // nothing we could parse - caller falls back to the PDF page image

    const background = await extractBackgroundForSlide(slideDoc);
    const transEl = firstEl(slideDoc, 'p:transition');
    const transition = transEl ? parseTransitionEl(transEl) : { kind: 'cut' as const, durationMs: 0 };
    let buildCount = shapes.reduce((max, s) => {
      let shapeMax = s.buildOrder ?? -1;
      s.paragraphs?.forEach((p) => { if (p.buildOrder != null) shapeMax = Math.max(shapeMax, p.buildOrder); });
      return Math.max(max, shapeMax + 1);
    }, 0);

    // Safety net: a slide should never open completely blank. Some
    // transition types (Morph in particular) generate their own per-shape
    // timing metadata that isn't really a "click to reveal this bullet"
    // animation, and the entrance-effect heuristic above can't always tell
    // the difference. If every single shape/paragraph ended up gated
    // behind a build - nothing visible the moment the slide is landed on -
    // that's the tell. Rather than risk a blank slide, drop all build
    // gating for this slide and show its real content immediately; the
    // layout/text/images are still exactly what was parsed, just without
    // the click-to-reveal behavior.
    const visibleAtStart = shapes.some((s) => {
      if (s.buildOrder != null && s.buildOrder > 0) return false;
      if (!s.paragraphs) return s.buildOrder == null || s.buildOrder === 0;
      return s.paragraphs.some((p) => p.buildOrder == null || p.buildOrder === 0);
    });
    if (!visibleAtStart && buildCount > 0) {
      for (const s of shapes) {
        s.buildOrder = undefined;
        s.paragraphs?.forEach((p) => { p.buildOrder = undefined; });
      }
      buildCount = 0;
    }

    return { aspectRatio: slideCx / slideCy, background, shapes, transition, buildCount };
  } catch {
    return undefined;
  }
}

// --- Entry point -----------------------------------------------------------
// Runs the whole extraction pass once per upload. Never throws - always
// resolves to *something* usable (possibly empty maps), so a parsing
// hiccup never blocks the actual upload/conversion flow in FileUpload.tsx.
export async function extractPptxMeta(file: File): Promise<PptxMeta> {
  const empty: PptxMeta = { notesByPage: {}, transitionsByPage: {}, renderDataByPage: {}, slideCount: 0 };
  try {
    const zip = await JSZip.loadAsync(file);
    const slidePaths = await getOrderedSlidePaths(zip);
    if (!slidePaths.length) return empty;

    const notesByPage: Record<number, string> = {};
    const transitionsByPage: Record<number, SlideTransition> = {};
    const renderDataByPage: Record<number, SlideRenderData> = {};

    for (let i = 0; i < slidePaths.length; i++) {
      const page = i + 1;
      // Shape/build extraction (extractRenderDataForSlide) is deliberately
      // not called here anymore - the web app went back to plain PDF page
      // display, so that parsing was pure overhead on every upload with
      // nothing left to use its output. The function itself is still in
      // this file, dormant, in case animated rendering is ever revisited.
      const [notes, transition] = await Promise.all([
        extractNotesForSlide(zip, slidePaths[i]),
        extractTransitionForSlide(zip, slidePaths[i]),
      ]);
      if (notes) notesByPage[page] = notes;
      if (transition) transitionsByPage[page] = transition;
    }

    return { notesByPage, transitionsByPage, renderDataByPage, slideCount: slidePaths.length };
  } catch (err) {
    console.warn('⚠️ PPTX metadata extraction skipped:', err);
    return empty;
  }
}
