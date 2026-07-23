import type { CSSProperties } from 'react';
import type { SlideRenderData, SlideShape, SlideParagraph } from './pptxParse';

// Draws one parsed PPTX slide from its SlideRenderData - shapes positioned
// by percentage within an explicitly pixel-sized box.
//
// Sizing is deliberately NOT done via CSS aspect-ratio + auto width/height
// cascading through the surrounding flex layout - that's fragile (it
// depends on every ancestor correctly establishing a definite size, which
// isn't guaranteed once this sits inside react-pdf's <Document> wrapper)
// and was the cause of a real bug: the renderer was mounting with real
// data but collapsing to an invisible size. react-pdf's own <Page> avoids
// this entirely by taking an explicit pixel height and computing
// everything from that number in JS - this component does the same, and
// Present.tsx passes it the exact same height it already passes to <Page>.
//
// `buildIndex` controls which bullets/shapes are revealed: anything with a
// buildOrder greater than the current buildIndex renders invisible (but
// still takes its layout space, so later builds don't cause a reflow jump).
//
// This is a "standard" renderer, not a PowerPoint clone - see the scope
// note at the top of pptxParse.ts for exactly what is and isn't modeled.

function shapeVisible(shape: SlideShape, buildIndex: number): boolean {
  return shape.buildOrder == null || shape.buildOrder <= buildIndex;
}
function paragraphVisible(p: SlideParagraph, buildIndex: number): boolean {
  return p.buildOrder == null || p.buildOrder <= buildIndex;
}

const BULLET_CHARS = ['•', '◦', '▪'];

function ParagraphView({ p, visible, widthPx }: { p: SlideParagraph; visible: boolean; widthPx: number }) {
  const bullet = p.hasBullet ? BULLET_CHARS[Math.min(p.bulletLevel, 2)] : '';
  return (
    <div
      style={{
        paddingLeft: `${p.bulletLevel * 4}%`,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(6px)',
        transition: 'opacity 400ms ease, transform 400ms ease',
        display: 'flex',
        gap: '0.4em',
        lineHeight: 1.3,
      }}
    >
      {bullet && <span style={{ flexShrink: 0, opacity: 0.75 }}>{bullet}</span>}
      <span>
        {p.runs.map((r, i) => (
          <span
            key={i}
            style={{
              fontWeight: r.bold ? 700 : 400,
              fontStyle: r.italic ? 'italic' : 'normal',
              color: r.color || 'inherit',
              // sizeCqw is "% of slide width" (see pptxParse.ts) - converted
              // to an explicit pixel value here rather than a CSS container
              // query unit, for the same reason the outer box uses explicit
              // pixels: one less thing that depends on the browser resolving
              // a CSS feature correctly through an uncertain ancestor chain.
              fontSize: r.sizeCqw ? `${(r.sizeCqw / 100) * widthPx}px` : undefined,
            }}
          >
            {r.text}
          </span>
        ))}
      </span>
    </div>
  );
}

function ShapeView({ shape, buildIndex, widthPx }: { shape: SlideShape; buildIndex: number; widthPx: number }) {
  const visible = shapeVisible(shape, buildIndex);
  const boxStyle: CSSProperties = {
    position: 'absolute',
    left: `${shape.xPct}%`,
    top: `${shape.yPct}%`,
    width: `${shape.wPct}%`,
    height: `${shape.hPct}%`,
    zIndex: shape.z,
    opacity: visible ? 1 : 0,
    transform: visible ? 'translateY(0)' : 'translateY(6px)',
    transition: 'opacity 400ms ease, transform 400ms ease',
  };

  if (shape.kind === 'image') {
    return (
      <div style={boxStyle}>
        <img src={shape.imageDataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      </div>
    );
  }

  if (shape.kind === 'rect') {
    return <div style={{ ...boxStyle, backgroundColor: shape.fill || 'transparent' }} />;
  }

  // text
  return (
    <div style={{ ...boxStyle, backgroundColor: shape.fill || 'transparent', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '1%' }}>
      {shape.paragraphs?.map((p, i) => (
        <ParagraphView key={i} p={p} visible={visible && paragraphVisible(p, buildIndex)} widthPx={widthPx} />
      ))}
    </div>
  );
}

export default function SlideRenderer({ data, buildIndex, heightPx }: { data: SlideRenderData; buildIndex: number; heightPx: number }) {
  const safeHeight = heightPx > 0 ? heightPx : 600; // guards against a 0/NaN measurement on first paint
  const widthPx = safeHeight * data.aspectRatio;
  return (
    <div
      style={{
        position: 'relative',
        width: `${widthPx}px`,
        height: `${safeHeight}px`,
        backgroundColor: data.background || '#ffffff',
        color: '#1a1a1a',
        overflow: 'hidden',
      }}
    >
      {[...data.shapes].sort((a, b) => a.z - b.z).map((shape) => (
        <ShapeView key={shape.id} shape={shape} buildIndex={buildIndex} widthPx={widthPx} />
      ))}
    </div>
  );
}
