/**
 * @file motion.ts
 * @description Live reduced-motion preference and disposable prototype confetti.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { useEffect, useState } from "react";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** Returns a disposer so navigation or a changed motion preference leaves no particles. */
export function confetti(element: HTMLElement, color: string): () => void {
  const rect = element.getBoundingClientRect();
  const particles: HTMLElement[] = [];
  const animations: Animation[] = [];
  if (!element.animate) return () => {};
  for (let index = 0; index < 32; index++) {
    const particle = document.createElement("span");
    particle.className = "muro-confetti";
    particle.setAttribute("aria-hidden", "true");
    Object.assign(particle.style, {
      left: `${rect.left + rect.width / 2}px`,
      top: `${rect.top + 40}px`,
      background: [color, "#f3f4f6", "#818cf8", "#F2C14E"][index % 4],
    });
    document.body.appendChild(particle);
    particles.push(particle);
    const angle = Math.random() * Math.PI * 2;
    const distance = 60 + Math.random() * 130;
    const animation = particle.animate(
      [
        { transform: "translate(0,0) rotate(0)", opacity: 1 },
        {
          transform: `translate(${Math.cos(angle) * distance}px,${Math.sin(angle) * distance + 90}px) rotate(${Math.random() * 720}deg)`,
          opacity: 0,
        },
      ],
      { duration: 900 + Math.random() * 600, easing: "cubic-bezier(.2,.7,.4,1)" }
    );
    animation.onfinish = () => particle.remove();
    animations.push(animation);
  }
  return () => {
    animations.forEach((animation) => animation.cancel());
    particles.forEach((particle) => particle.remove());
  };
}
