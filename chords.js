/**
 * chords.js — AI Chord Progression Generator
 *
 * Generates chord progressions via Gemini AI and provides
 * chord-to-MIDI conversion utilities.
 */

const ChordMaker = (() => {
  'use strict';

  // ── Note → MIDI conversion ────────────────────────────────────────────
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const NOTE_ALIASES = {
    'Db': 'C#', 'Eb': 'D#', 'Fb': 'E', 'Gb': 'F#',
    'Ab': 'G#', 'Bb': 'A#', 'Cb': 'B'
  };

  function noteToMidi(noteStr) {
    if (!noteStr) return null;
    const match = noteStr.trim().match(/^([A-G][b#]?)(\d+)$/);
    if (!match) return null;
    let name = match[1];
    const octave = parseInt(match[2], 10);
    name = NOTE_ALIASES[name] || name;
    const semitone = NOTE_NAMES.indexOf(name);
    if (semitone === -1) return null;
    return (octave + 1) * 12 + semitone;
  }

  // ── Chord progression state ───────────────────────────────────────────
  let currentProgression = [];

  // ── Gemini AI call ────────────────────────────────────────────────────
  async function generateProgression({ key, style, mood, bars, lockedChords = [] }) {
    const apiKey = SheetOCR.getApiKey();
    if (!apiKey) throw new Error('No API key set. Open ⚙️ Settings and add your Gemini key.');

    // Build locked chord constraints for the prompt
    const lockedPositions = lockedChords
      .map((c, i) => c ? `  Position ${i + 1}: ${c.name} (${c.roman})` : null)
      .filter(Boolean);

    const lockedSection = lockedPositions.length > 0
      ? `\n\nIMPORTANT — These chord positions are LOCKED and must be preserved exactly as-is:\n${lockedPositions.join('\n')}\nOnly generate chords for the unlocked positions.`
      : '';

    const prompt = `You are a professional music composer. Generate a ${bars}-bar chord progression in the key of ${key} major with a ${mood} mood and ${style} style.

Return ONLY a valid JSON array — no markdown fences, no explanation, just the raw JSON array.

Each chord object must have exactly these fields:
- "name": chord name string (e.g. "Cmaj7", "Am7", "G7", "Fmaj9")
- "notes": array of note-name strings with octave numbers for piano voicing (e.g. ["C3","E3","G3","B3"]) — spread across octaves 3-5 for a full sound, avoid all notes in one octave
- "roman": Roman numeral analysis string (e.g. "Imaj7", "vim7", "V7", "IVmaj9")
- "beats": integer number of beats this chord lasts (4 for a whole bar in 4/4)

Rules:
- Generate exactly ${bars} chord objects
- Use idiomatic ${style} harmony — include extensions (7ths, 9ths, sus chords) as appropriate for the style
- Make it musically interesting with good voice leading
- The progression should feel complete and loop-able
- For gospel/worship: use lush voicings with 7ths and 9ths
- For jazz: use complex extensions, tritone subs, secondary dominants
- For pop: keep it singable with clear tonal center
- For lo-fi: use jazzy chords in a relaxed, lazy feel
- For classical: use functional harmony with passing chords${lockedSection}

Example output format:
[{"name":"Cmaj7","notes":["C3","E3","G3","B3"],"roman":"Imaj7","beats":4},{"name":"Am7","notes":["A2","E3","G3","C4"],"roman":"vim7","beats":4}]`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.85,
            maxOutputTokens: 8192,
          }
        })
      }
    );

    if (!response.ok) {
      let errText = '';
      try { errText = await response.text(); } catch (e) {}
      const snippet = errText.slice(0, 200);
      throw new Error(`Gemini API error ${response.status}: ${snippet}`);
    }

    const data = await response.json();
    // Gemini 2.5 thinking models return multiple parts — find the one with JSON
    const parts = data?.candidates?.[0]?.content?.parts || [];
    let rawText = '';
    for (const part of parts) {
      if (part.text && part.text.includes('[')) {
        rawText = part.text;
        break;
      }
    }
    if (!rawText) {
      rawText = parts.map(p => p.text || '').join('\n');
    }

    console.info('[ChordMaker] Raw AI text:', rawText.substring(0, 300));

    // Strip markdown fences aggressively
    let cleaned = rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    
    // Remove any non-JSON text before the array
    // Some responses have explanation text before/after the JSON
    cleaned = cleaned.trim();

    // Extract JSON array
    const arrayStart = cleaned.indexOf('[');
    const arrayEnd = cleaned.lastIndexOf(']');
    if (arrayStart === -1) {
      throw new Error('No chord data found in AI response. Try again.');
    }

    let jsonStr;
    if (arrayEnd === -1 || arrayEnd <= arrayStart) {
      // Truncated — salvage
      const lastBrace = cleaned.lastIndexOf('}');
      if (lastBrace > arrayStart) {
        jsonStr = cleaned.substring(arrayStart, lastBrace + 1) + ']';
      } else {
        throw new Error('AI response was truncated. Try again.');
      }
    } else {
      jsonStr = cleaned.substring(arrayStart, arrayEnd + 1);
    }

    // Fix common JSON issues
    jsonStr = jsonStr
      .replace(/,\s*]/g, ']')        // trailing commas before ]
      .replace(/,\s*}/g, '}')         // trailing commas before }
      .replace(/[\u201C\u201D]/g, '"') // smart quotes → regular quotes
      .replace(/[\u2018\u2019]/g, "'"); // smart single quotes
    
    console.info('[ChordMaker] Cleaned JSON (first 500):', jsonStr.substring(0, 500));

    let chords;
    try {
      chords = JSON.parse(jsonStr);
    } catch (e) {
      // Log the area around the error for debugging
      const posMatch = e.message.match(/position (\d+)/);
      if (posMatch) {
        const pos = parseInt(posMatch[1]);
        console.error('[ChordMaker] JSON error near:', jsonStr.substring(Math.max(0, pos - 30), pos + 30));
        console.error('[ChordMaker] Char at pos:', JSON.stringify(jsonStr[pos]), 'code:', jsonStr.charCodeAt(pos));
      }
      console.error('[ChordMaker] Full JSON string:', jsonStr);

      // Try to salvage partial
      const lastBrace = jsonStr.lastIndexOf('}');
      if (lastBrace > 0) {
        try {
          chords = JSON.parse(jsonStr.substring(0, lastBrace + 1) + ']');
          console.warn('[ChordMaker] Salvaged partial chord data');
        } catch (e2) {
          throw new Error('Could not parse chord JSON. Check browser console (F12) for details.');
        }
      } else {
        throw new Error('Could not parse chord JSON. Check browser console (F12) for details.');
      }
    }

    if (!Array.isArray(chords) || chords.length === 0) {
      throw new Error('AI returned empty or invalid chord array.');
    }

    // Merge locked chords back in (they might have been regenerated differently)
    lockedChords.forEach((locked, i) => {
      if (locked && i < chords.length) {
        chords[i] = { ...locked };
      }
    });

    // Attach lock state (carry over from previous generation)
    currentProgression = chords.map((c, i) => ({
      ...c,
      locked: (lockedChords[i] !== null && lockedChords[i] !== undefined) ? true : false,
    }));

    return currentProgression;
  }

  // ── Public API ────────────────────────────────────────────────────────
  return {
    noteToMidi,
    generateProgression,
  };
})();
