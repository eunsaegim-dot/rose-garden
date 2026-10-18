// Web Serial bridge to the Arduino UNO R3 (9600 baud, line-based protocol).
//
// Board -> web (one line per physical press, already debounced/edge-
// detected on the board -- see the firmware notes):
//   BUTTON_1_TIME_MEASURE  -- D7, felt-time measurement start/stop toggle
//   BUTTON_2_PLAY_RESULT   -- D8, collective-music playback toggle
// Any other line (stray debug output, noise) is silently ignored.
//
// Web -> board:
//   VIBRATE_ON / VIBRATE_OFF   -- D10 motor, binary only (see vibrationSync.js)
//   MEASURE_ON / MEASURE_OFF   -- D11 LED, mirrors the web app's real
//                                 timer.isRunning() state regardless of
//                                 which input (on-screen button or the
//                                 board's own button 1) triggered it
//
// Nothing here assumes a board is present: write() is always a safe no-op
// when disconnected, and every measurement/playback function this module
// calls into (see main.js) is the same one the on-screen buttons already
// use -- the board is just an additional input/output device, never a
// second, parallel implementation of the app's logic.
export function isWebSerialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

let port = null;
let reader = null;
let writer = null;
let keepReading = false;
let removeDisconnectListener = null;

export function isSerialConnected() {
  return port !== null;
}

async function openPort(selectedPort, { baudRate, onButton1, onButton2, onDisconnect } = {}) {
  await selectedPort.open({ baudRate });
  port = selectedPort;
  writer = port.writable.getWriter();

  const textDecoder = new TextDecoderStream();
  port.readable.pipeTo(textDecoder.writable).catch(() => {
    /* resolves/rejects when the port closes -- the read loop below is the
       one source of truth for reacting to that */
  });
  reader = textDecoder.readable.getReader();
  keepReading = true;

  if (isWebSerialSupported()) {
    const handleDisconnect = (e) => {
      if (e.target !== port) return;
      teardown();
      onDisconnect?.();
    };
    navigator.serial.addEventListener('disconnect', handleDisconnect);
    removeDisconnectListener = () => navigator.serial.removeEventListener('disconnect', handleDisconnect);
  }

  let buffer = '';
  (async () => {
    let unexpectedEnd = false;
    try {
      while (keepReading) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line === 'BUTTON_1_TIME_MEASURE') onButton1?.();
          else if (line === 'BUTTON_2_PLAY_RESULT') onButton2?.();
        }
      }
    } catch {
      unexpectedEnd = true; // read failed -- almost always an unplugged cable
    }
    if (keepReading) {
      // Loop ended on its own (not via our own disconnectSerial(), which
      // clears keepReading first) -- the board went away unexpectedly.
      unexpectedEnd = true;
    }
    if (unexpectedEnd) {
      teardown();
      onDisconnect?.();
    }
  })();
}

function teardown() {
  keepReading = false;
  removeDisconnectListener?.();
  removeDisconnectListener = null;
  port = null;
  reader = null;
  writer = null;
}

// Opens the browser's USB port chooser -- requires a direct user gesture
// (e.g. a click), same as any other Web Serial call. Call this from the
// click handler of a visible "연결" control; see main.js.
export async function connectSerial({ baudRate = 9600, onButton1, onButton2, onDisconnect } = {}) {
  if (!isWebSerialSupported()) {
    throw new Error('Web Serial is not supported in this browser.');
  }
  const selected = await navigator.serial.requestPort();
  await openPort(selected, { baudRate, onButton1, onButton2, onDisconnect });
  return port;
}

// Silently retries a port the user has ALREADY granted permission for in
// this browser (no chooser dialog) -- used for "다시 연결" after an
// unplug/replug of the same board, and safe to try once on page load.
// Resolves to false (never throws) when there is nothing to reconnect to,
// so callers fall back to connectSerial()'s chooser instead.
export async function reconnectSerial({ baudRate = 9600, onButton1, onButton2, onDisconnect } = {}) {
  if (!isWebSerialSupported()) return false;
  try {
    const ports = await navigator.serial.getPorts();
    if (!ports.length) return false;
    await openPort(ports[0], { baudRate, onButton1, onButton2, onDisconnect });
    return true;
  } catch {
    return false;
  }
}

export async function disconnectSerial() {
  keepReading = false;
  try {
    await reader?.cancel();
  } catch {
    /* already closed */
  }
  try {
    await writer?.close();
  } catch {
    /* already closed */
  }
  try {
    await port?.close();
  } catch {
    /* already closed */
  }
  teardown();
}

// Sends one line to the board. Always safe to call -- a silent no-op when
// no board is connected, so callers (vibrationSync.js included) never need
// their own isSerialConnected() guard first.
export async function write(line) {
  if (!writer) return;
  try {
    await writer.write(new TextEncoder().encode(`${line}\n`));
  } catch (err) {
    console.error('Serial write failed', err);
  }
}
