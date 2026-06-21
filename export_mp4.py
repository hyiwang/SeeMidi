import argparse
import colorsys
import math
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter
from scipy.io import wavfile


MIDI_MIN = 21
MIDI_MAX = 108
WHITE_PATTERN = {0, 2, 4, 5, 7, 9, 11}
DEFAULT_SFZ = (
    "assets/Salamander/sfz_minimum/Accurate-SalamanderGrandPiano_flat.Recommended.sfz"
)


@dataclass
class Note:
    midi: int
    velocity: int
    start_tick: int
    end_tick: int
    playback_end_tick: int
    start: float = 0.0
    end: float = 0.0
    playback_end: float = 0.0


@dataclass
class SfzRegion:
    sample: Path
    lokey: int
    hikey: int
    lovel: int
    hivel: int
    pitch_keycenter: int
    volume: float
    tune: float
    offset: int


class MidiReader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def read_u8(self) -> int:
        value = self.data[self.pos]
        self.pos += 1
        return value

    def peek_u8(self) -> int:
        return self.data[self.pos]

    def read_u16(self) -> int:
        return (self.read_u8() << 8) | self.read_u8()

    def read_u32(self) -> int:
        return (
            (self.read_u8() << 24)
            | (self.read_u8() << 16)
            | (self.read_u8() << 8)
            | self.read_u8()
        )

    def read_string(self, length: int) -> str:
        chunk = self.data[self.pos : self.pos + length]
        self.pos += length
        return chunk.decode("latin1")

    def read_varint(self) -> int:
        value = 0
        while True:
            byte = self.read_u8()
            value = (value << 7) | (byte & 0x7F)
            if not byte & 0x80:
                return value

    def skip(self, length: int) -> None:
        self.pos += length


def parse_midi(path: Path):
    reader = MidiReader(path.read_bytes())
    if reader.read_string(4) != "MThd":
        raise ValueError("Not a standard MIDI file")

    header_length = reader.read_u32()
    midi_format = reader.read_u16()
    track_count = reader.read_u16()
    division = reader.read_u16()

    if division & 0x8000:
        raise ValueError("SMPTE time division is not supported")

    reader.skip(header_length - 6)
    ticks_per_quarter = division
    tempo_events = [(0, 500000)]
    channel_events = []
    event_sequence = 0
    song_end_tick = 0

    parsed_tracks = 0
    while parsed_tracks < track_count and reader.pos + 8 <= len(reader.data):
        chunk_start = reader.pos
        chunk_id = reader.read_string(4)
        chunk_length = reader.read_u32()

        if chunk_id != "MTrk":
            next_track = reader.data.find(b"MTrk", chunk_start + 1)
            if next_track == -1:
                raise ValueError(
                    f"Corrupt MIDI track at byte {chunk_start}: found {chunk_id!r}, no later MTrk chunk"
                )
            reader.pos = next_track
            continue

        parsed_tracks += 1
        track_end = reader.pos + chunk_length
        tick = 0
        running_status = 0

        while reader.pos < track_end:
            tick += reader.read_varint()
            song_end_tick = max(song_end_tick, tick)
            status = reader.peek_u8()

            if status & 0x80:
                status = reader.read_u8()
                running_status = status
            else:
                status = running_status

            if status == 0xFF:
                meta_type = reader.read_u8()
                length = reader.read_varint()
                if meta_type == 0x51 and length == 3:
                    tempo = (reader.read_u8() << 16) | (reader.read_u8() << 8) | reader.read_u8()
                    tempo_events.append((tick, tempo))
                else:
                    reader.skip(length)
                continue

            if status in (0xF0, 0xF7):
                reader.skip(reader.read_varint())
                continue

            event_type = status >> 4
            channel = status & 0x0F
            data1 = reader.read_u8()
            data2 = None if event_type in (0xC, 0xD) else reader.read_u8()

            if event_type == 0x9 and data2 and data2 > 0:
                channel_events.append((tick, event_sequence, "note_on", channel, data1, data2))
                event_sequence += 1
            elif event_type == 0x8 or (event_type == 0x9 and data2 == 0):
                channel_events.append((tick, event_sequence, "note_off", channel, data1, 0))
                event_sequence += 1
            elif event_type == 0xB and data1 == 64:
                channel_events.append((tick, event_sequence, "sustain", channel, data1, data2 or 0))
                event_sequence += 1

        reader.pos = track_end

    if parsed_tracks == 0:
        raise ValueError("No MIDI track chunk was found")

    notes = apply_sustain(channel_events, song_end_tick)
    tempo_timeline = build_tempo_timeline(sorted(tempo_events), ticks_per_quarter)

    for note in notes:
        note.start = tick_to_seconds(note.start_tick, tempo_timeline, ticks_per_quarter)
        note.end = tick_to_seconds(note.end_tick, tempo_timeline, ticks_per_quarter)
        note.playback_end = tick_to_seconds(note.playback_end_tick, tempo_timeline, ticks_per_quarter)

    notes.sort(key=lambda note: (note.start, note.midi))
    duration = max((note.end for note in notes), default=0.0)
    playback_duration = max((note.playback_end for note in notes), default=duration)
    return {
        "format": midi_format,
        "ticks_per_quarter": ticks_per_quarter,
        "notes": notes,
        "duration": duration,
        "playback_duration": playback_duration,
    }


def apply_sustain(channel_events, song_end_tick: int):
    active_notes = {}
    sustained_notes = {}
    sustain_by_channel = {}
    note_events = []

    for tick, _sequence, event_type, channel, note_number, value in sorted(channel_events):
        key = (channel, note_number)

        if event_type == "note_on":
            active_notes.setdefault(key, []).append(
                {
                    "channel": channel,
                    "midi": note_number,
                    "velocity": value,
                    "start_tick": tick,
                }
            )
        elif event_type == "note_off":
            stack = active_notes.get(key)
            if not stack:
                continue
            note = stack.pop()
            if sustain_by_channel.get(channel):
                note["end_tick"] = tick
                sustained_notes.setdefault(channel, []).append(note)
            elif tick > note["start_tick"] and MIDI_MIN <= note["midi"] <= MIDI_MAX:
                note_events.append(
                    Note(note["midi"], note["velocity"], note["start_tick"], tick, tick)
                )
        elif event_type == "sustain":
            is_down = value >= 64
            sustain_by_channel[channel] = is_down
            if not is_down:
                for note in sustained_notes.get(channel, []):
                    if tick > note["start_tick"] and MIDI_MIN <= note["midi"] <= MIDI_MAX:
                        note_events.append(
                            Note(note["midi"], note["velocity"], note["start_tick"], note["end_tick"], tick)
                        )
                sustained_notes[channel] = []

    for stack in active_notes.values():
        for note in stack:
            if song_end_tick > note["start_tick"] and MIDI_MIN <= note["midi"] <= MIDI_MAX:
                note_events.append(
                    Note(note["midi"], note["velocity"], note["start_tick"], song_end_tick, song_end_tick)
                )

    for pending_notes in sustained_notes.values():
        for note in pending_notes:
            if song_end_tick > note["start_tick"] and MIDI_MIN <= note["midi"] <= MIDI_MAX:
                note_events.append(
                    Note(note["midi"], note["velocity"], note["start_tick"], note["end_tick"], song_end_tick)
                )

    return note_events


def build_tempo_timeline(tempo_events, ticks_per_quarter: int):
    timeline = [(0, 0.0, tempo_events[0][1])]
    last_tick = 0
    seconds = 0.0
    current_tempo = tempo_events[0][1]

    for tick, tempo in tempo_events[1:]:
        seconds += ((tick - last_tick) * current_tempo) / (ticks_per_quarter * 1_000_000)
        timeline.append((tick, seconds, tempo))
        last_tick = tick
        current_tempo = tempo

    return timeline


def tick_to_seconds(target_tick: int, timeline, ticks_per_quarter: int):
    current_tick, current_seconds, current_tempo = timeline[0]
    for tick, seconds, tempo in timeline:
        if tick > target_tick:
            break
        current_tick, current_seconds, current_tempo = tick, seconds, tempo

    return current_seconds + ((target_tick - current_tick) * current_tempo) / (
        ticks_per_quarter * 1_000_000
    )


@lru_cache(maxsize=4)
def parse_sfz(path: Path):
    regions = []
    current_tag = ""
    group_opcodes = {}

    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = re.sub(r"//.*$", "", raw_line).strip()
        if not line:
            continue

        if line.startswith("<"):
            tags = re.findall(r"<([^>]+)>", line)
            if not tags:
                continue

            current_tag = tags[-1].lower()
            opcodes = parse_opcodes(re.sub(r"<[^>]+>", " ", line))
            if current_tag == "group":
                group_opcodes = opcodes
            elif current_tag == "region":
                merged = {**group_opcodes, **opcodes}
                sample = merged.get("sample")
                if not sample:
                    continue
                regions.append(region_from_opcodes(merged, path.parent))
            continue

        if current_tag == "group":
            group_opcodes.update(parse_opcodes(line))

    return regions


def parse_opcodes(text: str):
    return {key.lower(): value for key, value in re.findall(r"([A-Za-z0-9_]+)=([^\s]+)", text)}


def region_from_opcodes(opcodes, base_dir: Path):
    sample_path = base_dir / opcodes["sample"].replace("\\", "/")
    return SfzRegion(
        sample=sample_path.resolve(),
        lokey=int(opcodes.get("lokey", opcodes.get("key", MIDI_MIN))),
        hikey=int(opcodes.get("hikey", opcodes.get("key", MIDI_MAX))),
        lovel=int(opcodes.get("lovel", 1)),
        hivel=int(opcodes.get("hivel", 127)),
        pitch_keycenter=int(opcodes.get("pitch_keycenter", opcodes.get("key", MIDI_MIN))),
        volume=float(opcodes.get("volume", 0)),
        tune=float(opcodes.get("tune", 0)),
        offset=int(float(opcodes.get("offset", 0))),
    )


def find_region(regions, midi: int, velocity: int):
    for region in regions:
        if region.lokey <= midi <= region.hikey and region.lovel <= velocity <= region.hivel:
            return region
    return None


def read_sample(path: Path, cache):
    if path in cache:
        return cache[path]

    sample_rate, data = wavfile.read(path)
    if data.ndim == 1:
        data = np.column_stack([data, data])

    if np.issubdtype(data.dtype, np.integer):
        scale = float(max(abs(np.iinfo(data.dtype).min), np.iinfo(data.dtype).max))
        data = data.astype(np.float32) / scale
    else:
        data = data.astype(np.float32)

    cache[path] = (sample_rate, data)
    return cache[path]


def synthesize_audio(
    notes,
    regions,
    output_wav: Path,
    sample_rate: int,
    duration: float,
    auto_sustain: bool = False,
    auto_sustain_seconds: float = 0.5,
):
    total_samples = int(math.ceil((duration + 0.25) * sample_rate))
    mix = np.zeros((total_samples, 2), dtype=np.float32)
    sample_cache = {}

    for note in notes:
        region = find_region(regions, note.midi, note.velocity)
        if not region:
            continue

        source_rate, sample = read_sample(region.sample, sample_cache)
        playback_rate = (2 ** ((note.midi - region.pitch_keycenter) / 12)) * (2 ** (region.tune / 1200))
        start_index = int(round(note.start * sample_rate))
        playback_end = get_note_playback_end(note, auto_sustain, auto_sustain_seconds)
        end_time = playback_end + 0.045
        target_len = max(1, int(round((end_time - note.start) * sample_rate)))
        sample_offset = max(0, region.offset)

        source_positions = sample_offset + np.arange(target_len, dtype=np.float64) * playback_rate * (
            source_rate / sample_rate
        )
        valid = source_positions < (len(sample) - 1)
        if not np.any(valid):
            continue

        source_positions = source_positions[valid]
        segment_len = len(source_positions)
        left = np.interp(source_positions, np.arange(len(sample)), sample[:, 0])
        right = np.interp(source_positions, np.arange(len(sample)), sample[:, 1])
        segment = np.column_stack([left, right]).astype(np.float32)

        velocity = note.velocity / 127
        gain = max(0.02, 0.06 + velocity * 0.18) * (10 ** (region.volume / 20))
        segment *= gain

        attack = min(segment_len, int(0.008 * sample_rate))
        release = min(segment_len, int(0.045 * sample_rate))
        if attack > 1:
            segment[:attack] *= np.linspace(0.0001, 1.0, attack, dtype=np.float32)[:, None]
        if release > 1:
            segment[-release:] *= np.linspace(1.0, 0.0001, release, dtype=np.float32)[:, None]

        out_end = min(total_samples, start_index + segment_len)
        if out_end > start_index:
            mix[start_index:out_end] += segment[: out_end - start_index]

    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    if peak > 0.98:
        mix *= 0.98 / peak

    wavfile.write(output_wav, sample_rate, np.int16(np.clip(mix, -1, 1) * 32767))


def get_note_playback_end(note, auto_sustain: bool, auto_sustain_seconds: float = 0.5):
    if not auto_sustain:
        return note.playback_end
    return max(note.playback_end, note.end + max(0, min(1, auto_sustain_seconds)))


def get_playback_duration(notes, base_duration: float, auto_sustain: bool, auto_sustain_seconds: float = 0.5):
    if not auto_sustain:
        return base_duration
    return max([base_duration, *(get_note_playback_end(note, True, auto_sustain_seconds) for note in notes)])


def build_keyboard(width: int):
    keys = []
    white_index = 0
    white_width = width / 52
    for midi in range(MIDI_MIN, MIDI_MAX + 1):
        is_white = midi % 12 in WHITE_PATTERN
        if is_white:
            x = white_index * white_width
            key = {"midi": midi, "is_white": True, "x": x, "width": white_width}
            white_index += 1
        else:
            x = white_index * white_width - white_width * 0.5
            key = {"midi": midi, "is_white": False, "x": x, "width": white_width}
        keys.append(key)
    return keys


def note_lane(key):
    if key["is_white"]:
        return key["x"], key["width"]
    black_width = key["width"] * 0.64
    center_x = key["x"] + key["width"] / 2
    return center_x - black_width / 2, black_width


def active_velocities(notes, current_time: float):
    active = {}
    for note in notes:
        if note.start <= current_time <= note.end:
            active[note.midi] = max(active.get(note.midi, 0), note.velocity / 127)
    return active


def draw_bottom_rounded_rectangle(image, rect, radius: float, fill):
    left, top, right, bottom = rect
    radius = max(0, min(radius, (right - left) / 2, (bottom - top) / 2))
    image_width, image_height = image.size
    bounds = (
        max(0, int(math.floor(left - 1))),
        max(0, int(math.floor(top))),
        min(image_width, int(math.ceil(right + 1))),
        min(image_height, int(math.ceil(bottom + 1))),
    )
    bound_left, bound_top, bound_right, bound_bottom = bounds
    if bound_right <= bound_left or bound_bottom <= bound_top:
        return

    scale = 4
    high_size = ((bound_right - bound_left) * scale, (bound_bottom - bound_top) * scale)
    high = Image.new("RGBA", high_size, (0, 0, 0, 0))
    high_draw = ImageDraw.Draw(high, "RGBA")
    scaled_rect = [
        (left - bound_left) * scale,
        (top - bound_top) * scale,
        (right - bound_left) * scale,
        (bottom - bound_top) * scale,
    ]
    scaled_radius = radius * scale
    if scaled_radius > 0:
        high_draw.rectangle(
            [scaled_rect[0], scaled_rect[1], scaled_rect[2], scaled_rect[3] - scaled_radius],
            fill=fill,
        )
        high_draw.rounded_rectangle(
            [scaled_rect[0], scaled_rect[3] - scaled_radius * 2, scaled_rect[2], scaled_rect[3]],
            radius=scaled_radius,
            fill=fill,
        )
    else:
        high_draw.rectangle(scaled_rect, fill=fill)
    low = high.resize((bound_right - bound_left, bound_bottom - bound_top), Image.Resampling.LANCZOS)
    image.alpha_composite(low, (bound_left, bound_top))


def build_render_cache(width: int, height: int, background_image=None, background_opacity: float = 0.0, background_base: str = "default", show_grid: bool = False):
    background_base = "black" if background_base == "black" else "default"
    image = Image.new("RGB", (width, height), "#000000" if background_base == "black" else "#07111f")
    draw = ImageDraw.Draw(image, "RGBA")
    piano_height = max(140, min(190, int(height * 0.2)))
    waterfall_height = height - piano_height
    pixels_per_second = max(110, waterfall_height / 4.2)
    keyboard = build_keyboard(width)

    if background_base == "default":
        for y in range(height):
            ratio = y / max(1, height - 1)
            r = int(7 * (1 - ratio) + 21 * ratio)
            g = int(17 * (1 - ratio) + 48 * ratio)
            b = int(31 * (1 - ratio) + 81 * ratio)
            draw.line([(0, y), (width, y)], fill=(r, g, b, 255))

    if background_image is not None and background_opacity > 0:
        image = composite_background_image(image, background_image, background_opacity)
        draw = ImageDraw.Draw(image, "RGBA")

    if show_grid:
        grid_alpha = 44 if background_base == "black" else 16
        grid_mask = Image.new("L", (width, height), 0)
        grid_draw = ImageDraw.Draw(grid_mask)
        for key in keyboard:
            if key["is_white"]:
                grid_draw.line([(key["x"], 0), (key["x"], waterfall_height)], fill=grid_alpha)

        beat_spacing = pixels_per_second
        y = waterfall_height
        while y > 0:
            grid_draw.line([(0, y), (width, y)], fill=grid_alpha)
            y -= beat_spacing
        grid_layer = Image.new("RGBA", (width, height), (255, 255, 255, 0))
        grid_layer.putalpha(grid_mask)
        image = image.convert("RGBA")
        image.alpha_composite(grid_layer)
        draw = ImageDraw.Draw(image, "RGBA")

    keyboard_base = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    keyboard_draw = ImageDraw.Draw(keyboard_base, "RGBA")
    black_key_base = Image.new("RGBA", (width, height), (0, 0, 0, 0))

    for key in keyboard:
        if not key["is_white"]:
            continue
        keyboard_draw.rectangle([key["x"], waterfall_height, key["x"] + key["width"], height], fill=(249, 251, 255, 255))
        keyboard_draw.rectangle([key["x"], waterfall_height, key["x"] + key["width"], height], outline=(13, 26, 45, 140))

    for key in keyboard:
        if key["is_white"]:
            continue
        x, black_width = note_lane(key)
        black_height = piano_height * 0.63
        draw_bottom_rounded_rectangle(
            black_key_base,
            [x, waterfall_height, x + black_width, waterfall_height + black_height],
            7,
            (12, 20, 34, 255),
        )
    keyboard_base.alpha_composite(black_key_base)

    return {
        "base": image.convert("RGBA"),
        "keyboard_base": keyboard_base,
        "black_key_base": black_key_base,
        "note_sprite_cache": {},
        "piano_height": piano_height,
        "waterfall_height": waterfall_height,
        "pixels_per_second": pixels_per_second,
        "keyboard": keyboard,
        "width": width,
        "height": height,
    }


def render_frame(
    notes,
    width: int,
    height: int,
    current_time: float,
    background_image=None,
    background_opacity: float = 0.0,
    background_base: str = "default",
    note_color: str = "#2de1b4",
    show_grid: bool = False,
    visual_effect: str = "none",
    fog_quality: str = "medium",
    render_cache=None,
):
    visual_effects = normalize_visual_effects(visual_effect)
    cache = render_cache or build_render_cache(width, height, background_image, background_opacity, background_base, show_grid)
    image = cache["base"].copy()
    draw = ImageDraw.Draw(image, "RGBA")
    piano_height = cache["piano_height"]
    waterfall_height = cache["waterfall_height"]
    pixels_per_second = cache["pixels_per_second"]
    keyboard = cache["keyboard"]
    active = active_velocities(notes, current_time)

    min_visible = current_time - 0.25
    max_visible = current_time + waterfall_height / pixels_per_second + 0.4
    for note in notes:
        if note.end < min_visible or note.start > max_visible:
            continue
        key = keyboard[note.midi - MIDI_MIN]
        x, lane_width = note_lane(key)
        note_top = waterfall_height - (note.end - current_time) * pixels_per_second
        note_bottom = waterfall_height - (note.start - current_time) * pixels_per_second
        y0 = max(0, note_top)
        y1 = min(waterfall_height, note_bottom)
        if y1 <= y0:
            continue
        velocity = note.velocity / 127
        color_hsl = velocity_note_hsl(note_color, velocity, note.midi, current_time, "colorShift" in visual_effects)
        color = velocity_note_color(note_color, velocity, note.midi, current_time, "colorShift" in visual_effects)
        if "trail" in visual_effects:
            draw_note_trail(image, x, lane_width, y0, y1, waterfall_height, velocity, color)
        note_width = max(2, lane_width - 2)
        note_height = y1 - y0
        note_radius = max(1, min(8, lane_width / 3, note_width / 2, note_height / 2))
        note_rect = [x + 1, y0, x + lane_width - 1, y1]
        if "colorShift" not in visual_effects:
            if "glow" in visual_effects:
                draw_canvas_note_shadow(image, note_rect, note_radius, velocity, color)
            draw_note_body_cached(image, note_rect, note_radius, color_hsl, cache["note_sprite_cache"])
            if "glow" in visual_effects:
                edge_color = glow_edge_color(color, velocity)
                edge_width = max(1, min(3, int(note_width * 0.12), max(1, int(note_height * 0.45))))
                draw_smooth_inner_note_edge(image, note_rect, note_radius, edge_width, edge_color)
        else:
            draw_note_body(image, note_rect, note_radius, color, color_hsl, waterfall_height, velocity, "glow" in visual_effects)

    if "fog" in visual_effects:
        draw_impact_fogs(image, notes, keyboard, waterfall_height, current_time, note_color, "colorShift" in visual_effects, fog_quality)
    if "stream" in visual_effects:
        draw_impact_streams(image, notes, keyboard, waterfall_height, current_time, note_color, "colorShift" in visual_effects)

    image.alpha_composite(cache["keyboard_base"])
    draw = ImageDraw.Draw(image, "RGBA")

    for key in keyboard:
        if not key["is_white"]:
            continue
        velocity = active.get(key["midi"], 0)
        if not velocity:
            continue
        fill = keyboard_note_color(note_color, velocity, True, key["midi"], current_time, "colorShift" in visual_effects)
        draw.rectangle([key["x"], waterfall_height, key["x"] + key["width"], height], fill=fill)
        draw.rectangle([key["x"], waterfall_height, key["x"] + key["width"], height], outline=(13, 26, 45, 140))

    image.alpha_composite(cache["black_key_base"])

    for key in keyboard:
        if key["is_white"]:
            continue
        x, black_width = note_lane(key)
        black_height = piano_height * 0.63
        velocity = active.get(key["midi"], 0)
        if not velocity:
            continue
        fill = keyboard_note_color(note_color, velocity, False, key["midi"], current_time, "colorShift" in visual_effects)
        draw_bottom_rounded_rectangle(
            image,
            [x, waterfall_height, x + black_width, waterfall_height + black_height],
            7,
            fill,
        )

    draw = ImageDraw.Draw(image, "RGBA")
    draw.line([(0, waterfall_height), (width, waterfall_height)], fill=time_cursor_color(note_color), width=2)

    return image.convert("RGB")


def normalize_visual_effects(visual_effect):
    allowed = {"trail", "glow", "fog", "stream", "colorShift"}
    effects = set()

    def add_effect(value):
        if value is None:
            return
        if isinstance(value, str):
            for part in value.split(","):
                effect = part.strip()
                if effect in allowed:
                    effects.add(effect)
            return
        if isinstance(value, dict):
            return
        try:
            iterator = iter(value)
        except TypeError:
            return
        for item in iterator:
            add_effect(item)

    add_effect(visual_effect)
    return effects


def unknown_visual_effects(visual_effect):
    allowed = {"trail", "glow", "fog", "stream", "colorShift"}
    unknown = set()

    def add_unknown(value):
        if value is None:
            return
        if isinstance(value, str):
            for part in value.split(","):
                effect = part.strip()
                if effect and effect != "none" and effect not in allowed:
                    unknown.add(effect)
            return
        try:
            iterator = iter(value)
        except TypeError:
            return
        for item in iterator:
            add_unknown(item)

    add_unknown(visual_effect)
    return sorted(unknown)


def alpha_composite_region(base, layer, bounds):
    left, top, right, bottom = bounds
    if right <= left or bottom <= top:
        return
    base.alpha_composite(layer, (left, top))


def draw_antialiased_segments(target, points, colors, widths, padding: float = 4, scale: int = 3):
    if len(points) < 2:
        return
    max_width = max(widths) if widths else 1
    min_x = min(point[0] for point in points) - max_width - padding
    max_x = max(point[0] for point in points) + max_width + padding
    min_y = min(point[1] for point in points) - max_width - padding
    max_y = max(point[1] for point in points) + max_width + padding
    bounds = region_bounds([min_x, min_y, max_x, max_y], 0, target.size)
    left, top, right, bottom = bounds
    if right <= left or bottom <= top:
        return

    high = Image.new("RGBA", ((right - left) * scale, (bottom - top) * scale), (0, 0, 0, 0))
    high_draw = ImageDraw.Draw(high, "RGBA")
    for index in range(len(points) - 1):
        width = max(1, int(round(widths[index] * scale)))
        color = colors[index]
        if color[3] <= 0:
            continue
        p0 = ((points[index][0] - left) * scale, (points[index][1] - top) * scale)
        p1 = ((points[index + 1][0] - left) * scale, (points[index + 1][1] - top) * scale)
        high_draw.line([p0, p1], fill=color, width=width)
        radius = width / 2
        high_draw.ellipse([p0[0] - radius, p0[1] - radius, p0[0] + radius, p0[1] + radius], fill=color)
        high_draw.ellipse([p1[0] - radius, p1[1] - radius, p1[0] + radius, p1[1] + radius], fill=color)

    low = high.resize((right - left, bottom - top), Image.Resampling.LANCZOS)
    alpha_composite_region(target, low, bounds)


def draw_note_body(image, rect, radius: float, color, color_hsl, waterfall_height: int, velocity: float, glow: bool):
    edge_width = max(1, min(3, int((rect[2] - rect[0]) * 0.12), max(1, int((rect[3] - rect[1]) * 0.45))))
    padding = (3.0 + velocity * 5.8) * 2.2 + edge_width + 2 if glow else 2
    visible_rect = [rect[0], max(0, rect[1]), rect[2], min(waterfall_height, rect[3])]
    bounds = region_bounds(
        [
            min(rect[0], visible_rect[0]),
            min(rect[1], visible_rect[1]),
            max(rect[2], visible_rect[2]),
            max(rect[3], visible_rect[3]),
        ],
        padding,
        image.size,
    )
    left, top, right, bottom = bounds
    if right <= left or bottom <= top:
        return

    scale = 4
    high_size = ((right - left) * scale, (bottom - top) * scale)
    mask = Image.new("L", high_size, 0)
    mask_draw = ImageDraw.Draw(mask)
    scaled_rect = [
        (rect[0] - left) * scale,
        (rect[1] - top) * scale,
        (rect[2] - left) * scale,
        (rect[3] - top) * scale,
    ]
    mask_draw.rounded_rectangle(scaled_rect, radius=radius * scale, fill=255)
    high = Image.new("RGBA", high_size, (0, 0, 0, 0))
    high_array = np.zeros((high_size[1], high_size[0], 4), dtype=np.uint8)
    top_rgb = hsl_to_rgb(color_hsl["hue"], color_hsl["saturation"], color_hsl["top_lightness"])
    bottom_rgb = hsl_to_rgb((color_hsl["hue"] + 8) % 360, color_hsl["saturation"], color_hsl["bottom_lightness"])
    denom = max(1, scaled_rect[3] - scaled_rect[1])
    mask_array = np.array(mask, dtype=np.float32) / 255.0
    ratios = np.clip((np.arange(high_size[1], dtype=np.float32) - scaled_rect[1]) / denom, 0, 1)
    top_rgb_array = np.array(top_rgb, dtype=np.float32)
    bottom_rgb_array = np.array(bottom_rgb, dtype=np.float32)
    row_rgb = (top_rgb_array + (bottom_rgb_array - top_rgb_array) * ratios[:, None]) * 255
    high_array[..., :3] = np.clip(row_rgb[:, None, :], 0, 255).astype(np.uint8)
    high_array[..., 3] = np.clip(mask_array * 255, 0, 255).astype(np.uint8)
    high = Image.fromarray(high_array, "RGBA")
    low = high.resize((right - left, bottom - top), Image.Resampling.LANCZOS)

    clip = Image.new("L", low.size, 0)
    clip_draw = ImageDraw.Draw(clip)
    clip_draw.rectangle(
        [
            0,
            max(0, int(round((0 - top)))),
            right - left,
            min(bottom - top, int(round((waterfall_height - top)))),
        ],
        fill=255,
    )
    clipped = Image.new("RGBA", low.size, (0, 0, 0, 0))
    clipped.alpha_composite(low)
    clipped.putalpha(ImageChops.multiply(clipped.getchannel("A"), clip))

    if glow:
        draw_canvas_note_shadow(image, rect, radius, velocity, color)

    alpha_composite_region(image, clipped, bounds)

    if glow:
        edge_color = glow_edge_color(color, velocity)
        draw_smooth_inner_note_edge(image, rect, radius, edge_width, edge_color)


def draw_note_body_cached(image, rect, radius: float, color_hsl, sprite_cache):
    left, top, right, bottom = rect
    width = max(1, int(round(right - left)))
    height = max(1, int(round(bottom - top)))
    radius = max(1, min(radius, width / 2, height / 2))
    key = (
        width,
        height,
        round(radius * 4),
        round(color_hsl["hue"], 2),
        round(color_hsl["saturation"], 2),
        round(color_hsl["top_lightness"], 2),
        round(color_hsl["bottom_lightness"], 2),
    )
    sprite = sprite_cache.get(key)
    if sprite is None:
        sprite = build_note_body_sprite(width, height, radius, color_hsl)
        sprite_cache[key] = sprite
    image.alpha_composite(sprite, (int(round(left)), int(round(top))))


def build_note_body_sprite(width: int, height: int, radius: float, color_hsl):
    scale = 4
    high_size = (width * scale, height * scale)
    mask = Image.new("L", high_size, 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle([0, 0, width * scale, height * scale], radius=radius * scale, fill=255)
    high_array = np.zeros((high_size[1], high_size[0], 4), dtype=np.uint8)
    top_rgb = hsl_to_rgb(color_hsl["hue"], color_hsl["saturation"], color_hsl["top_lightness"])
    bottom_rgb = hsl_to_rgb((color_hsl["hue"] + 8) % 360, color_hsl["saturation"], color_hsl["bottom_lightness"])
    ratios = np.linspace(0, 1, high_size[1], dtype=np.float32)
    top_rgb_array = np.array(top_rgb, dtype=np.float32)
    bottom_rgb_array = np.array(bottom_rgb, dtype=np.float32)
    row_rgb = (top_rgb_array + (bottom_rgb_array - top_rgb_array) * ratios[:, None]) * 255
    high_array[..., :3] = np.clip(row_rgb[:, None, :], 0, 255).astype(np.uint8)
    high_array[..., 3] = np.array(mask, dtype=np.uint8)
    return Image.fromarray(high_array, "RGBA").resize((width, height), Image.Resampling.LANCZOS)


def draw_note_trail(image, x: float, lane_width: float, y0: float, y1: float, waterfall_height: int, velocity: float, color):
    note_radius = max(2, min(8, int(lane_width / 3)))
    attach_overlap = min(max(4, note_radius + 2), max(4, int(y1 - y0)))
    trail_length = clamp(42 + velocity * 120, 36, min(180, waterfall_height * 0.34))
    trail_top = max(0, y0 - trail_length)
    trail_join = y0
    trail_bottom = min(waterfall_height, y0 + attach_overlap)
    if trail_join <= trail_top:
        return

    visible_trail_length = trail_join - trail_top
    lane_width = max(2, lane_width - 2)
    center_x = x + 1 + lane_width / 2
    glow_width = clamp(lane_width * 0.9, 3, max(18, lane_width))
    core_width = clamp(lane_width * 0.42, 2, 9)
    r, g, b, _ = color
    alpha = int(36 + velocity * 71)
    scale = 3
    bounds = region_bounds([x + 1 - glow_width, trail_top - 3, x + 1 + lane_width + glow_width, trail_bottom + 3], 0, image.size)
    left_bound, top_bound, right_bound, bottom_bound = bounds
    if right_bound <= left_bound or bottom_bound <= top_bound:
        return
    high_size = ((right_bound - left_bound) * scale, (bottom_bound - top_bound) * scale)
    screen_high = Image.new("RGBA", high_size, (0, 0, 0, 0))
    connector_high = Image.new("RGBA", high_size, (0, 0, 0, 0))
    trail_draw = ImageDraw.Draw(screen_high, "RGBA")
    connector_draw = ImageDraw.Draw(connector_high, "RGBA")

    def sx(value):
        return (value - left_bound) * scale

    def sy(value):
        return (value - top_bound) * scale

    def trail_alpha_at(ratio):
        ratio = clamp(ratio, 0, 1)
        if ratio < 0.34:
            return 0
        if ratio < 0.74:
            return alpha * 0.22 * ((ratio - 0.34) / 0.4)
        if ratio < 0.9:
            return alpha * (0.22 + (0.58 - 0.22) * ((ratio - 0.74) / 0.16))
        return alpha * (0.58 + (1 - 0.58) * ((ratio - 0.9) / 0.1))

    mask = Image.new("L", high_size, 0)
    mask_draw = ImageDraw.Draw(mask)
    trail_shape = [sx(x + 1), sy(trail_top), sx(x + 1 + lane_width), sy(trail_bottom)]
    mask_draw.rounded_rectangle(trail_shape, radius=(glow_width / 2) * scale, fill=255)
    mask_draw.rectangle([sx(x + 1), sy(trail_join), sx(x + 1 + lane_width), sy(trail_bottom)], fill=255)
    denom = max(1, sy(trail_join) - sy(trail_top))
    ratios = np.clip((np.arange(high_size[1], dtype=np.float32) - sy(trail_top)) / denom, 0, 1)
    gradient_values = np.zeros(high_size[1], dtype=np.float32)
    band = (ratios >= 0.34) & (ratios < 0.74)
    gradient_values[band] = alpha * 0.22 * ((ratios[band] - 0.34) / 0.4)
    band = (ratios >= 0.74) & (ratios < 0.9)
    gradient_values[band] = alpha * (0.22 + (0.58 - 0.22) * ((ratios[band] - 0.74) / 0.16))
    band = ratios >= 0.9
    gradient_values[band] = alpha * (0.58 + (1 - 0.58) * ((ratios[band] - 0.9) / 0.1))
    gradient_array = np.clip(gradient_values[:, None] * 0.72, 0, 255).astype(np.uint8)
    gradient_array = np.repeat(gradient_array, high_size[0], axis=1)
    gradient = Image.fromarray(gradient_array, "L")
    fill_layer = Image.new("RGBA", high_size, (r, g, b, 255))
    fill_layer.putalpha(ImageChops.multiply(mask, gradient))
    screen_high.alpha_composite(fill_layer)

    connector_alpha = int(alpha * 0.72)
    connector_draw.rectangle(
        [sx(x + 1), sy(y0), sx(x + 1 + lane_width), sy(max(y0 + 1, trail_bottom))],
        fill=(r, g, b, connector_alpha),
    )

    points = []
    for step in range(32):
        t = step / 31
        one_minus = 1 - t
        p0x, p0y = center_x, trail_top
        p1x, p1y = center_x - lane_width * 0.16, trail_top + visible_trail_length * 0.35
        p2x, p2y = center_x + lane_width * 0.18, trail_join - visible_trail_length * 0.28
        p3x, p3y = center_x, trail_join
        px = one_minus ** 3 * p0x + 3 * one_minus ** 2 * t * p1x + 3 * one_minus * t ** 2 * p2x + t ** 3 * p3x
        py = one_minus ** 3 * p0y + 3 * one_minus ** 2 * t * p1y + 3 * one_minus * t ** 2 * p2y + t ** 3 * p3y
        points.append((px, py))
    core_width_scaled = max(1, int(round(core_width * scale)))
    for index in range(len(points) - 1):
        t = (index + 1) / max(1, len(points) - 1)
        line_alpha = int(min(210, trail_alpha_at(t) + 36 * clamp((t - 0.72) / 0.28, 0, 1)))
        if line_alpha <= 0:
            continue
        p0 = (sx(points[index][0]), sy(points[index][1]))
        p1 = (sx(points[index + 1][0]), sy(points[index + 1][1]))
        trail_draw.line([p0, p1], fill=(r, g, b, line_alpha), width=core_width_scaled)
        cap_radius = core_width_scaled / 2
        trail_draw.ellipse([p1[0] - cap_radius, p1[1] - cap_radius, p1[0] + cap_radius, p1[1] + cap_radius], fill=(r, g, b, line_alpha))

    side_width = max(1, int(round(core_width * 0.45 * scale)))
    side_paths = [
        [
            (center_x - lane_width * 0.22, trail_top + visible_trail_length * 0.18, 0.18),
            (center_x - lane_width * 0.34, trail_top + visible_trail_length * 0.46, 0.46),
            (center_x - lane_width * 0.12, trail_join, 1.0),
        ],
        [
            (center_x + lane_width * 0.22, trail_top + visible_trail_length * 0.14, 0.14),
            (center_x + lane_width * 0.38, trail_top + visible_trail_length * 0.42, 0.42),
            (center_x + lane_width * 0.10, trail_join, 1.0),
        ],
    ]
    for side_path in side_paths:
        for index in range(len(side_path) - 1):
            p0x, p0y, _ = side_path[index]
            p1x, p1y, p1t = side_path[index + 1]
            side_alpha = int(trail_alpha_at(p1t) * 0.34)
            if side_alpha <= 0:
                continue
            trail_draw.line([(sx(p0x), sy(p0y)), (sx(p1x), sy(p1y))], fill=(r, g, b, side_alpha), width=side_width)
    low_size = (right_bound - left_bound, bottom_bound - top_bound)
    screen_low = screen_high.resize(low_size, Image.Resampling.LANCZOS)
    connector_low = connector_high.resize(low_size, Image.Resampling.LANCZOS)
    screen_blend_rgba_region(image, bounds, screen_low)
    alpha_composite_region(image, connector_low, bounds)


def draw_note_glow(image, x: float, lane_width: float, y0: float, y1: float, velocity: float, color):
    r, g, b, _ = color
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(layer, "RGBA")
    radius = max(3, min(18, int(8 + velocity * 14)))
    alpha = int(26 + velocity * 48)
    for step in range(radius, 0, -2):
        ratio = step / radius
        inset = -step
        left = x + 1 + inset
        top = y0 + inset
        right = x + lane_width - 1 - inset
        bottom = y1 - inset
        rect_width = max(1, right - left)
        rect_height = max(1, bottom - top)
        corner_radius = max(1, min(10 + step, int(lane_width / 3) + step, int(rect_width / 2), int(rect_height / 2)))
        glow_draw.rounded_rectangle(
            [left, top, right, bottom],
            radius=corner_radius,
            outline=(r, g, b, int(alpha * ratio * ratio * 0.45)),
            width=max(1, int(step / 3)),
        )
    image.alpha_composite(layer)


def region_bounds(rect, padding: float, size):
    width, height = size
    left = max(0, int(math.floor(rect[0] - padding)))
    top = max(0, int(math.floor(rect[1] - padding)))
    right = min(width, int(math.ceil(rect[2] + padding)))
    bottom = min(height, int(math.ceil(rect[3] + padding)))
    return left, top, right, bottom


def rounded_rect_mask_region(bounds, rect, radius: float, scale: int = 4):
    left, top, right, bottom = bounds
    width = max(1, right - left)
    height = max(1, bottom - top)
    scaled = Image.new("L", (width * scale, height * scale), 0)
    mask_draw = ImageDraw.Draw(scaled)
    scaled_rect = [
        (rect[0] - left) * scale,
        (rect[1] - top) * scale,
        (rect[2] - left) * scale,
        (rect[3] - top) * scale,
    ]
    mask_draw.rounded_rectangle(scaled_rect, radius=max(0, radius * scale), fill=255)
    return scaled.resize((width, height), Image.Resampling.LANCZOS)


def screen_blend_region(base, bounds, rgb, alpha_mask):
    alpha = np.array(alpha_mask, dtype=np.float32) / 255.0
    if alpha.max() <= 0:
        return
    left, top, right, bottom = bounds
    base_crop = np.array(base.crop((left, top, right, bottom)), dtype=np.float32)
    source_rgb = np.zeros_like(base_crop[..., :3])
    source_rgb[..., 0] = rgb[0]
    source_rgb[..., 1] = rgb[1]
    source_rgb[..., 2] = rgb[2]
    screened = 255 - ((255 - base_crop[..., :3]) * (255 - source_rgb) / 255)
    base_crop[..., :3] = base_crop[..., :3] * (1 - alpha[..., None]) + screened * alpha[..., None]
    base.paste(Image.fromarray(np.clip(base_crop, 0, 255).astype(np.uint8), "RGBA"), (left, top))


def screen_blend_rgba_region(base, bounds, layer):
    left, top, right, bottom = bounds
    if right <= left or bottom <= top:
        return
    layer_array = np.array(layer, dtype=np.float32)
    source_alpha = layer_array[..., 3:4] / 255.0
    if source_alpha.max() <= 0:
        return
    base_crop = np.array(base.crop((left, top, right, bottom)), dtype=np.float32)
    screened = 255 - ((255 - base_crop[..., :3]) * (255 - layer_array[..., :3]) / 255)
    base_crop[..., :3] = base_crop[..., :3] * (1 - source_alpha) + screened * source_alpha
    base.paste(Image.fromarray(np.clip(base_crop, 0, 255).astype(np.uint8), "RGBA"), (left, top))


def draw_canvas_note_shadow(image, rect, radius: float, velocity: float, color):
    r, g, b, _ = color
    blur_radius = 3.0 + velocity * 5.8
    shadow_alpha = int((0.5 + velocity * 0.22) * 255)
    bounds = region_bounds(rect, blur_radius * 2.2, image.size)
    mask = rounded_rect_mask_region(bounds, rect, radius, scale=4)
    blurred = mask.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    alpha = blurred.point(lambda value: int(value * shadow_alpha / 255))
    screen_blend_region(image, bounds, (r, g, b), alpha)


def draw_smooth_inner_note_edge(image, rect, radius: float, width: int, color):
    bounds = region_bounds(rect, width + 2, image.size)
    outer = rounded_rect_mask_region(bounds, rect, radius, scale=4)
    inset = max(1, width)
    inner_rect = [rect[0] + inset, rect[1] + inset, rect[2] - inset, rect[3] - inset]
    if inner_rect[2] <= inner_rect[0] or inner_rect[3] <= inner_rect[1]:
        inner = Image.new("L", outer.size, 0)
    else:
        inner = rounded_rect_mask_region(bounds, inner_rect, max(0, radius - inset), scale=4)
    edge = Image.fromarray(np.maximum(np.array(outer, dtype=np.int16) - np.array(inner, dtype=np.int16), 0).astype(np.uint8), "L")
    edge = edge.point(lambda value: int(value * color[3] / 255))
    screen_blend_region(image, bounds, (color[0], color[1], color[2]), edge)


def draw_impact_fogs(image, notes, keyboard, waterfall_height: int, current_time: float, note_color: str, color_shift: bool = False, fog_quality: str = "high"):
    quality = fog_quality_settings(fog_quality)
    for note in notes:
        key = keyboard[note.midi - MIDI_MIN]
        x, lane_width = note_lane(key)
        lane_width = max(2, lane_width - 2)
        velocity = note.velocity / 127
        color = velocity_note_hsl(note_color, velocity, note.midi, current_time, color_shift)
        origin_x = x + 1 + lane_width / 2
        origin_y = waterfall_height + 8
        note_duration = max(0, note.end - note.start)
        wind_seed = math.sin((note.midi * 17.71 + note.start * 83.33) * 12.9898) * 43758.5453
        wind_random = wind_seed - math.floor(wind_seed)
        wind_direction = (wind_random - 0.5) * lane_width * 1.65
        release_interval = quality["release_interval"]
        release_count = 1 + max(0, math.floor(max(0, note_duration - 0.45) / release_interval))

        for release_index in range(release_count):
            release_time = note.start + release_index * release_interval
            if release_time > note.end:
                continue
            release_age = current_time - release_time
            release_seed = math.sin((note.midi * 31.37 + release_time * 113.9 + release_index * 7.91) * 12.9898) * 43758.5453
            release_random = release_seed - math.floor(release_seed)
            is_impact = release_index == 0
            particle_count = (
                max(quality["impact_min"], min(quality["impact_max"], round((12 + velocity * 14) * quality["particle_factor"])))
                if is_impact
                else max(quality["sustain_min"], min(quality["sustain_max"], round((3 + velocity * 5) * quality["particle_factor"])))
            )

            if release_age >= 0:
                veil_duration = 1.65 if is_impact else 1.15
                veil_life = release_age / veil_duration
                if 0 <= veil_life <= 1:
                    veil_spread = ease_out_cubic(veil_life)
                    veil_x = origin_x + wind_direction * veil_spread * 0.34 + (release_random - 0.5) * lane_width * 0.8
                    veil_y = origin_y - (22 if is_impact else 12) * veil_spread - velocity * 18 * veil_spread
                    veil_radius = lane_width * (1.2 + velocity * 0.7) + veil_spread * (52 + velocity * 26)
                    veil_alpha = (0.02 + velocity * 0.035) * math.sin(math.pi * veil_life) * (1 if is_impact else 0.52)
                    if veil_alpha > 0.002:
                        center = hsl_to_rgb(
                            color["hue"],
                            max(18, color["saturation"] * 0.55),
                            clamp(color["top_lightness"] + 18, 0, 96),
                        )
                        draw_radial_fog_particle(image, veil_x, veil_y, veil_radius, center, veil_alpha, release_seed + 101.7, quality["shape"])

            for index in range(particle_count):
                seed = math.sin((note.midi * 41.17 + release_time * 127.3 + index * 19.91 + release_index * 13.7) * 12.9898) * 43758.5453
                random_a = seed - math.floor(seed)
                random_b = math.sin(seed * 1.37) * 0.5 + 0.5
                random_c = math.sin(seed * 2.11) * 0.5 + 0.5
                random_d = math.sin(seed * 2.87) * 0.5 + 0.5
                particle_duration = 0.9 + random_d * 1.9 + (0.25 if is_impact else 0)
                if release_age < 0 or release_age > particle_duration:
                    continue

                life = release_age / particle_duration
                type_roll = (random_a + release_random * 0.37) % 1
                spread = ease_out_cubic(life)
                px = origin_x + (random_a - 0.5) * lane_width * 0.7
                py = origin_y + (random_b - 0.5) * lane_width * 0.18
                if type_roll < 0.34:
                    px += (random_a - 0.5) * lane_width * (2.4 + spread * 4.2) + wind_direction * spread * 0.24
                    py += (random_b - 0.5) * lane_width * 0.8 - spread * lane_width * (0.25 + random_c * 0.5)
                elif type_roll < 0.72:
                    px += wind_direction * spread * (0.35 + random_c * 0.55) + math.sin((life * 1.4 + random_b) * math.pi) * lane_width * (0.25 + random_d * 0.35)
                    py -= (42 + random_b * 122 + velocity * 52) * spread
                else:
                    side = -1 if random_a < 0.5 else 1
                    px += side * lane_width * (1.2 + random_c * 4.8) * spread + wind_direction * spread * 0.42
                    py -= (14 + random_b * 52) * spread
                radius = clamp(lane_width * (0.28 + random_c * 0.78) + spread * (30 + random_d * 36), 7, 68)
                alpha = (0.045 + velocity * 0.095) * math.sin(math.pi * life) * (0.72 + random_c * 0.34) * (1 if is_impact else 0.56)
                if alpha <= 0.002:
                    continue
                center = hsl_to_rgb(
                    color["hue"],
                    max(18, color["saturation"] * 0.55),
                    clamp(color["top_lightness"] + 18, 0, 96),
                )
                draw_radial_fog_particle(image, px, py, radius, center, alpha, seed, quality["shape"])


def draw_impact_streams(image, notes, keyboard, waterfall_height: int, current_time: float, note_color: str, color_shift: bool = False):
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer, "RGBA")

    for note in notes:
        note_duration = max(0, note.end - note.start)
        if note_duration < 0.18:
            continue

        stream_interval = 0.48
        stream_duration = 1.15
        stream_count = max(1, min(10, math.floor((note_duration - 0.18) / stream_interval) + 1))

        key = keyboard[note.midi - MIDI_MIN]
        x, lane_width = note_lane(key)
        lane_width = max(2, lane_width - 2)
        velocity = note.velocity / 127
        color = velocity_note_hsl(note_color, velocity, note.midi, current_time, color_shift)
        origin_x = x + 1 + lane_width / 2
        origin_y = waterfall_height + 3

        for index in range(stream_count):
            emit_offset = min(note_duration * 0.86, index * stream_interval)
            emit_time = note.start + emit_offset
            age = current_time - emit_time
            if age < 0 or age > stream_duration:
                continue

            life = age / stream_duration
            fade = math.sin(math.pi * life)
            seed = math.sin((note.midi * 53.11 + emit_time * 97.7 + index * 23.31) * 12.9898) * 43758.5453
            random_a = seed - math.floor(seed)
            random_b = math.sin(seed * 1.91) * 0.5 + 0.5
            random_c = math.sin(seed * 2.73) * 0.5 + 0.5
            random_d = math.sin(seed * 3.47) * 0.5 + 0.5
            random_e = math.sin(seed * 4.19) * 0.5 + 0.5
            side = -1 if random_a < 0.5 else 1
            base_offset = (random_b - 0.5) * lane_width * 1.65
            alpha = min(0.96, (0.42 + velocity * 0.58) * fade * (0.88 + random_c * 0.34))
            if alpha <= 0.002:
                continue

            line_width = max(1, min(4, int(round(lane_width * (0.055 + velocity * 0.045 + random_d * 0.038)))))
            rgb = hsl_to_rgb(
                color["hue"],
                color["saturation"],
                clamp(color["top_lightness"] + 26, 0, 98),
            )
            steps = 34
            trail_span = 0.34 + random_e * 0.18
            travel_distance = 150 + random_c * 220 + velocity * 116
            curl = side * lane_width * (0.42 + random_d * 1.05)
            flutter = lane_width * (0.1 + random_b * 0.34)
            t_values = np.linspace(0, 1, steps + 1, dtype=np.float32)
            progress = np.clip(life - trail_span * (1 - t_values), 0, 1)
            progress_drift = progress * progress * (3 - 2 * progress)
            drift = side * lane_width * (0.45 + random_c * 1.35) * progress_drift
            sway = np.sin((progress * (0.55 + random_c * 0.55) + random_d) * math.pi) * lane_width * (0.16 + random_b * 0.42)
            path_curl = np.sin((progress * (1.35 + random_e * 0.8) + random_a) * math.pi * 2) * curl * (0.22 + progress * 0.62)
            path_flutter = np.sin((progress * (2.15 + random_c * 1.2) + random_d) * math.pi * 2) * flutter * (0.25 + progress * 0.75)
            px = origin_x + base_offset + drift + sway + path_curl + path_flutter
            py = origin_y - travel_distance * progress
            points = list(zip(px.tolist(), py.tolist()))

            segment_t = np.linspace(0, 1, len(points) - 1, endpoint=False, dtype=np.float32)
            segment_alpha_values = np.minimum(0.92, alpha * np.sin(math.pi * segment_t) * (0.92 + 0.36 * segment_t))
            segment_alpha_values *= np.clip((1.08 - life - segment_t * 0.42) / 0.36, 0, 1)
            segment_width_values = np.maximum(0.8, line_width * (0.12 + (np.sin(math.pi * segment_t) ** 2.1) * 2.15))

            segment_colors = []
            segment_widths = []
            drawable_points = []
            for point_index, segment_alpha in enumerate(segment_alpha_values):
                if segment_alpha <= 0.001:
                    if drawable_points:
                        draw_antialiased_segments(layer, drawable_points, segment_colors, segment_widths, padding=4, scale=3)
                        drawable_points = []
                        segment_colors = []
                        segment_widths = []
                    continue
                if not drawable_points:
                    drawable_points.append(points[point_index])
                drawable_points.append(points[point_index + 1])
                segment_colors.append(
                    (
                        int(rgb[0] * 255),
                        int(rgb[1] * 255),
                        int(rgb[2] * 255),
                        int(segment_alpha * 255),
                    )
                )
                segment_widths.append(float(segment_width_values[point_index]))
            if drawable_points:
                draw_antialiased_segments(layer, drawable_points, segment_colors, segment_widths, padding=4, scale=3)

            if life < 0.18:
                base_radius = lane_width * (0.8 + velocity * 0.5)
                base_rgb = hsl_to_rgb(
                    color["hue"],
                    color["saturation"],
                    clamp(color["top_lightness"] + 20, 0, 98),
                )
                draw_radial_fog_particle(
                    layer,
                    origin_x,
                    waterfall_height,
                    base_radius,
                    base_rgb,
                    (1 - life / 0.18) * (0.08 + velocity * 0.1),
                )

    image.alpha_composite(layer)


def fog_quality_settings(fog_quality: str):
    if fog_quality == "low":
        return {
            "particle_factor": 0.42,
            "impact_min": 5,
            "impact_max": 11,
            "sustain_min": 1,
            "sustain_max": 3,
            "release_interval": 0.58,
            "shape": "simple",
        }
    if fog_quality == "medium":
        return {
            "particle_factor": 0.68,
            "impact_min": 8,
            "impact_max": 17,
            "sustain_min": 2,
            "sustain_max": 5,
            "release_interval": 0.46,
            "shape": "medium",
        }
    return {
        "particle_factor": 1.0,
        "impact_min": 12,
        "impact_max": 26,
        "sustain_min": 3,
        "sustain_max": 8,
        "release_interval": 0.38,
        "shape": "high",
    }


def draw_radial_fog_particle(image, px: float, py: float, radius: float, rgb, alpha: float, warp_seed: float = 0.0, shape_quality: str = "high"):
    left = max(0, int(math.floor(px - radius)))
    top = max(0, int(math.floor(py - radius)))
    right = min(image.width, int(math.ceil(px + radius)))
    bottom = min(image.height, int(math.ceil(py + radius)))
    if right <= left or bottom <= top:
        return

    size_x = right - left
    size_y = bottom - top
    y, x = np.ogrid[top:bottom, left:right]
    dx = x - px
    dy = y - py
    if shape_quality == "simple":
        distance = np.sqrt(dx ** 2 + dy ** 2) / max(radius, 1)
        fade = np.clip(1 - distance, 0, 1) ** 1.85
    else:
        angle = math.sin(warp_seed * 0.017) * math.pi
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        sx = 0.7 + (math.sin(warp_seed * 0.031) * 0.5 + 0.5) * 0.72
        sy = 0.56 + (math.sin(warp_seed * 0.047) * 0.5 + 0.5) * 0.78
        rx = (dx * cos_a + dy * sin_a) / max(sx, 0.1)
        ry = (-dx * sin_a + dy * cos_a) / max(sy, 0.1)
        base_distance = np.sqrt(rx ** 2 + ry ** 2) / max(radius, 1)
        theta = np.arctan2(dy, dx)
        if shape_quality == "medium":
            ripple = 1 + 0.12 * np.sin(theta * 3.0 + warp_seed * 0.011)
            fade_noise = 1
        else:
            ripple = (
                1
                + 0.16 * np.sin(theta * 3.0 + warp_seed * 0.011)
                + 0.11 * np.sin(theta * 5.0 + warp_seed * 0.019)
                + 0.08 * np.sin((dx + dy) / max(radius * 0.45, 1) + warp_seed * 0.023)
            )
            fade_noise = 0.82 + 0.18 * np.sin((dx * 0.11 + dy * 0.07) + warp_seed * 0.013)
        distance = base_distance * ripple
        fade = np.clip(1 - distance, 0, 1) ** 1.65
        fade *= fade_noise
    fade = np.clip(fade, 0, 1)
    alpha_channel = np.clip(fade * alpha * 255, 0, 255).astype(np.uint8)
    if not np.any(alpha_channel):
        return

    crop = image.crop((left, top, right, bottom))
    base = np.array(crop, dtype=np.float32)
    source_alpha = alpha_channel[..., None].astype(np.float32) / 255.0
    source_rgb = np.zeros((size_y, size_x, 3), dtype=np.float32)
    source_rgb[..., 0] = rgb[0] * 255
    source_rgb[..., 1] = rgb[1] * 255
    source_rgb[..., 2] = rgb[2] * 255
    base_rgb = base[..., :3]
    screened = 255 - ((255 - base_rgb) * (255 - source_rgb) / 255)
    base[..., :3] = base_rgb * (1 - source_alpha) + screened * source_alpha
    image.paste(Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), "RGBA"), (left, top))


def ease_out_cubic(value: float):
    value = clamp(value, 0, 1)
    return 1 - (1 - value) ** 3


def glow_edge_color(color, velocity: float):
    r, g, b, _ = color
    return min(255, int(r * 1.12)), min(255, int(g * 1.12)), min(255, int(b * 1.12)), int(88 + velocity * 70)


def time_cursor_color(note_color: str):
    hue, lightness, saturation = hex_to_hls(note_color)
    hue = hue * 360
    saturation = clamp(saturation * 100, 32, 96)
    lightness = clamp(lightness * 100 + 24, 62, 96)
    r, g, b = hsl_to_rgb(hue, saturation, lightness)
    return int(r * 255), int(g * 255), int(b * 255), 219


def velocity_note_color(note_color: str, velocity: float, midi: int = 60, current_time: float = 0.0, color_shift: bool = False):
    color = velocity_note_hsl(note_color, velocity, midi, current_time, color_shift)
    r, g, b = hsl_to_rgb(color["hue"], color["saturation"], color["lightness"])
    return int(r * 255), int(g * 255), int(b * 255), 225


def velocity_note_hsl(note_color: str, velocity: float, midi: int = 60, current_time: float = 0.0, color_shift: bool = False):
    hue, lightness, saturation = hex_to_hls(note_color)
    shift = math.sin(current_time * 1.15 + midi * 0.17) * 17 + math.sin(current_time * 0.42 + midi * 0.09) * 7 if color_shift else 0
    hue = (hue * 360 + shift) % 360
    saturation = clamp(saturation * 100, 30, 96)
    lightness = clamp(lightness * 100, 24, 96)
    return {
        "hue": hue,
        "saturation": saturation,
        "lightness": lightness,
        "top_lightness": clamp(lightness + 8, 0, 92),
        "bottom_lightness": clamp(lightness - 7, 12, 86),
    }


def hsl_to_rgb(hue: float, saturation: float, lightness: float):
    return colorsys.hls_to_rgb((hue % 360) / 360, lightness / 100, saturation / 100)


def keyboard_note_color(note_color: str, velocity: float, is_white_key: bool, midi: int = 60, current_time: float = 0.0, color_shift: bool = False):
    hue, lightness, saturation = hex_to_hls(note_color)
    shift = math.sin(current_time * 1.15 + midi * 0.17) * 17 + math.sin(current_time * 0.42 + midi * 0.09) * 7 if color_shift else 0
    hue = ((hue * 360 + shift) % 360) / 360
    saturation = clamp(saturation * 100, 30, 96) / 100
    lightness_percent = clamp(lightness * 100, 24, 96)
    if is_white_key:
        lightness_percent = clamp(lightness_percent + 14, 48, 90)
    else:
        lightness_percent = clamp(lightness_percent - 10, 16, 58)
    r, g, b = colorsys.hls_to_rgb(hue, lightness_percent / 100, saturation)
    return int(r * 255), int(g * 255), int(b * 255), 255


def hex_to_hls(note_color: str):
    match = re.fullmatch(r"#[0-9a-fA-F]{6}", note_color or "")
    normalized = note_color if match else "#2de1b4"
    r = int(normalized[1:3], 16) / 255
    g = int(normalized[3:5], 16) / 255
    b = int(normalized[5:7], 16) / 255
    return colorsys.rgb_to_hls(r, g, b)


def clamp(value: float, minimum: float, maximum: float):
    return min(maximum, max(minimum, value))


def composite_background_image(image, background_image, opacity: float):
    width, height = image.size
    opacity = max(0.0, min(1.0, opacity))
    scale = max(width / background_image.width, height / background_image.height)
    draw_width = max(1, int(background_image.width * scale))
    draw_height = max(1, int(background_image.height * scale))
    x = int((width - draw_width) / 2)
    y = int((height - draw_height) / 2)

    resample = getattr(Image, "Resampling", Image).LANCZOS
    fitted = background_image.resize((draw_width, draw_height), resample)
    layer = Image.new("RGB", (width, height), "#000000")
    layer.paste(fitted, (x, y))
    blended = Image.blend(image, layer, opacity)

    # Keep the grid readable without hiding the chosen background.
    shade = Image.new("RGB", (width, height), "#07111f")
    return Image.blend(blended, shade, 0.08 + opacity * 0.12)


def export_video(
    notes,
    output_mp4: Path,
    audio_wav: Path,
    width: int,
    height: int,
    fps: int,
    duration: float,
    background_image_path: Path | None = None,
    background_opacity: float = 0.0,
    background_base: str = "default",
    note_color: str = "#2de1b4",
    show_grid: bool = False,
    visual_effect: str = "none",
    fog_quality: str = "medium",
    progress_callback=None,
):
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    visual_effect = tuple(sorted(normalize_visual_effects(visual_effect)))
    frame_count = int(math.ceil(duration * fps))
    print(f"video duration={duration:.3f}s fps={fps} frames={frame_count}")
    background_image = None
    if background_image_path is not None and background_opacity > 0:
        background_image = Image.open(background_image_path).convert("RGB")
        print(f"background loaded: {background_image.width}x{background_image.height} opacity={background_opacity:.2f}")
    elif background_image_path is not None:
        print(f"background skipped: opacity={background_opacity:.2f}")
    render_cache = build_render_cache(width, height, background_image, background_opacity, background_base, show_grid)
    video_encoder_args = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
    print("using CPU encoder: libx264")
    command = [
        ffmpeg,
        "-y",
        "-f",
        "rawvideo",
        "-vcodec",
        "rawvideo",
        "-s",
        f"{width}x{height}",
        "-pix_fmt",
        "rgb24",
        "-framerate",
        str(fps),
        "-i",
        "-",
        "-i",
        str(audio_wav),
        "-r",
        str(fps),
        *video_encoder_args,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        str(output_mp4),
    ]

    worker_count = get_render_worker_count()
    print(f"render workers={worker_count}")

    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    try:
        write_rendered_frames(
            process,
            notes,
            width,
            height,
            fps,
            frame_count,
            background_image,
            background_opacity,
            background_base,
            note_color,
            show_grid,
            visual_effect,
            fog_quality,
            render_cache,
            worker_count,
            progress_callback,
        )
    finally:
        if process.stdin:
            process.stdin.close()
    return_code = process.wait()
    if return_code:
        raise RuntimeError(f"ffmpeg failed with exit code {return_code}")


def get_render_worker_count():
    return 8


def write_rendered_frames(
    process,
    notes,
    width: int,
    height: int,
    fps: int,
    frame_count: int,
    background_image,
    background_opacity: float,
    background_base: str,
    note_color: str,
    show_grid: bool,
    visual_effect: str,
    fog_quality: str,
    render_cache,
    worker_count: int,
    progress_callback=None,
):
    progress_interval = max(1, fps * 5)
    pending_limit = max(worker_count * 2, 4)

    def render_frame_bytes(frame: int):
        current_time = frame / fps
        return render_frame(
            notes,
            width,
            height,
            current_time,
            background_image,
            background_opacity,
            background_base,
            note_color,
            show_grid,
            visual_effect,
            fog_quality,
            render_cache,
        ).tobytes()

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        pending = {}
        next_submit = 0
        next_write = 0

        while next_submit < frame_count and len(pending) < pending_limit:
            pending[next_submit] = executor.submit(render_frame_bytes, next_submit)
            next_submit += 1

        while next_write < frame_count:
            frame_bytes = pending.pop(next_write).result()
            process.stdin.write(frame_bytes)

            if next_write % progress_interval == 0:
                print(f"rendered {next_write}/{frame_count} frames")
                if progress_callback:
                    progress_callback(next_write, frame_count)

            next_write += 1

            while next_submit < frame_count and len(pending) < pending_limit:
                pending[next_submit] = executor.submit(render_frame_bytes, next_submit)
                next_submit += 1

        if progress_callback:
            progress_callback(frame_count, frame_count)


def main():
    parser = argparse.ArgumentParser(description="Offline export MIDI waterfall animation to MP4.")
    parser.add_argument("midi", type=Path, help="Input MIDI file")
    parser.add_argument("-o", "--output", type=Path, default=Path("piano-waterfall.mp4"))
    parser.add_argument("--sfz", type=Path, default=Path(DEFAULT_SFZ))
    parser.add_argument("--width", type=int, default=1600)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--sample-rate", type=int, default=44100)
    parser.add_argument("--max-seconds", type=float, default=None, help="Optional short export for testing")
    parser.add_argument("--auto-sustain", action="store_true", help="Add automatic sustain to audio")
    parser.add_argument("--auto-sustain-seconds", type=float, default=0.5)
    parser.add_argument("--note-color", default="#2de1b4", help="Base note color as #RRGGBB")
    parser.add_argument(
        "--visual-effect",
        default="none",
        help="Comma-separated effects: trail, glow, fog, stream, colorShift, or none",
    )
    parser.add_argument("--background-base", choices=("default", "black"), default="default")
    parser.add_argument("--background-image", type=Path, default=None)
    parser.add_argument("--background-opacity", type=float, default=0.0)
    parser.add_argument("--show-grid", action="store_true")
    parser.add_argument("--fog-quality", choices=("low", "medium", "high"), default="medium")
    args = parser.parse_args()

    if not re.fullmatch(r"#[0-9a-fA-F]{6}", args.note_color or ""):
        parser.error("--note-color must use #RRGGBB format, for example #2de1b4")

    unknown_effects = unknown_visual_effects(args.visual_effect)
    if unknown_effects:
        parser.error(
            "--visual-effect contains unknown value(s): "
            + ", ".join(unknown_effects)
            + ". Available effects: trail, glow, fog, stream, colorShift, none"
        )

    if args.background_opacity < 0 or args.background_opacity > 1:
        parser.error("--background-opacity must be between 0 and 1")

    if args.background_image is not None and not args.background_image.exists():
        parser.error(f"--background-image does not exist: {args.background_image}")

    song = parse_midi(args.midi)
    regions = parse_sfz(args.sfz)
    duration = get_playback_duration(
        song["notes"],
        song["playback_duration"],
        args.auto_sustain,
        args.auto_sustain_seconds,
    ) + 0.25
    if args.max_seconds:
        duration = min(duration, args.max_seconds)
        notes = [note for note in song["notes"] if note.start <= duration]
    else:
        notes = song["notes"]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = args.output.parent / "_tmp_export"
    temp_dir.mkdir(exist_ok=True)
    audio_wav = temp_dir / "audio.wav"
    print("synthesizing audio")
    synthesize_audio(
        notes,
        regions,
        audio_wav,
        args.sample_rate,
        duration,
        args.auto_sustain,
        args.auto_sustain_seconds,
    )
    print("encoding mp4")
    export_video(
        notes,
        args.output,
        audio_wav,
        args.width,
        args.height,
        args.fps,
        duration,
        background_image_path=args.background_image,
        background_opacity=args.background_opacity,
        background_base=args.background_base,
        note_color=args.note_color,
        show_grid=args.show_grid,
        visual_effect=args.visual_effect,
        fog_quality=args.fog_quality,
    )

    try:
        audio_wav.unlink()
        temp_dir.rmdir()
    except OSError:
        pass

    print(f"exported {args.output.resolve()}")


if __name__ == "__main__":
    main()
