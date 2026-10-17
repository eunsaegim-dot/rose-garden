// Felt-time measurement, decoupled from any particular input device.
// A future Arduino/WebSerial button can drive this exact same pair of
// calls instead of the on-screen button: start() on the first press,
// stop() on the second — the duration between them IS the data point.
let startedAt = null;

export function start() {
  startedAt = performance.now();
}

export function stop() {
  if (startedAt === null) return 0;
  const feltSeconds = (performance.now() - startedAt) / 1000;
  startedAt = null;
  return feltSeconds;
}

export function isRunning() {
  return startedAt !== null;
}

export function elapsed() {
  return startedAt === null ? 0 : (performance.now() - startedAt) / 1000;
}
