import base64
import json
import socket
import shutil
import threading
import time
import traceback
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse


ROOT = Path(__file__).resolve().parent
EXPORT_DIR = ROOT / "exports"
EXAMPLE_DIR = ROOT / "assets" / "examples"
EXPORT_PROGRESS = {}
EXPORT_PROGRESS_LOCK = threading.Lock()


def load_export_mp4():
    try:
        import export_mp4
    except ModuleNotFoundError as exc:
        missing = exc.name or "a required package"
        raise RuntimeError(
            f"MP4 export requires missing Python package '{missing}'. "
            "Install project dependencies with: python -m pip install -r requirements.txt"
        ) from exc
    return export_mp4


def set_export_progress(export_id, percent, phase, message):
    if not export_id:
        return
    with EXPORT_PROGRESS_LOCK:
        EXPORT_PROGRESS[export_id] = {
            "percent": max(0, min(100, int(percent))),
            "phase": phase,
            "message": message,
            "doneFrames": None,
            "totalFrames": None,
            "updatedAt": time.time(),
        }


def get_export_progress(export_id):
    with EXPORT_PROGRESS_LOCK:
        return EXPORT_PROGRESS.get(export_id, {
            "percent": 0,
            "phase": "unknown",
            "message": "未找到导出任务",
            "updatedAt": time.time(),
        })

def list_example_files():
    groups = {
        "midi": {".mid", ".midi"},
        "image": {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"},
    }
    result = {"midi": [], "image": []}

    for group, extensions in groups.items():
        directory = EXAMPLE_DIR / group
        if not directory.exists():
            continue
        for path in sorted(directory.iterdir(), key=lambda item: item.name.lower()):
            if not path.is_file() or path.suffix.lower() not in extensions:
                continue
            result[group].append({
                "name": path.name,
                "url": "/".join(["assets", "examples", group, quote(path.name)]),
                "size": path.stat().st_size,
            })

    return result


def get_lan_ip():
    try:
        # 创建一个 IPv4 的 UDP 套接字
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            # 连接到一个外部地址（Google DNS，端口 80）
            sock.connect(("8.8.8.8", 80))
            # 获取本机在连接中使用的 IP 地址
            return sock.getsockname()[0]
    except OSError:
        return None


class PianoWaterfallHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed_url = urlparse(self.path)
        if parsed_url.path == "/api/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return

        if parsed_url.path == "/api/export-progress":
            query = parse_qs(parsed_url.query)
            export_id = (query.get("id") or [""])[0]
            progress = get_export_progress(export_id)
            data = json.dumps(progress, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        if parsed_url.path == "/api/examples":
            data = json.dumps(list_example_files(), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        super().do_GET()

    def do_POST(self):
        parsed_url = urlparse(self.path)
        if parsed_url.path != "/api/export-mp4":
            self.send_error(404, "Not found")
            return

        try:
            output_path = self.handle_export_mp4()
        except Exception as error:
            traceback.print_exc()
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(traceback.format_exc().encode("utf-8"))
            return

        try:
            data = output_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(data)))
            ascii_name = "".join(ch if ord(ch) < 128 else "_" for ch in output_path.name)
            encoded_name = quote(output_path.name)
            self.send_header(
                "Content-Disposition",
                f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded_name}",
            )
            self.end_headers()
            self.wfile.write(data)
        finally:
            try:
                output_path.unlink()
            except OSError:
                pass

    def handle_export_mp4(self):
        export_mp4 = load_export_mp4()
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            raise ValueError("No export data was uploaded")

        request_body = self.rfile.read(content_length)
        content_type = self.headers.get("Content-Type", "")

        if content_type.startswith("application/json"):
            payload = json.loads(request_body.decode("utf-8"))
            export_id = payload.get("exportId", "")
            set_export_progress(export_id, 2, "prepare", "正在解析导出数据")
            song = self.song_from_payload(payload)
            original_name = Path(unquote(payload.get("fileName", "input.mid"))).stem
            print(
                "Received parsed timeline: "
                f"notes={len(song['notes'])}, "
                f"duration={song['duration']:.3f}s, "
                f"playback={song['playback_duration']:.3f}s"
            )
        else:
            if not request_body.startswith(b"MThd"):
                raise ValueError("Uploaded data is not a MIDI file")
            original_name = Path(unquote(self.headers.get("X-Midi-Filename", "input.mid"))).stem
            print(f"Received MIDI bytes: {len(request_body)}")

        safe_name = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in original_name) or "waterfall"
        EXPORT_DIR.mkdir(exist_ok=True)

        temp_dir_path = EXPORT_DIR / f"_tmp_{uuid.uuid4().hex}"
        temp_dir_path.mkdir(exist_ok=False)
        try:
            midi_path = temp_dir_path / "input.mid"
            output_path = temp_dir_path / f"{safe_name}-waterfall.mp4"
            if not content_type.startswith("application/json"):
                midi_path.write_bytes(request_body)
                song = export_mp4.parse_midi(midi_path)
            regions = export_mp4.parse_sfz(ROOT / export_mp4.DEFAULT_SFZ)
            auto_sustain = bool(payload.get("autoSustain", False)) if content_type.startswith("application/json") else False
            auto_sustain_seconds = float(payload.get("autoSustainSeconds", 0.5)) if content_type.startswith("application/json") else 0.5
            auto_sustain_seconds = max(0, min(1, auto_sustain_seconds))
            playback_duration = export_mp4.get_playback_duration(
                song["notes"],
                song["playback_duration"],
                auto_sustain,
                auto_sustain_seconds,
            )
            duration = playback_duration + 0.25
            fps = int(payload.get("fps", 60)) if content_type.startswith("application/json") else 60
            fps = 30 if fps == 30 else 60
            width = int(payload.get("width", 1600)) if content_type.startswith("application/json") else 1600
            height = int(payload.get("height", 900)) if content_type.startswith("application/json") else 900
            if (width, height) not in ((1280, 720), (1600, 900)):
                width, height = 1600, 900
            note_color = payload.get("noteColor", "#2de1b4") if content_type.startswith("application/json") else "#2de1b4"
            background_base = payload.get("backgroundBase", "default") if content_type.startswith("application/json") else "default"
            if background_base not in ("default", "black"):
                background_base = "default"
            show_grid = bool(payload.get("showGrid", False)) if content_type.startswith("application/json") else False
            visual_effect = payload.get("visualEffect", "none") if content_type.startswith("application/json") else "none"
            fog_quality = payload.get("fogQuality", "medium") if content_type.startswith("application/json") else "medium"
            if fog_quality not in ("low", "medium", "high"):
                fog_quality = "medium"
            audio_wav = temp_dir_path / "audio.wav"
            background_image = None
            background_opacity = 0.0
            if content_type.startswith("application/json"):
                background_image = self.write_background_image(payload, temp_dir_path)
                background_opacity = max(0.0, min(1.0, float(payload.get("backgroundOpacity", 0))))
                print(
                    "Background image: "
                    f"{'yes' if background_image else 'no'}, "
                    f"opacity={background_opacity:.2f}"
                )
            if content_type.startswith("application/json"):
                set_export_progress(export_id, 8, "audio", "正在合成音频")
            export_mp4.synthesize_audio(
                song["notes"],
                regions,
                audio_wav,
                44100,
                duration,
                auto_sustain,
                auto_sustain_seconds,
            )
            if content_type.startswith("application/json"):
                set_export_progress(export_id, 20, "video", "正在渲染视频帧")

            def on_video_progress(done_frames, total_frames):
                if not content_type.startswith("application/json"):
                    return
                ratio = done_frames / max(1, total_frames)
                percent = int(ratio * 100)
                set_export_progress(
                    export_id,
                    percent,
                    "video",
                    f"正在渲染视频帧 {done_frames}/{total_frames}",
                )
                with EXPORT_PROGRESS_LOCK:
                    if export_id in EXPORT_PROGRESS:
                        EXPORT_PROGRESS[export_id]["doneFrames"] = done_frames
                        EXPORT_PROGRESS[export_id]["totalFrames"] = total_frames

            export_mp4.export_video(
                song["notes"],
                output_path,
                audio_wav,
                width,
                height,
                fps,
                duration,
                background_image,
                background_opacity,
                background_base,
                note_color,
                show_grid,
                visual_effect,
                fog_quality,
                on_video_progress if content_type.startswith("application/json") else None,
            )

            if content_type.startswith("application/json"):
                set_export_progress(export_id, 98, "finalize", "正在打包 MP4")
            final_path = EXPORT_DIR / output_path.name
            shutil.move(str(output_path), final_path)
            if content_type.startswith("application/json"):
                set_export_progress(export_id, 100, "done", "MP4 生成完成")
            return final_path
        finally:
            shutil.rmtree(temp_dir_path, ignore_errors=True)

    def write_background_image(self, payload, temp_dir_path):
        data_url = payload.get("backgroundImage")
        wants_background = bool(payload.get("hasBackgroundImage", False))
        if not data_url:
            if wants_background:
                raise ValueError("Frontend expected a background image, but none was sent")
            return None

        if "," in data_url:
            _, encoded = data_url.split(",", 1)
        else:
            encoded = data_url

        image_path = temp_dir_path / "background-image.jpg"
        image_bytes = base64.b64decode(encoded)
        if not image_bytes:
            raise ValueError("Background image payload was empty")
        image_path.write_bytes(image_bytes)
        print(f"Background payload bytes={len(image_bytes)}")
        return image_path

    def song_from_payload(self, payload):
        export_mp4 = load_export_mp4()
        notes = []
        for item in payload.get("notes", []):
            note = export_mp4.Note(
                midi=int(item["midi"]),
                velocity=int(item["velocity"]),
                start_tick=0,
                end_tick=0,
                playback_end_tick=0,
            )
            note.start = float(item["start"])
            note.end = float(item["end"])
            note.playback_end = float(item.get("playbackEnd", item["end"]))
            notes.append(note)

        if not notes:
            raise ValueError("No notes were provided for export")

        return {
            "notes": notes,
            "duration": float(payload.get("duration", max(note.end for note in notes))),
            "playback_duration": float(
                payload.get("playbackDuration", max(note.playback_end for note in notes))
            ),
        }


def main():
    server, host, port = create_server()
    print(f"Serving Piano Waterfall locally at http://127.0.0.1:{port}")
    lan_ip = get_lan_ip()
    if host == "0.0.0.0" and lan_ip:
        print(f"LAN access: http://{lan_ip}:{port}")
    elif host == "0.0.0.0":
        print(f"LAN access: http://<your-computer-LAN-IP>:{port}")
    else:
        print("LAN access is not available because Windows rejected binding to 0.0.0.0.")
        print("Try allowing Python through Windows Firewall, or run PowerShell as administrator.")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


def create_server():
    lan_ports = [5500, 8000, 8080, 5000, 3000]
    for port in lan_ports:
        try:
            return ThreadingHTTPServer(("0.0.0.0", port), PianoWaterfallHandler), "0.0.0.0", port
        except PermissionError as error:
            print(f"Cannot bind LAN address 0.0.0.0:{port}: {error}")
        except OSError as error:
            print(f"Cannot bind LAN address 0.0.0.0:{port}: {error}")

    fallback_port = 5500
    print("Falling back to local-only mode.")
    return ThreadingHTTPServer(("127.0.0.1", fallback_port), PianoWaterfallHandler), "127.0.0.1", fallback_port


if __name__ == "__main__":
    main()
