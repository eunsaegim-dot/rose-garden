// Web Serial scaffold for a future Arduino UNO R3 button -- NOT wired to
// any real device yet, and not reachable from the real artwork's own UI
// (see main.js's dev panel, which is hidden unless ?dev=1 or the
// shift+alt+d shortcut). isWebSerialSupported() only reports whether the
// browser API exists at all. connectSerial() requests a port and listens
// for plain "DOWN"/"UP" lines, calling back into exactly the same
// beginMeasurement/completeMeasurement pair the on-screen "시간 느끼기"
// button already drives -- timer.js has no idea which input source started
// or stopped it, so when a real board is eventually connected, no
// measurement logic changes at all, only the input source does.
export function isWebSerialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

let port = null;
let reader = null;
let keepReading = false;

export function isSerialConnected() {
  return port !== null;
}

export async function connectSerial({ onPress, onRelease, baudRate = 9600 } = {}) {
  if (!isWebSerialSupported()) {
    throw new Error('Web Serial is not supported in this browser.');
  }
  port = await navigator.serial.requestPort();
  await port.open({ baudRate });

  const textDecoder = new TextDecoderStream();
  port.readable.pipeTo(textDecoder.writable);
  reader = textDecoder.readable.getReader();
  keepReading = true;

  let buffer = '';
  (async () => {
    while (keepReading) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        break; // port closed/disconnected
      }
      const { value, done } = chunk;
      if (done) break;
      buffer += value;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line === 'DOWN') onPress?.();
        else if (line === 'UP') onRelease?.();
      }
    }
  })();

  return port;
}

export async function disconnectSerial() {
  keepReading = false;
  try {
    await reader?.cancel();
  } catch {
    /* already closed */
  }
  try {
    await port?.close();
  } catch {
    /* already closed */
  }
  port = null;
  reader = null;
}
