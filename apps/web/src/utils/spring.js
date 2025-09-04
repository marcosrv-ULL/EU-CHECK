export function makeSpring({ mass = 1, stiffness = 120, damping = 18, initial = 0 } = {}) {
    let x = initial;   // posición
    let v = 0;         // velocidad
    const dt = 1 / 60; // 60 FPS aprox
  
    return function step(target) {
      // F = -k(x - target) - c v
      const k = stiffness, c = damping, m = mass;
      const a = (-k * (x - target) - c * v) / m;
      v += a * dt;
      x += v * dt;
      return x;
    };
  }
  