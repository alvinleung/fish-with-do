// Maze layout in a fixed logical coordinate space (scaled to fit by CSS).

export const CANVAS_W = 900;
export const CANVAS_H = 560;

export const BALL_R = 18;
export const GOAL_R = 26;
export const START = { x: 60, y: 60 };
export const GOAL = { x: 840, y: 500 };

export type Rect = { x: number; y: number; w: number; h: number };

// Outer frame plus three internal walls that force a serpentine path:
// down col 1 -> right -> up col 2 -> right -> down col 3 -> right -> goal.
export const WALLS: Rect[] = [
  { x: 0, y: 0, w: CANVAS_W, h: 16 }, // top
  { x: 0, y: CANVAS_H - 16, w: CANVAS_W, h: 16 }, // bottom
  { x: 0, y: 0, w: 16, h: CANVAS_H }, // left
  { x: CANVAS_W - 16, y: 0, w: 16, h: CANVAS_H }, // right
  { x: 250, y: 16, w: 16, h: 384 }, // col 1/2 divider, gap at the bottom
  { x: 450, y: 160, w: 16, h: 384 }, // col 2/3 divider, gap at the top
  { x: 650, y: 16, w: 16, h: 384 }, // col 3/4 divider, gap at the bottom
];
