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
  let midiAccess   = null;
  let output       = null;
  let playbackState = "stopped"; // stopped | playing | paused
  let scheduleTimer = null;
  let notes         = [];
  let bpm           = 80;
  let startTime     = 0;   // AudioContext-like via performance.now()
  let pauseOffset   = 0;   // ms elapsed before pause
  let noteIndex     = 0;   // next note to schedule

  // ── MIDI access ───────────────────────────────────────────────────────
  async function requestAccess() {
    if (!navigator.requestMIDIAccess) {
      emit("midi:error", { message: "Web MIDI API not supported in this browser. Use Chrome or Edge." });
      throw new Error("Web MIDI not supported");
    }
    try {
      midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      midiAccess.onstatechange = () => emit("midi:outputs-changed");
      emit("midi:outputs-changed");
    } catch (err) {
      emit("midi:error", { message: "MIDI access denied: " + err.message });
      throw err;
    }
  }

  function getOutputs() {
    if (!midiAccess) return [];
    return Array.from(midiAccess.outputs.values());
  }

  function connect(outputId) {
    if (!midiAccess) return false;
    const out = midiAccess.outputs.get(outputId);
    if (!out) return false;
    output = out;
    emit("midi:connected", { name: out.name });
    return true;
  }

  function disconnect() {
    stop();
    output = null;
    emit("midi:disconnected");
  }

  function isConnected() {
    return output !== null;
  }

  function getState() {
    return playbackState;
  }

  // ── MIDI helpers ──────────────────────────────────────────────────────
  const NOTE_ON  = 0x90;
  const NOTE_OFF = 0x80;
  const CHANNEL  = 0; // channel 1

  function sendNoteOn(midiNote, velocity = 80) {
    if (!output) return;
    output.send([NOTE_ON | CHANNEL, midiNote, velocity]);
  }

  function sendNoteOff(midiNote) {
    if (!output) return;
    output.send([NOTE_OFF | CHANNEL, midiNote, 0]);
  }

  function allNotesOff() {
    if (!output) return;
    // All Notes Off CC #123
    output.send([0xB0 | CHANNEL, 123, 0]);
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
