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

    const styleGuide = {
      pop: 'Use progressions like: I-V-vi-IV, vi-IV-I-V, I-IV-vi-V. Add 7ths sparingly. Think Ed Sheeran, Adele, Coldplay.',
      jazz: 'Use ii-V-I movements, tritone subs, secondary dominants, diminished passing chords. Think Bill Evans, Coltrane. Use maj7, min7, dom7, m7b5, dim7, 9, 13 chords. Voice lead smoothly.',
      gospel: `Gospel piano is defined by: (1) Extended chords everywhere - use maj9, min9, dom9, dom13, min11, add9 - NEVER plain triads. (2) The 2-5-1 (ii-V-I) is the backbone - approach EVERY target chord with its ii-V. (3) Diminished passing chords between diatonic chords (e.g. I - #Idim7 - ii). (4) The gospel turnaround: I - I7 - IV - iv(minor) - I. (5) Chromatic bass walks: C - C/Bb - Am7 - Ab7 - G7. (6) Secondary dominants: use V7/ii, V7/V, V7/vi freely. (7) The "shout" feel: I - IV/I (bass stays on 1). (8) Common gospel moves in C: Cmaj9 - C#dim7 - Dm9 - G13 - Cmaj9, or Cmaj9 - Am9 - Dm11 - Db9 - Cmaj9, or Fmaj9 - Fm9 - Em7 - A7b9 - Dm9 - G13sus - G13 - Cmaj9. (9) Use 7#9, 7b9, 7b13 on dominant chords for that gospel crunch. (10) Voice the piano with bass note in octave 2, then a cluster of 3-4 notes in octave 3-4 close together.`,
      classical: 'Use functional harmony: I-IV-V-I, vi-ii-V-I, with suspensions, passing tones, and Neapolitan/augmented 6th chords for color.',
      'lo-fi': 'Use jazzy extended chords with a lazy feel: maj7, min7, dom9, add9. Borrow chords from parallel minor. Think Nujabes, lo-fi hip hop. Example: Dmaj7 - Gmaj7 - Bm7 - F#m7 - Em9.',
      worship: `Modern worship piano: (1) Open voicings with lots of space - root in octave 2, 5th and octave in octave 3, add color tones (9, 4sus) in octave 4. (2) Common moves: I - IV(add9) - vi7 - V, or I - V/3rd - vi - IV, or I - Vsus4 - V - vi - IV. (3) Use sus4 and sus2 chords that resolve. (4) Pedal bass - keep the root in the bass while chords change above (e.g. C/G - Am/G - F/G - G). (5) The "Hillsong" sound: Cadd9 - G/B - Am7 - Fsus2. (6) Build intensity: start simple, add extensions as you go. (7) Think Bethel Music, Elevation Worship, Maverick City. (8) Use slash chords for bass movement: C - C/E - F - F/A - G/B - C.`,
    };

    const guide = styleGuide[style] || styleGuide.pop;

    const prompt = `You are a world-class songwriter and music theory expert. Generate a ${bars}-bar chord progression in the key of ${key} with a ${mood} mood in ${style} style.

STYLE GUIDE: ${guide}

Return ONLY a valid JSON array — no markdown, no explanation, just raw JSON.

Each chord: {"name":"Cmaj7","notes":["C3","E3","G3","B3"],"roman":"Imaj7","beats":4}

Fields:
- name: chord symbol (e.g. Cmaj7, Am9, Dm7, G7sus4, Bb/D)
- notes: 4-5 note piano voicing with octave numbers. Bass note in octave 2-3, upper voices in octave 3-5. Use proper voice leading between chords — move each voice to the nearest available note.
- roman: Roman numeral (e.g. Imaj7, ii7, V7, IVadd9, bVII)
- beats: 4 (one bar of 4/4)

CRITICAL:
- Do NOT just repeat I-IV-V-I. Be creative and use the style guide.
- Use INVERSIONS for smooth bass lines (e.g. C/E, Am/C, G/B)
- Vary the rhythm: some chords can last 2 bars (beats:8) or half a bar (beats:2)
- End on or resolve toward the I chord
- Make it sound like a REAL song, not a theory exercise${lockedSection}

Generate exactly ${bars} bars worth of chords (total beats = ${bars * 4}).`;

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
            thinkingConfig: { thinkingBudget: 0 },
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
