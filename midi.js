/**
 * midi.js — MIDI Connection & Playback Module
 *
 * Supports both Web MIDI API (desktop) and Web Bluetooth BLE MIDI (mobile).
 * BLE MIDI writes are queued and throttled to prevent disconnects.
 */

const MidiPlayer = (() => {

  // ── State ─────────────────────────────────────────────────────────────
  let midiAccess    = null;
  let output        = null;  // Web MIDI output (desktop)
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

  // BLE write queue — prevents overwhelming the connection
  let bleWriteQueue = [];
  let bleWriting    = false;
  const BLE_WRITE_DELAY = 20; // ms between BLE writes

  // BLE MIDI constants
  const BLE_MIDI_SERVICE = "03b80e5a-ede8-4b33-a751-6ce34ec4c700";
  const BLE_MIDI_CHAR    = "7772e5db-3868-4112-a1a9-f2669d106bf3";

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
    if (!midiAccess) return false;
    const out = midiAccess.outputs.get(outputId);
    if (!out) return false;
    output = out;
    bleChar = null;
    bleConnected = false;
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
      });

      emit("midi:status", { message: "Connecting to " + bleDevice.name + "..." });

      bleDevice.addEventListener("gattserverdisconnected", () => {
        bleConnected = false;
        bleChar = null;
        bleWriteQueue = [];
        bleWriting = false;
        stop();
        emit("midi:disconnected");
      });

      const server  = await bleDevice.gatt.connect();
      const service = await server.getPrimaryService(BLE_MIDI_SERVICE);
      bleChar       = await service.getCharacteristic(BLE_MIDI_CHAR);
      bleConnected  = true;
      output        = null;

      // Small delay to let BLE connection stabilize
      await new Promise(r => setTimeout(r, 200));

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
    if (bleDevice && bleDevice.gatt && bleDevice.gatt.connected) {
      bleDevice.gatt.disconnect();
    }
    output = null;
    bleChar = null;
    bleConnected = false;
    bleWriteQueue = [];
    bleWriting = false;
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
      // Web MIDI — direct, no throttling needed
      output.send(bytes);
    } else if (bleChar && bleConnected) {
      // BLE MIDI — queue writes to prevent disconnect
      const timestamp = Date.now() & 0x1FFF;
      const header    = 0x80 | ((timestamp >> 7) & 0x3F);
      const tsLow     = 0x80 | (timestamp & 0x7F);
      const packet    = new Uint8Array([header, tsLow, ...bytes]);
      enqueueBleWrite(packet);
    }
  }

  function enqueueBleWrite(packet) {
    bleWriteQueue.push(packet);
    if (!bleWriting) processBleQueue();
  }

  async function processBleQueue() {
    if (bleWriting) return;
    bleWriting = true;

    while (bleWriteQueue.length > 0) {
      if (!bleChar || !bleConnected) {
        bleWriteQueue = [];
        break;
      }
      const packet = bleWriteQueue.shift();
      try {
        await bleChar.writeValueWithoutResponse(packet);
      } catch (err) {
        console.warn("[BLE MIDI] Write error:", err.message);
        // Don't clear queue on single write failure — try next
        // But if disconnected, bail out
        if (!bleConnected) {
          bleWriteQueue = [];
          break;
        }
      }
      // Throttle: wait between writes
      if (bleWriteQueue.length > 0) {
        await new Promise(r => setTimeout(r, BLE_WRITE_DELAY));
      }
    }

    bleWriting = false;
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
    if (!isConnected()) {
      emit("midi:error", { message: "No MIDI device connected." });
      return;
    }
    if (!noteList || noteList.length === 0) {
      emit("midi:error", { message: "No notes to play." });
      return;
    }

    stop();

    notes = noteList.slice();
    bpm   = bpmVal || 80;

    const totalBeats = notes.reduce((max, n) =>
      Math.max(max, n.startBeat + durationToBeats(n.duration)), 0);
    const totalMs = beatsToMs(totalBeats, bpm);

    noteIndex     = 0;
    startTime     = performance.now();
    pauseOffset   = 0;
    playbackState = "playing";

    scheduleNextNote();
    trackProgress(totalMs);
  }

  function scheduleNextNote() {
    if (playbackState !== "playing") return;
    if (noteIndex >= notes.length) return;

    const n       = notes[noteIndex];
    const noteMs  = beatsToMs(n.startBeat, bpm);
    const elapsed = performance.now() - startTime + pauseOffset;
    const delay   = Math.max(0, noteMs - elapsed);
    const durMs   = beatsToMs(durationToBeats(n.duration), bpm) * 0.9;

    scheduleTimer = setTimeout(() => {
      if (playbackState !== "playing") return;
      if (!isConnected()) {
        emit("midi:error", { message: "Device disconnected during playback." });
        stop();
        return;
      }

      const midi = SheetOCR.noteToMidi(n.note);
      if (midi !== null) {
        sendNoteOn(midi);
        setTimeout(() => {
          if (isConnected()) sendNoteOff(midi);
        }, durMs);
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
    bleWriteQueue = [];
    if (isConnected()) allNotesOff();
    emit("midi:progress", { ratio: 0 });
  }

  // ── Chord Playback ────────────────────────────────────────────────────
  let chordPlaybackCancelled = false;
  let chordPlaying = false;
  let currentRhythm = 'block';

  const RHYTHM_NAMES = ['block', 'stride', 'boogie', 'arpeggiated', 'syncopated', 'pulse'];

  function setRhythm(name) {
    if (RHYTHM_NAMES.includes(name)) currentRhythm = name;
  }

  function getRhythm() {
    return currentRhythm;
  }

  function getRhythmNames() {
    return RHYTHM_NAMES.slice();
  }

  // ── Helper functions for authentic piano patterns ─────────────────────

  // Get the root note name from a chord name (e.g. "Cmaj7" -> "C", "F#m9" -> "F#")
  function chordRoot(chordName) {
    const match = (chordName || '').match(/^([A-G][b#]?)/);
    return match ? match[1] : 'C';
  }

  // Get MIDI number for a note name at a specific octave (e.g. noteAt("C", 2) = 36)
  function noteAt(name, octave) {
    return typeof ChordMaker !== 'undefined' ? ChordMaker.noteToMidi(name + octave) : null;
  }

  // Get semitone intervals above root for chord quality
  function getChordIntervals(chordName) {
    if (!chordName) return [0, 4, 7];
    if (chordName.includes('dim'))  return [0, 3, 6];
    if (chordName.includes('aug'))  return [0, 4, 8];
    if (chordName.includes('m7b5')) return [0, 3, 6, 10];
    if (chordName.includes('m7') || chordName.includes('min7') || chordName.includes('m9') || chordName.includes('m11')) return [0, 3, 7, 10];
    if (chordName.includes('m') || chordName.includes('min')) return [0, 3, 7];
    if (chordName.includes('7') || chordName.includes('9') || chordName.includes('13')) return [0, 4, 7, 10];
    if (chordName.includes('maj7') || chordName.includes('maj9')) return [0, 4, 7, 11];
    if (chordName.includes('sus4')) return [0, 5, 7];
    if (chordName.includes('sus2')) return [0, 2, 7];
    return [0, 4, 7];
  }

  // ── Rhythm pattern generators ──────────────────────────────────────────
  // Each returns an array of { offsetMs, notes, velocity, durationMs }
  // RULES: bass always octave 2 (MIDI 36-47), chord stabs octave 3-4 (48-71),
  //        right-hand treble octave 4-5 (60-83).

  // block: simple all-notes-on hold
  function patternBlock(chordName, midiNotes, beats, msPerBeat) {
    const holdMs = beats * msPerBeat * 0.9;
    return [{ offsetMs: 0, notes: midiNotes, velocity: 75, durationMs: holdMs }];
  }

  // stride: Mrs Mills / pub piano left-hand stride pattern
  function patternStride(chordName, midiNotes, beats, msPerBeat) {
    const root      = chordRoot(chordName);
    const intervals = getChordIntervals(chordName);
    const rootOct2  = noteAt(root, 2);  // e.g. C2 = 36
    if (rootOct2 === null) return patternBlock(chordName, midiNotes, beats, msPerBeat);

    // Fifth interval above root (3rd slot in intervals array, else 7 semitones)
    const fifthInterval = intervals.length >= 3 ? intervals[2] : 7;
    const fifthOct2     = rootOct2 + fifthInterval;  // e.g. G2 = 43

    // Chord stab: upper tones in octave 3 (skip root, use 3rd and above)
    const rootOct3  = rootOct2 + 12;                               // e.g. C3 = 48
    const chordStab = intervals.slice(1).map(i => rootOct3 + i);  // E3, G3, Bb3 ...

    const swingLong  = msPerBeat * 0.6;  // beats 1&3 duration
    const swingShort = msPerBeat * 0.4;  // beats 2&4 duration
    const events     = [];

    for (let b = 0; b < beats; b++) {
      const offset = b * msPerBeat;
      const beat4  = b % 4;
      if (beat4 === 0) {
        // Beat 1: root + octave above (C2 + C3)
        events.push({ offsetMs: offset, notes: [rootOct2, rootOct2 + 12], velocity: 85, durationMs: swingLong });
      } else if (beat4 === 1) {
        // Beat 2: chord stab in middle register (E3+G3+...)
        events.push({ offsetMs: offset, notes: chordStab.length ? chordStab : midiNotes, velocity: 65, durationMs: swingShort });
      } else if (beat4 === 2) {
        // Beat 3: fifth + octave above (G2 + G3)
        events.push({ offsetMs: offset, notes: [fifthOct2, fifthOct2 + 12], velocity: 85, durationMs: swingLong });
      } else {
        // Beat 4: chord stab again
        events.push({ offsetMs: offset, notes: chordStab.length ? chordStab : midiNotes, velocity: 65, durationMs: swingShort });
      }
    }
    return events;
  }

  // boogie: boogie-woogie walking bass + off-beat chord stabs
  function patternBoogie(chordName, midiNotes, beats, msPerBeat) {
    const root      = chordRoot(chordName);
    const intervals = getChordIntervals(chordName);
    const rootOct2  = noteAt(root, 2);  // e.g. C2 = 36
    if (rootOct2 === null) return patternBlock(chordName, midiNotes, beats, msPerBeat);

    // Walking bass intervals (semitones): root-3rd-5th-6th-b7-6th-5th-3rd
    const walkIntervals = [0, 4, 7, 9, 10, 9, 7, 4];

    // Treble stab: prefer AI voicing filtered to octave 4-5, else build from intervals
    const rootOct4  = noteAt(root, 4) || 60;  // e.g. C4 = 60
    const upperRaw  = midiNotes.filter(n => n >= 60 && n <= 83);
    const stabNotes = upperRaw.length >= 2
      ? upperRaw
      : intervals.slice(1).map(i => rootOct4 + i);

    const events       = [];
    const totalEighths = beats * 2;

    for (let e = 0; e < totalEighths; e++) {
      const beatNum = Math.floor(e / 2);
      const subBeat = e % 2;
      // Swing: first eighth of each beat = 60%, second = 40%
      const offset   = beatNum * msPerBeat + (subBeat === 0 ? 0 : msPerBeat * 0.6);
      const duration = (subBeat === 0 ? msPerBeat * 0.6 : msPerBeat * 0.4) * 0.85;

      // Walking bass — slight accent on beats 1 and 3
      const bassNote = rootOct2 + walkIntervals[e % walkIntervals.length];
      const isAccent = subBeat === 0 && (beatNum === 0 || beatNum === 2);
      events.push({ offsetMs: offset, notes: [bassNote], velocity: isAccent ? 85 : 80, durationMs: duration });

      // Chord stab on beats 2 and 4 (beatNum=1 or 3, subBeat=0)
      if (subBeat === 0 && (beatNum === 1 || beatNum === 3) && stabNotes.length) {
        events.push({ offsetMs: offset, notes: stabNotes, velocity: 70, durationMs: msPerBeat * 0.4 });
      }
    }
    return events;
  }

  // arpeggiated: bottom-to-top sweep with legato overlap and velocity crescendo
  function patternArpeggiated(chordName, midiNotes, beats, msPerBeat) {
    const sorted = midiNotes.slice().sort((a, b) => a - b);
    if (sorted.length === 0) return patternBlock(chordName, midiNotes, beats, msPerBeat);
    const totalMs  = beats * msPerBeat;
    const noteStep = totalMs / sorted.length;
    return sorted.map((note, i) => ({
      offsetMs:   i * noteStep,
      notes:      [note],
      velocity:   Math.round(55 + (25 * i / Math.max(1, sorted.length - 1))),  // 55 → 80
      durationMs: noteStep * 1.5,  // slight overlap for legato feel
    }));
  }

  // syncopated: gospel feel with off-beat accents
  function patternSyncopated(chordName, midiNotes, beats, msPerBeat) {
    const root     = chordRoot(chordName);
    const intervals = getChordIntervals(chordName);
    const rootOct2  = noteAt(root, 2);        // bass root in octave 2
    const rootOct4  = noteAt(root, 4) || 60;  // e.g. C4 = 60

    // Upper chord tones: prefer AI voicing filtered to octave 4-5, else build from intervals
    const upperRaw  = midiNotes.filter(n => n >= 60 && n <= 83);
    const upperStab = upperRaw.length >= 2
      ? upperRaw
      : intervals.slice(1).map(i => rootOct4 + i);

    // Full chord: use all midiNotes (AI voicing)
    const fullChord = midiNotes.length >= 2 ? midiNotes : intervals.map(i => rootOct4 + i);
    const bassNote  = rootOct2 !== null ? rootOct2 : rootOct4;

    const events = [];

    // Beat 1: full chord, strong
    events.push({ offsetMs: 0, notes: fullChord, velocity: 85, durationMs: msPerBeat * 0.75 });

    // And-of-2 (1.5 beats from start): syncopated chord stab
    events.push({ offsetMs: msPerBeat * 1.5, notes: upperStab, velocity: 70, durationMs: msPerBeat * 0.3 });

    if (beats >= 3) {
      // Beat 3: bass note only
      events.push({ offsetMs: msPerBeat * 2, notes: [bassNote], velocity: 75, durationMs: msPerBeat * 0.5 });

      // And-of-3 (2.5 beats from start): upper chord stab
      events.push({ offsetMs: msPerBeat * 2.5, notes: upperStab, velocity: 65, durationMs: msPerBeat * 0.25 });
    }

    if (beats >= 4) {
      // Beat 4: light ghost chord
      events.push({ offsetMs: msPerBeat * 3, notes: fullChord, velocity: 45, durationMs: msPerBeat * 0.4 });
    }

    return events;
  }

  // pulse: driving worship eighth-note pulse with dynamic accents
  function patternPulse(chordName, midiNotes, beats, msPerBeat) {
    const velocities   = [70, 45, 55, 45, 65, 45, 55, 45];
    const eighthMs     = msPerBeat / 2;
    const totalEighths = beats * 2;
    const events       = [];
    for (let e = 0; e < totalEighths; e++) {
      events.push({
        offsetMs:   e * eighthMs,
        notes:      midiNotes,
        velocity:   velocities[e % velocities.length],
        durationMs: eighthMs * 0.7,  // slight staccato for that driving feel
      });
    }
    return events;
  }

  function buildRhythmEvents(rhythmName, chordName, midiNotes, beats, msPerBeat) {
    switch (rhythmName) {
      case 'stride':      return patternStride(chordName, midiNotes, beats, msPerBeat);
      case 'boogie':      return patternBoogie(chordName, midiNotes, beats, msPerBeat);
      case 'arpeggiated': return patternArpeggiated(chordName, midiNotes, beats, msPerBeat);
      case 'syncopated':  return patternSyncopated(chordName, midiNotes, beats, msPerBeat);
      case 'pulse':       return patternPulse(chordName, midiNotes, beats, msPerBeat);
      default:            return patternBlock(chordName, midiNotes, beats, msPerBeat);
    }
  }

  async function playChord(midiNotes, durationMs) {
    if (!isConnected()) return;
    const velocity = 75;
    midiNotes.forEach(n => sendNoteOn(n, velocity));
    return new Promise(resolve => {
      setTimeout(() => {
        midiNotes.forEach(n => sendNoteOff(n));
        resolve();
      }, Math.max(50, durationMs));
    });
  }

  async function playChordProgression(chords, bpmVal, rhythmOverride) {
    if (!isConnected()) {
      emit('midi:error', { message: 'No MIDI device connected.' });
      return;
    }
    if (!chords || chords.length === 0) {
      emit('midi:error', { message: 'No chords to play.' });
      return;
    }

    chordPlaybackCancelled = false;
    chordPlaying = true;
    const bpmToUse  = bpmVal || 80;
    const msPerBeat = (60 / bpmToUse) * 1000;
    const rhythmName = rhythmOverride || currentRhythm;

    for (let i = 0; i < chords.length; i++) {
      if (chordPlaybackCancelled) break;
      const chord = chords[i];
      const midiNotes = (chord.notes || [])
        .map(n => (typeof ChordMaker !== 'undefined' ? ChordMaker.noteToMidi(n) : null))
        .filter(n => n !== null);
      const beats = chord.beats || 4;
      const totalChordMs = beats * msPerBeat;
      const gapMs = totalChordMs * 0.05;

      emit('midi:chord-start', { index: i, chord });

      if (midiNotes.length === 0) {
        await new Promise(r => setTimeout(r, totalChordMs));
        continue;
      }

      const events = buildRhythmEvents(rhythmName, chord.name || '', midiNotes, beats, msPerBeat);

      await new Promise(resolve => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };

        events.forEach(ev => {
          setTimeout(() => {
            if (!chordPlaybackCancelled && isConnected()) {
              ev.notes.forEach(n => sendNoteOn(n, ev.velocity));
              setTimeout(() => {
                if (isConnected()) ev.notes.forEach(n => sendNoteOff(n));
              }, Math.max(30, ev.durationMs));
            }
          }, ev.offsetMs);
        });

        // Resolve after total chord duration minus gap
        setTimeout(finish, totalChordMs - gapMs);
      });

      if (!chordPlaybackCancelled && i < chords.length - 1) {
        if (isConnected()) allNotesOff();
        await new Promise(r => setTimeout(r, gapMs));
      }
    }

    if (isConnected()) allNotesOff();
    chordPlaying = false;
    if (!chordPlaybackCancelled) {
      emit('midi:chord-progression-ended');
    }
  }

  function stopChordPlayback() {
    chordPlaybackCancelled = true;
    chordPlaying = false;
    if (isConnected()) allNotesOff();
    emit('midi:chord-progression-ended');
  }

  function isChordPlaying() {
    return chordPlaying;
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
    playChord,
    playChordProgression,
    stopChordPlayback,
    isChordPlaying,
    setRhythm,
    getRhythm,
    getRhythmNames,
  };
})();
