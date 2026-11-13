// What this browser's WebCodecs decodes, and whether it offers a hardware decoder for it.
// Browser-only at runtime (VideoDecoder); without it the answer is "nothing". Run once before
// login: the result decides which codecs we declare to the peer (option.ts) and how the
// pipeline configures its decoders (pipeline.ts).
//
// H.264 and H.265 matter because they are the only codecs a peer encodes on its GPU
// (rustdesk hwcodec); VP8, VP9 and AV1 are always encoded in software there.
import type { DecoderChoices, VideoCodec } from "./types.js";
import { CODEC_STRINGS } from "./types.js";

// Tried in order. The peer's stream carries its own profile and level (in-band parameter
// sets); the string only has to be one the browser accepts.
const CANDIDATES: Record<VideoCodec, string[]> = {
  vp9: [CODEC_STRINGS.vp9],
  vp8: [CODEC_STRINGS.vp8],
  av1: [CODEC_STRINGS.av1],
  h264: [CODEC_STRINGS.h264, "avc1.64002a", "avc1.42e01f"],
  h265: [CODEC_STRINGS.h265, "hev1.1.6.L153.B0"],
};

async function supported(config: VideoDecoderConfig): Promise<boolean> {
  try {
    return (await VideoDecoder.isConfigSupported(config)).supported === true;
  } catch {
    return false;
  }
}

export async function probeDecoders(): Promise<DecoderChoices> {
  const out: DecoderChoices = {};
  if (typeof VideoDecoder === "undefined") return out;
  await Promise.all(
    (Object.keys(CANDIDATES) as VideoCodec[]).map(async (c) => {
      for (const hardware of [true, false])
        for (const codec of CANDIDATES[c]) {
          const ok = await supported({
            codec,
            optimizeForLatency: true,
            ...(hardware
              ? { hardwareAcceleration: "prefer-hardware" as const }
              : {}),
          });
          if (ok) {
            out[c] = { codec, hardware };
            return;
          }
        }
    }),
  );
  return out;
}
