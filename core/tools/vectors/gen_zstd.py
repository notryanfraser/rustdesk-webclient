# zstd test vectors for the clipboard decoder: libzstd frames made like the peer's
# hbb_common::compress (zstd::bulk::Compressor: content size in the header, no checksum, no
# dictionary) at the peer's level 3, plus levels 1 and 19. Deterministic (fixed seed).
#
# docker run --rm -v "$PWD/core:/core" python:3.12-alpine sh -c \
# 'pip install -q zstandard==0.25.0 && python /core/tools/vectors/gen_zstd.py > /core/fixtures/zstd-vectors.json'
import base64, hashlib, json, random, zstandard

rng = random.Random(42)
words = "the quick brown fox jumps over lazy dog remote desktop clipboard 文字 ünïcödé emoji 😀 tab\tnewline\n".split(" ")


def text(n):
    out, size = [], 0
    while size < n:
        w = rng.choice(words)
        out.append(w)
        size += len(w.encode()) + 1
    return " ".join(out).encode()[:n]


inputs = {
    "empty": b"",
    "short": b"hello clipboard",
    "unicode": "Grüße 文字 😀 — tabs\tand\r\nCRLF".encode(),
    "text-64k": text(65536),
    "random-4k": bytes(rng.getrandbits(8) for _ in range(4096)),
    "text-1m": text(1 << 20),
}
vectors = []
for name, data in inputs.items():
    for level in (1, 3, 19):
        if name == "text-1m" and level != 3:
            continue  # keep the fixture small: the peer's level only
        frame = zstandard.ZstdCompressor(level=level, write_content_size=True, write_checksum=False).compress(data)
        vectors.append({
            "name": f"{name}-l{level}",
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "frame": base64.b64encode(frame).decode(),
        })
print(json.dumps({"libzstd": ".".join(map(str, zstandard.ZSTD_VERSION)), "python_zstandard": zstandard.__version__, "vectors": vectors}, indent=1))
