import type { CSSProperties } from 'react';
import type { SlideRenderData, SlideShape, SlideParagraph } from './pptxParse';

// Draws one parsed PPTX slide from its SlideRenderData - shapes positioned
// by percentage, text sized in container-query width units (cqw) so it
// scales correctly at any screen size without a resize observer, same
// approach used elsewhere in this app. `buildIndex` controls which
// bullets/shapes are revealed: anything with a buildOrder greater than the
// current buildIndex renders invisible (but still takes its layout space,
// so later builds don't cause a reflow jump).
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

function ParagraphView({ p, visible }: { p: SlideParagraph; visible: boolean }) {
  const bullet = p.bulletLevel > 0 || p.runs.length ? BULLET_CHARS[Math.min(p.bulletLevel, 2)] : '';
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
              fontSize: r.sizeCqw ? `${r.sizeCqw}cqw` : undefined,
            }}
          >
            {r.text}
          </span>
        ))}
      </span>
    </div>
  );
}

function ShapeView({ shape, buildIndex }: { shape: SlideShape; buildIndex: number }) {
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
        <ParagraphView key={i} p={p} visible={visible && paragraphVisible(p, buildIndex)} />
      ))}
    </div>
  );
}

export default function SlideRenderer({ data, buildIndex }: { data: SlideRenderData; buildIndex: number }) {
  return (
    <div
      style={{
        position: 'relative',
        width: 'auto',
        height: 'auto',
        maxWidth: '100%',
        maxHeight: '100%',
        aspectRatio: `${data.aspectRatio}`,
        margin: '0 auto',
        backgroundColor: data.background || '#ffffff',
        color: '#1a1a1a',
        overflow: 'hidden',
        containerType: 'inline-size',
      } as CSSProperties}
    >
      {[...data.shapes].sort((a, b) => a.z - b.z).map((shape) => (
        <ShapeView key={shape.id} shape={shape} buildIndex={buildIndex} />
      ))}
    </div>
  );
}
