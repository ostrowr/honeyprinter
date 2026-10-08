export const ROWS = 92;
export const COLS = 12;
export const WIDTH = 2.30;
export const LENGTH = 9.35;
const STRIDE = COLS + 1;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// A thin, stiff sheet, with structural, shear and bending constraints. Its
// natural curl supplies bending memory; edge lengths keep drags from stretching
// the receipt like rubber. Only the two rows inside the print head are pinned.
export class Paper {
  constructor() {
    this.rest = new Float32Array((ROWS + 1) * STRIDE * 3);
    for (let row = 0; row <= ROWS; row++) {
      const s = row / ROWS * LENGTH;
      let x, y, z;
      if (s < 3.1) {
        x = -.025 * s * s; y = 1.80 + s * .98; z = .23 - .11 * s - .016 * s * s;
      } else if (s < 4.9) {
        const angle = (s - 3.1) / 1.8 * Math.PI;
        x = -.24 + .045 * (1 - Math.cos(angle));
        y = 4.838 + .58 * Math.sin(angle); z = -.265 - .64 * (1 - Math.cos(angle));
      } else {
        const tail = s - 4.9;
        x = -.15 + .06 * Math.sin(tail * 1.2); y = 4.838 - tail * .99; z = -1.545 - tail * .10;
      }
      for (let col = 0; col <= COLS; col++) {
        const across = col / COLS - .5, i = (row * STRIDE + col) * 3;
        const twist = -.06 * Math.sin(s * .6) * Math.min(1, s);
        this.rest[i] = x + across * WIDTH;
        this.rest[i + 1] = y + across * twist;
        this.rest[i + 2] = z + (across * across - .25) * .13 * Math.min(1, s);
      }
    }
    this.positions = this.rest.slice();
    this.previous = this.rest.slice();
    this.constraints = [];
    const link = (a, b, strength) => {
      const i = a * 3, j = b * 3;
      const length = Math.hypot(this.rest[i] - this.rest[j], this.rest[i+1] - this.rest[j+1], this.rest[i+2] - this.rest[j+2]);
      this.constraints.push([i, j, length, strength]);
    };
    for (let row = 0; row <= ROWS; row++) for (let col = 0; col <= COLS; col++) {
      const i = row * STRIDE + col;
      if (row < ROWS) link(i, i + STRIDE, 1);
      if (col < COLS) link(i, i + 1, 1);
      if (row < ROWS && col < COLS) { link(i, i + STRIDE + 1, .65); link(i + 1, i + STRIDE, .65); }
      if (row + 2 <= ROWS) link(i, i + STRIDE * 2, .48);
      if (col + 2 <= COLS) link(i, i + 2, .6);
    }
    this.grab = null;
    this.gust = null;
    this.time = 0;
  }

  reset() { this.positions.set(this.rest); this.previous.set(this.rest); this.grab = this.gust = null; }

  step(dt, printing) {
    this.time += dt;
    const p = this.positions, rest = this.rest, previous = this.previous;
    const fixed = STRIDE * 2 * 3;
    for (let i = fixed; i < p.length; i += 3) {
      const row = Math.floor(i / 3 / STRIDE), free = row / ROWS;
      const strength = 13 + 25 * Math.exp(-free * 15);
      for (let axis = 0; axis < 3; axis++) {
        const j = i + axis, current = p[j];
        const velocity = (current - previous[j]) * .965;
        let force = (rest[j] - current) * strength;
        if (axis === 1) force -= .25;
        if (axis === 2) force += Math.sin(this.time * 1.5 - free * 7) * .05 * free;
        if (printing && axis === 2) force += Math.sin(this.time * 35 - free * 18) * .18 * (1 - free);
        if (this.gust) {
          const distance = Math.hypot(p[i] - this.gust.x, p[i+1] - this.gust.y, p[i+2] - this.gust.z);
          force += this.gust.force[axis] * Math.exp(-distance * distance * 2.5);
        }
        p[j] = current + velocity + force * dt * dt;
        previous[j] = current;
      }
    }
    for (let iteration = 0; iteration < 7; iteration++) {
      if (this.grab) {
        const row = this.grab.row, col = this.grab.col;
        const index = (row * STRIDE + col) * 3;
        // Bound the drag to the part of the sheet that can plausibly reach it.
        for (let axis = 0; axis < 3; axis++) {
          const target = clamp(this.grab.target[axis], rest[index+axis] - 1.1, rest[index+axis] + 1.1);
          p[index+axis] += (target - p[index+axis]) * .38;
        }
      }
      for (const [i, j, length, strength] of this.constraints) {
        const dx = p[j]-p[i], dy = p[j+1]-p[i+1], dz = p[j+2]-p[i+2];
        const distance = Math.hypot(dx, dy, dz);
        if (distance < 1e-8) continue;
        const wi = i < fixed ? 0 : 1, wj = j < fixed ? 0 : 1;
        if (!wi && !wj) continue;
        const correction = (distance - length) / distance * strength / (wi + wj);
        p[i] += dx * correction * wi; p[i+1] += dy * correction * wi; p[i+2] += dz * correction * wi;
        p[j] -= dx * correction * wj; p[j+1] -= dy * correction * wj; p[j+2] -= dz * correction * wj;
      }
      for (let i = fixed; i < p.length; i += 3) {
        p[i+1] = Math.max(.035, p[i+1]);
        // Keep paper out of the housing, but leave the print-head opening free.
        if (p[i+1] < 1.74 && Math.abs(p[i]) < 1.85 && Math.abs(p[i+2]) < 1.45) {
          if (i / 3 / STRIDE > ROWS * .5) p[i+2] = -1.48;
          else p[i+1] = 1.74;
        }
      }
      p.set(rest.subarray(0, fixed), 0);
    }
    if (this.gust) {
      this.gust.force = this.gust.force.map(force => force * .88);
      if (Math.hypot(...this.gust.force) < .01) this.gust = null;
    }
  }
}
