import { useLayoutEffect, useRef, useState } from 'react';

/** Never shrink a value below this fraction of its natural size. */
const MIN_SCALE = 0.5;

let measureContext: CanvasRenderingContext2D | null | undefined;

function canvasContext(): CanvasRenderingContext2D | null {
  if (measureContext === undefined) {
    measureContext = document.createElement('canvas').getContext('2d');
  }
  return measureContext;
}

function fontShorthand(style: CSSStyleDeclaration): string {
  const weight = style.fontWeight;
  const normalized =
    weight === 'bold' || weight === 'normal' ? weight : Number(weight) >= 600 ? 'bold' : 'normal';
  return `${style.fontStyle} ${normalized} ${style.fontSize} ${style.fontFamily}`;
}

type FittedTextProps = {
  text: string;
  minScale?: number;
};

/**
 * Keeps a long single-line value (a very large balance, say) inside its
 * container by measuring the rendered text and shrinking the font size,
 * instead of letting it overflow the card or get clipped.
 */
export default function FittedText({ text, minScale = MIN_SCALE }: FittedTextProps) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = spanRef.current;
    const parent = element?.parentElement;
    if (!element || !parent) {
      return;
    }

    const fit = () => {
      const parentStyle = window.getComputedStyle(parent);
      const base = Number.parseFloat(parentStyle.fontSize);
      const context = canvasContext();
      // A couple of pixels of slack keeps the value from touching the edge once
      // tabular figures render slightly wider than the measured proportional ones.
      const available = parent.clientWidth - 2;
      if (!context || !Number.isFinite(base) || base <= 0 || available <= 0) {
        setFontSize(null);
        return;
      }
      context.font = fontShorthand(parentStyle);
      const needed = context.measureText(text).width;
      if (!Number.isFinite(needed) || needed <= 0) {
        setFontSize(null);
        return;
      }
      const scale = Math.max(minScale, Math.min(1, available / needed));
      const next = Math.round(base * scale * 100) / 100;
      setFontSize((current) =>
        current !== null && Math.abs(current - next) < 0.01 ? current : next,
      );
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(parent);
    window.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [text, minScale]);

  return (
    <span
      ref={spanRef}
      className="fitted-text"
      style={fontSize === null ? undefined : { fontSize: `${fontSize}px` }}
    >
      {text}
    </span>
  );
}
