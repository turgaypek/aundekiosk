// auth-bg.js — a lightweight animated "network" background (connected
// moving dots) behind the setup/login cards, in the IoT-dashboard style
// the user asked for (Home Assistant-like). Runs entirely in the
// browser of whoever is viewing the dashboard (never on the kiosk's own
// Chromium, which only ever shows the configured slideshow URLs), so it
// has no bearing on the Pi's own CPU/disk load. Kept deliberately cheap
// regardless — a small fixed particle count, no external library, paused
// while the tab is hidden, and skipped entirely for
// prefers-reduced-motion.

const PARTICLE_COUNT = 46;
const MAX_LINK_DISTANCE = 140;
const SPEED = 0.18;

function initAuthBackground(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  let width = 0;
  let height = 0;
  let particles = [];
  let animationFrame = null;

  function resize() {
    width = canvas.width = canvas.offsetWidth;
    height = canvas.height = canvas.offsetHeight;
  }

  function makeParticles() {
    particles = Array.from({ length: PARTICLE_COUNT }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * SPEED,
      vy: (Math.random() - 0.5) * SPEED,
    }));
  }

  function step() {
    ctx.clearRect(0, 0, width, height);

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0 || p.x > width) p.vx *= -1;
      if (p.y < 0 || p.y > height) p.vy *= -1;
    }

    ctx.fillStyle = "rgba(253, 126, 20, 0.55)";
    for (const p of particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const a = particles[i];
        const b = particles[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MAX_LINK_DISTANCE) {
          ctx.strokeStyle = `rgba(253, 126, 20, ${0.18 * (1 - dist / MAX_LINK_DISTANCE)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    animationFrame = requestAnimationFrame(step);
  }

  function start() {
    if (animationFrame !== null) return;
    animationFrame = requestAnimationFrame(step);
  }

  function stop() {
    if (animationFrame === null) return;
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }

  // The canvas starts out inside a `hidden` <section> (setup/login are
  // mutually exclusive, and whichever isn't active is hidden), so its
  // rendered size is 0x0 at load — a plain one-time resize() would leave
  // every particle stuck at (0,0) forever. ResizeObserver fires again
  // the moment auth.js flips `hidden` off and the canvas actually gets
  // real dimensions, not just on window resize.
  let hasSized = false;
  const observer = new ResizeObserver(() => {
    const changed = canvas.offsetWidth !== width || canvas.offsetHeight !== height;
    if (!changed && hasSized) return;
    resize();
    if (width === 0 || height === 0) return;
    makeParticles();
    hasSized = true;
    if (!prefersReducedMotion) {
      start();
    } else if (animationFrame === null) {
      step();
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
  });
  observer.observe(canvas);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (!prefersReducedMotion && hasSized) start();
  });
}

function initAllAuthBackgrounds() {
  document.querySelectorAll(".auth-bg-canvas").forEach(initAuthBackground);
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAllAuthBackgrounds);
  } else {
    initAllAuthBackgrounds();
  }
}
