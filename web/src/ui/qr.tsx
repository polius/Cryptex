/** QR code for a link, drawn as crisp SVG modules (dialog A7). Rendered locally; the link never leaves the page. */
import { encode } from 'uqr';

export function QR({ text, label }: { text: string; label: string }) {
  const { data, size } = encode(text, { ecc: 'M', border: 0 });
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (data[y][x]) d += `M${x} ${y}h1v1h-1z`;
  }
  return (
    <svg viewBox={`-2 -2 ${size + 4} ${size + 4}`} shape-rendering="crispEdges" role="img" aria-label={label}>
      <rect x="-2" y="-2" width={size + 4} height={size + 4} fill="#fff" />
      <path d={d} fill="#0F1419" />
    </svg>
  );
}
