// A handful of soft, deterministic light motes drifting behind the rose —
// pure CSS animation, no canvas/WebGL needed for this 2D piece.
export function createSparkleLayer(container, count = 22) {
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('div');
    dot.className = 'sparkle';
    const size = 2 + ((i * 37) % 5);
    const left = (i * 53.7) % 100;
    const top = (i * 29.3 + i * i * 7) % 100;
    const delay = (i * 0.37) % 6;
    const duration = 4 + ((i * 11) % 5);
    dot.style.width = `${size}px`;
    dot.style.height = `${size}px`;
    dot.style.left = `${left}%`;
    dot.style.top = `${top}%`;
    dot.style.animationDelay = `${delay}s`;
    dot.style.animationDuration = `${duration}s`;
    container.appendChild(dot);
  }
}
