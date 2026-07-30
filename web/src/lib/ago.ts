// Relative timestamps, shared by the lobby and stacks pages.
//
// STYLE picks the representation; 'plain' is the setting for now.
//  - plain:       "8h ago", "3d ago"           (rounded, detail dropped)
//  - fractions:   "2¼d ago", "5⅔h ago"         (remainder as ½ ⅓ ¼ ⅕ …)
//  - major-minor: "8h10m ago", "3d12h ago", "1w5d ago"
const STYLE: 'plain' | 'fractions' | 'major-minor' = 'plain';

const FRACTIONS: Array<[number, string]> = [
  [0, ''],
  [1 / 5, '⅕'],
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [2 / 5, '⅖'],
  [1 / 2, '½'],
  [3 / 5, '⅗'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
  [4 / 5, '⅘'],
  [1, ''],
];

function withFraction(value: number, unit: string): string {
  const whole = Math.floor(value);
  const frac = value - whole;
  let best = FRACTIONS[0];
  for (const cand of FRACTIONS) {
    if (Math.abs(cand[0] - frac) < Math.abs(best[0] - frac)) best = cand;
  }
  return best[0] === 1 ? `${whole + 1}${unit} ago` : `${whole}${best[1]}${unit} ago`;
}

function plain(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function fractions(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m ago`;
  if (mins < 60 * 24) return withFraction(mins / 60, 'h');
  return withFraction(mins / 1440, 'd');
}

function majorMinor(mins: number): string {
  const floored = Math.floor(mins);
  if (floored < 60) return `${floored}m ago`;
  const pair = (whole: number, unit: string, rest: number, restUnit: string) =>
    rest ? `${whole}${unit}${rest}${restUnit} ago` : `${whole}${unit} ago`;
  const hours = Math.floor(floored / 60);
  if (hours < 24) return pair(hours, 'h', floored % 60, 'm');
  const days = Math.floor(hours / 24);
  if (days < 7) return pair(days, 'd', hours % 24, 'h');
  return pair(Math.floor(days / 7), 'w', days % 7, 'd');
}

export function fmtAgo(iso: string): string {
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins < 1) return 'just now';
  if (STYLE === 'fractions') return fractions(mins);
  if (STYLE === 'major-minor') return majorMinor(mins);
  return plain(mins);
}
