/**
 * midi.js — MIDI Connection & Playback Module
 *
 * Public API (window.MidiPlayer):
 *   MidiPlayer.requestAccess()                → Promise<void>
 *   MidiPlayer.getOutputs()                   → MIDIOutput[]
 *   MidiPlayer.connect(outputId)              → boolean
 *   MidiPlayer.disconnect()                   → void
 *   MidiPlayer.play(notes, bpm)               → void
 *   MidiPlayer.pause()                        → void
 *   MidiPlayer.resume()                       → void
 *   MidiPlayer.stop()                         → void
 *   MidiPlayer.isConnected()                  → boolean
 *   MidiPlayer.getState()                     → PlaybackState
 *
 * Events emitted on document:
 *   midi:outputs-changed   — MIDI device list changed
 *   midi:connected         — device connected { detail: { name } }
 *   midi:disconnected      — device disconnected
 *   midi:note              — note playing { detail: { index, note } }
 *   midi:progress          — { detail: { ratio: 0–1 } }
 *   midi:ended             — playback finished
 *   midi:error             — { detail: { message } }
 */

const MidiPlayer = (() => {

  // ── State ─────────────────────────────────────────────────────────────
  let midiAccess    = null;
  let output        = null;  // Web MIDI output (desktop) or null for BLE
  let bleChar       = null;  // BLE MIDI characteristic (mobile)
  let bleDevice     = null;  // BLE device reference
  let bleConnected  = false;
  let playbackState = "stopped"; // stopped | playing | paused
  let scheduleTimer = null;
  let notes         = [];
  let bpm           = 80;
  let startTime     = 0;
  let pauseOffset   = 0;
  let noteIndex     = 0;

  // BLE MIDI constants
  const BLE_MIDI_SERVICE    = "03b80e5a-ede8-4b33-a751-6ce34ec4c700";
  const BLE_MIDI_CHAR       = "7772e5db-3868-4112-a1a9-f2669d106bf3";

  // ── MIDI access (Web MIDI API — works on desktop) ─────────────────────
  async function requestAccess() {
    if (!navigator.requestMIDIAccess) {
      console.info("[MIDI] Web MIDI API not available — BLE mode only.");
      return;
    }
    try {
      midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      midiAccess.onstatechange = () => emit("midi:outputs-changed");
      emit("midi:outputs-changed");
    } catch (err) {
      console.warn("[MIDI] Web MIDI access denied:", err.message);
    }
  }

  function getOutputs() {
    const list = [];
    if (midiAccess) {
      for (const out of midiAccess.outputs.values()) {
        list.push({ id: out.id, name: out.name, type: "midi" });
      }
    }
    // Add BLE option
    if (navigator.bluetooth) {
      list.push({ id: "__ble__", name: "🔵 Scan for Bluetooth MIDI...", type: "ble" });
    }
    return list;
  }

  // ── Connect (Web MIDI or BLE) ─────────────────────────────────────────
  async function connect(outputId) {
    if (outputId === "__ble__") {
      return connectBLE();
    }
    // Standard Web MIDI
    if (!midiAccess) return false;
    const out = midiAccess.outputs.get(outputId);
    if (!out) return false;
    output = out;
    bleChar = null;
    emit("midi:connected", { name: out.name });
    return true;
  }

  // ── BLE MIDI Connection ───────────────────────────────────────────────
  async function connectBLE() {
    if (!navigator.bluetooth) {
      emit("midi:error", { message: "Web Bluetooth not available in this browser." });
      return false;
    }
    try {
      emit("midi:status", { message: "Scanning for Bluetooth MIDI devices..." });

      bleDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BLE_MIDI_SERVICE] }],
        // Also try name filter for MD-BT01
        // optionalServices: [BLE_MIDI_SERVICE],
      });

      emit("midi:status", { message: "Connecting to " + bleDevice.name + "..." });

      bleDevice.addEventListener("gattserverdisconnected", () => {
        bleConnected = false;
        bleChar = null;
        emit("midi:disconnected");
      });

      const server  = await bleDevice.gatt.connect();
      const service = await server.getPrimaryService(BLE_MIDI_SERVICE);
      bleChar       = await service.getCharacteristic(BLE_MIDI_CHAR);
      bleConnected  = true;
      output        = null; // Not using Web MIDI output

      emit("midi:connected", { name: bleDevice.name || "BLE MIDI Device" });
      return true;
    } catch (err) {
      if (err.name === "NotFoundError") {
        emit("midi:error", { message: "No BLE MIDI device selected." });
      } else {
        emit("midi:error", { message: "BLE connect failed: " + err.message });
      }
      return false;
    }
  }

  function disconnect() {
    stop();
    if (bleDevice && bleDevice.gatt.connected) {
      bleDevice.gatt.disconnect();
    }
    output = null;
    bleChar = null;
    bleConnected = false;
    emit("midi:disconnected");
  }

  function isConnected() {
    return output !== null || bleConnected;
  }

  function getState() {
    return playbackState;
  }

  // ── MIDI message sending ──────────────────────────────────────────────
  const NOTE_ON  = 0x90;
  const NOTE_OFF = 0x80;
  const CHANNEL  = 0;

  function sendMidiBytes(bytes) {
    if (output) {
      // Web MIDI output
      output.send(bytes);
    } else if (bleChar && bleConnected) {
      // BLE MIDI: prepend header + timestamp bytes
      // BLE MIDI packet format: [header, timestamp, status, data1, data2]
      const timestamp = Date.now() & 0x1FFF; // 13-bit ms timestamp
      const header    = 0x80 | ((timestamp >> 7) & 0x3F);
      const tsLow     = 0x80 | (timestamp & 0x7F);
      const packet    = new Uint8Array([header, tsLow, ...bytes]);
      bleChar.writeValueWithoutResponse(packet).catch(err => {
        console.warn("[BLE MIDI] Write error:", err);
      });
    }
  }

  function sendNoteOn(midiNote, velocity = 80) {
    sendMidiBytes([NOTE_ON | CHANNEL, midiNote, velocity]);
  }

  function sendNoteOff(midiNote) {
    sendMidiBytes([NOTE_OFF | CHANNEL, midiNote, 0]);
  }

  function allNotesOff() {
    sendMidiBytes([0xB0 | CHANNEL, 123, 0]);
  }

  // ── Timing ───────────────────────────────────────────────────────────
  function beatsToMs(beats, bpmVal) {
    return (beats / bpmVal) * 60_000;
  }

  function durationToBeats(duration) {
    return SheetOCR.beatsForDuration(duration);
  }

  // ── Playback ─────────────────────────────────────────────────────────
  function play(noteList, bpmVal) {
    if (!output) {
      emit("midi:error", { message: "No MIDI device connected." });
      return;
    }
    if (!noteList || noteList.length === 0) {
      emit("midi:error", { message: "No notes to play." });
      return;
    }

    stop(); // reset any existing playback

    notes = noteList.slice();
    bpm   = bpmVal || 80;

    // Build schedule: array of { time: ms, note, duration }
    // time is relative to start (0 ms = first note)
    const totalBeats = notes.reduce((max, n) =>
      Math.max(max, n.startBeat + durationToBeats(n.duration)), 0);
    const totalMs = beatsToMs(totalBeats, bpm);

    noteIndex    = 0;
    startTime    = performance.now();
    pauseOffset  = 0;
    playbackState = "playing";

    scheduleNextNote();
    trackProgress(totalMs);
  }

  function scheduleNextNote() {
    if (playbackState !== "playing") return;
    if (noteIndex >= notes.length) return;

    const n         = notes[noteIndex];
    const noteMs    = beatsToMs(n.startBeat, bpm);
    const elapsed   = performance.now() - startTime + pauseOffset;
    const delay     = Math.max(0, noteMs - elapsed);
    const durMs     = beatsToMs(durationToBeats(n.duration), bpm) * 0.9; // 10% articulation gap

    scheduleTimer = setTimeout(() => {
      if (playbackState !== "playing") return;

      const midi = SheetOCR.noteToMidi(n.note);
      if (midi !== null) {
        sendNoteOn(midi);
        setTimeout(() => sendNoteOff(midi), durMs);
      }

      emit("midi:note", { index: noteIndex, note: n });
      noteIndex++;
      scheduleNextNote();
    }, delay);
  }

  function trackProgress(totalMs) {
    function tick() {
      if (playbackState === "stopped") return;
      if (playbackState === "paused") {
        requestAnimationFrame(tick);
        return;
      }
      const elapsed = performance.now() - startTime + pauseOffset;
      const ratio   = Math.min(elapsed / totalMs, 1);
      emit("midi:progress", { ratio });
      if (elapsed >= totalMs) {
        playbackState = "stopped";
        emit("midi:ended");
        return;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function pause() {
    if (playbackState !== "playing") return;
    pauseOffset += performance.now() - startTime;
    playbackState = "paused";
    clearTimeout(scheduleTimer);
    allNotesOff();
  }

  function resume() {
    if (playbackState !== "paused") return;
    startTime     = performance.now();
    playbackState = "playing";

    // Find the next note to play based on current offset
    const currentBeat = (pauseOffset / 60_000) * bpm;
    noteIndex = notes.findIndex(n => n.startBeat >= currentBeat - 0.1);
    if (noteIndex === -1) noteIndex = notes.length;

    scheduleNextNote();
  }

  function stop() {
    clearTimeout(scheduleTimer);
    playbackState = "stopped";
    noteIndex    = 0;
    pauseOffset  = 0;
    allNotesOff();
    emit("midi:progress", { ratio: 0 });
  }

  // ── Event helper ──────────────────────────────────────────────────────
  function emit(name, detail = {}) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }

  return {
    requestAccess,
    getOutputs,
    connect,
    disconnect,
    isConnected,
    getState,
    play,
    pause,
    resume,
    stop,
  };
})();
