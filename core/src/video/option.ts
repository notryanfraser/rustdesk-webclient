import { create } from "@bufbuild/protobuf";
import {
  OptionMessageSchema,
  SupportedDecodingSchema,
  SupportedDecoding_PreferCodec,
} from "../gen/message_pb.js";
import type { OptionMessage } from "../gen/message_pb.js";
import { applyQualityOptions, type QualityOptions } from "./quality.js";

/**
 * LoginRequest.option declaring what we decode: VP9 and VP8, prefer VP9. No AV1
 * (WebKit claims support and then fails to decode it), no H264/H265, 4:2:0 only (i444 and
 * prefer_chroma left unset). The peer applies it in Encoder::update (rustdesk 1.5.3
 * libs/scrap/src/common/codec.rs 171-325); without it the peer would register us as VP9-only
 * (connection.rs update_codec_on_login 2745-2756), so the visible difference is VP8 being
 * usable when another controller prefers it. `prefer: "vp8"` trades compression for a much
 * cheaper encoder on the peer (see, frame rate).
 */
export function videoLoginOption(
  opts: { prefer?: "vp9" | "vp8" } & QualityOptions = {},
): OptionMessage {
  // Quality and frame rate start the session as saved instead of at the peer's default.
  return applyQualityOptions(
    opts,
    create(OptionMessageSchema, {
      supportedDecoding: create(SupportedDecodingSchema, {
        abilityVp9: 1,
        abilityVp8: 1,
        prefer:
          opts.prefer === "vp8"
            ? SupportedDecoding_PreferCodec.VP8
            : SupportedDecoding_PreferCodec.VP9,
      }),
    }),
  );
}
