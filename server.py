"""
Piano Scanner OMR Backend
Uses oemer for accurate sheet music recognition, serves results as JSON.
"""

import os
import sys
import json
import tempfile
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Duration mapping from MusicXML type to our format
MUSICXML_DURATION_MAP = {
    "whole": "whole",
    "half": "half",
    "quarter": "quarter",
    "eighth": "eighth",
    "16th": "sixteenth",
    "32nd": "sixteenth",  # treat as sixteenth for simplicity
}

# Beat values
BEAT_VALUES = {
    "whole": 4,
    "dotted-half": 3,
    "half": 2,
    "dotted-quarter": 1.5,
    "quarter": 1,
    "eighth": 0.5,
    "sixteenth": 0.25,
}

# Note name to pitch class
STEP_TO_NUM = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def midi_to_note_name(midi_num):
    """Convert MIDI note number to scientific notation (e.g. 60 -> C4)"""
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    octave = (midi_num // 12) - 1
    note = names[midi_num % 12]
    return f"{note}{octave}"


def parse_musicxml(xml_path):
    """Parse MusicXML file and extract notes with parts."""
    tree = ET.parse(xml_path)
    root = tree.getroot()

    # Handle namespaces
    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"

    all_notes = []
    parts = root.findall(f"{ns}part")

    for part_idx, part in enumerate(parts):
        # Determine part name
        if part_idx == 0:
            part_name = "melody" if len(parts) >= 2 else "right"
        elif part_idx == 1:
            part_name = "right" if len(parts) >= 3 else "left"
        else:
            part_name = "left"

        # If only one part, call it melody
        if len(parts) == 1:
            part_name = "melody"

        current_beat = 0.0
        divisions = 1  # divisions per quarter note

        for measure in part.findall(f"{ns}measure"):
            # Check for divisions
            attrs = measure.find(f"{ns}attributes")
            if attrs is not None:
                div_el = attrs.find(f"{ns}divisions")
                if div_el is not None and div_el.text:
                    divisions = int(div_el.text)

            measure_beat = current_beat

            for elem in measure:
                tag = elem.tag.replace(ns, "")

                if tag == "note":
                    # Check if it's a rest
                    is_rest = elem.find(f"{ns}rest") is not None
                    # Check if it's a chord (no forward movement)
                    is_chord = elem.find(f"{ns}chord") is not None

                    # Get duration in divisions
                    dur_el = elem.find(f"{ns}duration")
                    duration_divs = int(dur_el.text) if dur_el is not None and dur_el.text else divisions

                    # Convert to beats (quarter note = 1 beat)
                    duration_beats = duration_divs / divisions

                    # Get note type
                    type_el = elem.find(f"{ns}type")
                    note_type = type_el.text if type_el is not None else "quarter"

                    # Check for dot
                    is_dotted = elem.find(f"{ns}dot") is not None

                    # Map duration
                    dur_name = MUSICXML_DURATION_MAP.get(note_type, "quarter")
                    if is_dotted:
                        if dur_name == "half":
                            dur_name = "dotted-half"
                        elif dur_name == "quarter":
                            dur_name = "dotted-quarter"

                    if not is_rest:
                        # Get pitch
                        pitch_el = elem.find(f"{ns}pitch")
                        if pitch_el is not None:
                            step = pitch_el.find(f"{ns}step")
                            octave = pitch_el.find(f"{ns}octave")
                            alter = pitch_el.find(f"{ns}alter")

                            if step is not None and octave is not None:
                                step_name = step.text
                                oct_num = int(octave.text)
                                alter_val = int(float(alter.text)) if alter is not None and alter.text else 0

                                # Build note name
                                if alter_val == 1:
                                    note_name = f"{step_name}#{oct_num}"
                                elif alter_val == -1:
                                    note_name = f"{step_name}b{oct_num}"
                                else:
                                    note_name = f"{step_name}{oct_num}"

                                note_entry = {
                                    "note": note_name,
                                    "duration": dur_name,
                                    "startBeat": round(current_beat, 4),
                                    "part": part_name,
                                }
                                all_notes.append(note_entry)

                    # Advance beat (unless chord)
                    if not is_chord:
                        current_beat += duration_beats

                elif tag == "forward":
                    dur_el = elem.find(f"{ns}duration")
                    if dur_el is not None and dur_el.text:
                        current_beat += int(dur_el.text) / divisions

                elif tag == "backup":
                    dur_el = elem.find(f"{ns}duration")
                    if dur_el is not None and dur_el.text:
                        current_beat -= int(dur_el.text) / divisions

    # Sort by startBeat, then by part order
    part_order = {"melody": 0, "right": 1, "left": 2}
    all_notes.sort(key=lambda n: (n["startBeat"], part_order.get(n["part"], 9)))

    return all_notes


def detect_score_info(xml_path):
    """Extract key, time sig, tempo from MusicXML."""
    tree = ET.parse(xml_path)
    root = tree.getroot()
    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"

    info = {"key": "", "timeSignature": "", "tempo": None, "clef": "treble"}

    # Find first attributes element
    for attrs in root.iter(f"{ns}attributes"):
        # Key
        key_el = attrs.find(f"{ns}key")
        if key_el is not None:
            fifths = key_el.find(f"{ns}fifths")
            if fifths is not None and fifths.text:
                key_map = {
                    -7: "Cb", -6: "Gb", -5: "Db", -4: "Ab", -3: "Eb",
                    -2: "Bb", -1: "F", 0: "C", 1: "G", 2: "D",
                    3: "A", 4: "E", 5: "B", 6: "F#", 7: "C#"
                }
                info["key"] = key_map.get(int(fifths.text), "C")

        # Time
        time_el = attrs.find(f"{ns}time")
        if time_el is not None:
            beats = time_el.find(f"{ns}beats")
            beat_type = time_el.find(f"{ns}beat-type")
            if beats is not None and beat_type is not None:
                info["timeSignature"] = f"{beats.text}/{beat_type.text}"
        break

    # Tempo from direction
    for direction in root.iter(f"{ns}direction"):
        sound = direction.find(f"{ns}sound")
        if sound is not None and "tempo" in sound.attrib:
            info["tempo"] = float(sound.attrib["tempo"])
            break

    # Count parts for clef type
    parts = root.findall(f"{ns}part")
    if len(parts) >= 3:
        info["clef"] = "vocal+piano"
    elif len(parts) == 2:
        info["clef"] = "grand"

    return info


@app.route("/api/analyze", methods=["POST"])
def analyze():
    """Accept an image file, run oemer, return notes JSON."""
    if "image" not in request.files:
        return jsonify({"error": "No image file provided"}), 400

    image_file = request.files["image"]

    with tempfile.TemporaryDirectory() as tmpdir:
        # Save uploaded image
        img_path = os.path.join(tmpdir, "input.jpg")
        image_file.save(img_path)

        # Run oemer
        output_dir = os.path.join(tmpdir, "output")
        os.makedirs(output_dir, exist_ok=True)

        try:
            # Get the venv python path
            venv_python = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "venv", "bin", "python"
            )
            result = subprocess.run(
                [venv_python, "-m", "oemer", img_path, "-o", output_dir],
                capture_output=True,
                text=True,
                timeout=120,
            )

            if result.returncode != 0:
                return jsonify({
                    "error": f"oemer failed: {result.stderr[-500:] if result.stderr else 'unknown error'}"
                }), 500

            # Find the MusicXML output
            xml_files = list(Path(output_dir).glob("**/*.musicxml")) + \
                        list(Path(output_dir).glob("**/*.xml"))

            if not xml_files:
                return jsonify({"error": "oemer produced no MusicXML output"}), 500

            xml_path = str(xml_files[0])

            # Parse MusicXML into our note format
            notes = parse_musicxml(xml_path)
            score_info = detect_score_info(xml_path)

            return jsonify({
                "notes": notes,
                "scoreInfo": score_info,
                "noteCount": len(notes),
            })

        except subprocess.TimeoutExpired:
            return jsonify({"error": "oemer timed out (120s limit)"}), 500
        except Exception as e:
            return jsonify({"error": str(e)}), 500


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "engine": "oemer"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5111))
    print(f"🎹 Piano Scanner OMR server starting on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
