// Shared catch + bait tables. Both the computer (game) and the phone
// (controller) import these so they render identical fish/junk/bait art and
// agree on what each catch id means.
import carpImg from '../assets/fish-carp.png';
import largemouthImg from '../assets/fish-largemouth.png';
import salmonImg from '../assets/fish-salmon.png';
import troutImg from '../assets/fish-trout.png';
import unsagiImg from '../assets/random-unsagi.png';
import cdImg from '../assets/junk-cd.png';
import bagImg from '../assets/junk-bag.png';
import ipadImg from '../assets/loot-ipad.png';
import smiskiImg from '../assets/loot-smiski.png';
import wormImg from '../assets/bait-worm.png';
import cornImg from '../assets/bait-corn.png';
import maggotsImg from '../assets/bait-maggots.png';
import shrimpImg from '../assets/bait-shrimp.png';

export type CatchKind = 'fish' | 'junk' | 'loot';

export interface CatchDef {
  id: string;
  name: string;
  img: string;
  kind: CatchKind;
  strength: number; // 0..1 — how hard it pulls during the fight
  sizeMin: number;
  sizeMax: number;
  sizeUnit: string;
  price: number; // fixed sale value ($) — the day-end market pays this per item
  weight: number; // relative bite probability
}

export const CATCHES: CatchDef[] = [
  { id: 'trout', name: 'Rainbow Trout', img: troutImg, kind: 'fish', strength: 0.34, sizeMin: 20, sizeMax: 45, sizeUnit: 'cm', price: 10, weight: 26 },
  { id: 'carp', name: 'Common Carp', img: carpImg, kind: 'fish', strength: 0.55, sizeMin: 40, sizeMax: 90, sizeUnit: 'cm', price: 25, weight: 20 },
  { id: 'unsagi', name: 'Unsagi', img: unsagiImg, kind: 'fish', strength: 0.58, sizeMin: 30, sizeMax: 70, sizeUnit: 'cm', price: 35, weight: 14 },
  { id: 'largemouth', name: 'Largemouth Bass', img: largemouthImg, kind: 'fish', strength: 0.68, sizeMin: 30, sizeMax: 75, sizeUnit: 'cm', price: 40, weight: 16 },
  { id: 'salmon', name: 'King Salmon', img: salmonImg, kind: 'fish', strength: 0.85, sizeMin: 45, sizeMax: 110, sizeUnit: 'cm', price: 60, weight: 11 },
  { id: 'cd', name: 'Old CD', img: cdImg, kind: 'junk', strength: 0.42, sizeMin: 12, sizeMax: 12, sizeUnit: 'cm', price: 4, weight: 10 },
  { id: 'bag', name: 'Plastic Bag', img: bagImg, kind: 'junk', strength: 0.28, sizeMin: 15, sizeMax: 30, sizeUnit: 'cm', price: 3, weight: 10 },
  { id: 'ipad', name: 'Lost iPad', img: ipadImg, kind: 'loot', strength: 0.3, sizeMin: 25, sizeMax: 25, sizeUnit: 'cm', price: 150, weight: 5 },
  { id: 'smiski', name: 'Smiski', img: smiskiImg, kind: 'loot', strength: 0.35, sizeMin: 20, sizeMax: 35, sizeUnit: 'cm', price: 120, weight: 4 },
];

export function catchById(id: string): CatchDef {
  return CATCHES.find((c) => c.id === id) ?? CATCHES[0];
}

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

// ---- Bait -----------------------------------------------------------------
// Cosmetic for now: picking a bait gates the bait-select -> fishing transition
// on the phone but does not yet change the catch distribution.
export interface BaitDef {
  id: string;
  name: string;
  img: string;
}

export const BAITS: BaitDef[] = [
  { id: 'worm', name: 'Worm', img: wormImg },
  { id: 'corn', name: 'Corn', img: cornImg },
  { id: 'maggots', name: 'Maggots', img: maggotsImg },
  { id: 'shrimp', name: 'Shrimp', img: shrimpImg },
];

export function baitById(id: string): BaitDef {
  return BAITS.find((b) => b.id === id) ?? BAITS[0];
}
