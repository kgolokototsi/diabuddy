// Tiny spring animator using Apple's designer-facing parameters:
//   dampingRatio – 1 = no overshoot, < 1 = bounce
//   response     – seconds to (roughly) reach the target; not a fixed duration
// Springs start from the current value and velocity, so any motion can be
// grabbed and redirected mid-flight.

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function spring({ from, to, velocity = 0, dampingRatio = 1, response = 0.4, onUpdate, onComplete }) {
  const stiffness = (2 * Math.PI / response) ** 2;
  const damping = (4 * Math.PI * dampingRatio) / response;
  let x = from;
  let v = velocity;
  let last = performance.now();
  let raf = 0;
  let done = false;

  const finish = () => {
    done = true;
    x = to;
    v = 0;
    onUpdate?.(to);
    onComplete?.();
  };

  if (reducedMotion()) {
    queueMicrotask(finish);
  } else {
    const tick = (now) => {
      let dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      // Fixed small sub-steps keep stiff springs stable on slow frames.
      while (dt > 0) {
        const h = Math.min(dt, 1 / 240);
        const a = -stiffness * (x - to) - damping * v;
        v += a * h;
        x += v * h;
        dt -= h;
      }
      if (Math.abs(x - to) < 0.3 && Math.abs(v) < 8) return finish();
      onUpdate?.(x);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  return {
    stop() { cancelAnimationFrame(raf); done = true; },
    get value() { return x; },
    get velocity() { return done ? 0 : v; },
  };
}

// Where a flick would come to rest – Apple's projection from "Designing Fluid Interfaces".
export function project(velocity, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

// Progressive resistance past a boundary instead of a hard stop.
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

// Tracks pointer movement and reports release velocity (px/s) from the last ~100 ms.
export class VelocityTracker {
  constructor() { this.samples = []; }
  add(y, t = performance.now()) {
    this.samples.push({ y, t });
    while (this.samples.length > 2 && t - this.samples[0].t > 100) this.samples.shift();
  }
  velocity() {
    const s = this.samples;
    if (s.length < 2) return 0;
    const a = s[0];
    const b = s[s.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt > 0 ? (b.y - a.y) / dt : 0;
  }
}
