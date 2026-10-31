import carpImg from '../assets/fish-carp.png';
import largemouthImg from '../assets/fish-largemouth.png';
import salmonImg from '../assets/fish-salmon.png';
import troutImg from '../assets/fish-trout.png';
import cdImg from '../assets/junk-cd.png';
import bagImg from '../assets/junk-bag.png';
import bag1Img from '../assets/junk-bag-1.png';

export type CatchKind = 'fish' | 'junk';

export interface CatchDef {
  id: string;
  name: string;
  img: string;
  kind: CatchKind;
  strength: number; // 0..1 — how hard it pulls during the fight
  sizeMin: number;
  sizeMax: number;
  sizeUnit: string;
  points: number;
  weight: number; // relative bite probability
}

export const CATCHES: CatchDef[] = [
  { id: 'trout', name: 'Rainbow Trout', img: troutImg, kind: 'fish', strength: 0.34, sizeMin: 20, sizeMax: 45, sizeUnit: 'cm', points: 10, weight: 26 },
  { id: 'carp', name: 'Common Carp', img: carpImg, kind: 'fish', strength: 0.55, sizeMin: 40, sizeMax: 90, sizeUnit: 'cm', points: 25, weight: 20 },
  { id: 'largemouth', name: 'Largemouth Bass', img: largemouthImg, kind: 'fish', strength: 0.68, sizeMin: 30, sizeMax: 75, sizeUnit: 'cm', points: 40, weight: 16 },
  { id: 'salmon', name: 'King Salmon', img: salmonImg, kind: 'fish', strength: 0.85, sizeMin: 45, sizeMax: 110, sizeUnit: 'cm', points: 60, weight: 11 },
  { id: 'cd', name: 'Old CD', img: cdImg, kind: 'junk', strength: 0.42, sizeMin: 12, sizeMax: 12, sizeUnit: 'cm', points: 0, weight: 10 },
  { id: 'bag', name: 'Plastic Bag', img: bagImg, kind: 'junk', strength: 0.28, sizeMin: 15, sizeMax: 30, sizeUnit: 'cm', points: 0, weight: 10 },
  { id: 'bag1', name: 'Mystery Bag', img: bag1Img, kind: 'junk', strength: 0.5, sizeMin: 20, sizeMax: 40, sizeUnit: 'cm', points: 0, weight: 7 },
];

export function pickCatch(): CatchDef {
  const total = CATCHES.reduce((s, c) => s + c.weight, 0);
  let r = Math.random() * total;
  for (const c of CATCHES) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return CATCHES[0];
}

export function randomSize(c: CatchDef): number {
  if (c.sizeMin === c.sizeMax) return c.sizeMin;
  return Math.round(c.sizeMin + Math.random() * (c.sizeMax - c.sizeMin));
}
