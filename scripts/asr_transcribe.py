#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""本地 ASR 兜底：用 servers/.asr 里的 faster-whisper + small 模型生成字幕。

用法:
    python scripts/asr_transcribe.py <audio-file> [--language zh] [--model PATH]

输出 stdout 为 JSON:
    {"language":"en","duration":245.8,"list":[{"from":1.39,"to":9.46,"text":"..."}]}
"""

import argparse
import json
import os
import sys
import time


def find_asr_root():
    here = os.path.dirname(os.path.abspath(__file__))
    # LiteBiliWebClient/scripts -> LiteBiliWebClient -> servers
    return os.path.abspath(os.path.join(here, "..", "..", ".asr"))


ASR_ROOT = find_asr_root()
sys.path.insert(0, os.path.join(ASR_ROOT, "lib"))


def decode_audio(path):
    import av
    import numpy as np

    container = av.open(path)
    try:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="flt", layout="mono", rate=16000)
        chunks = []
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
        if not chunks:
            raise RuntimeError("音频解码结果为空")
        return np.concatenate(chunks).astype(np.float32)
    finally:
        container.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--language", default="")
    parser.add_argument("--model", default=os.path.join(ASR_ROOT, "models", "small"))
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    started = time.time()
    audio = decode_audio(args.audio)
    duration = len(audio) / 16000.0
    model = WhisperModel(args.model, device="cpu", compute_type="int8", local_files_only=True)
    language = args.language.strip() or None
    segments, info = model.transcribe(
        audio,
        language=language,
        beam_size=1,
        # 歌曲/演唱会被 VAD 当成非语音整段跳过，歌词场景必须关闭 VAD。
        vad_filter=False,
        condition_on_previous_text=False,
    )
    items = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        items.append({
            "from": round(float(seg.start), 3),
            "to": round(float(seg.end), 3),
            "text": text,
        })

    json.dump({
        "language": getattr(info, "language", "") or "",
        "duration": round(float(duration), 3),
        "elapsed": round(time.time() - started, 3),
        "list": items,
    }, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
