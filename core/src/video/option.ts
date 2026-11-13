import { create } from "@bufbuild/protobuf";
import {
  MessageSchema,
  MiscSchema,
  OptionMessageSchema,
  SupportedDecodingSchema,
  SupportedDecoding_PreferCodec,
} from "../gen/message_pb.js";
import type {
  Message,
  OptionMessage,
  SupportedDecoding,
} from "../gen/message_pb.js";
import { applyQualityOptions, type QualityOptions } from "./quality.js";

export interface DecodingOptions {
  /** The browser decodes H.264 / H.265 (probeDecoders()). Default: neither. */
  h264?: boolean;
  h265?: boolean;
  /**
   * Default: H.264 when declared, else H.265 when declared, else VP9. A preference for a
   * codec that is not declared is ignored.
   */
  prefer?: "vp9" | "vp8" | "h264" | "h265";
}

const PREFER = {
  vp9: SupportedDecoding_PreferCodec.VP9,
  vp8: SupportedDecoding_PreferCodec.VP8,
  h264: SupportedDecoding_PreferCodec.H264,
  h265: SupportedDecoding_PreferCodec.H265,
};

/**
 * What we decode: VP9 and VP8 always, H.264 and H.265 when the caller says the browser can.
 * No AV1 (WebKit claims support and then fails to decode it), 4:2:0 only (i444 and
 * prefer_chroma left unset). The peer applies it in Encoder::update (rustdesk 1.5.3
 * libs/scrap/src/common/codec.rs 171-325); without it the peer would register us as VP9-only
 * (connection.rs update_codec_on_login 2745-2756).
 *
 * H.264 / H.265 are the codecs a peer can encode on its GPU, so they are preferred when
 * declared (H.264 first: the most widely hardware-decoded); a peer without a usable hardware
 * encoder keeps to VP9. `prefer: "vp8"` trades compression for a much cheaper software encoder
 * on the peer.
 */
export function supportedDecoding(o: DecodingOptions = {}): SupportedDecoding {
  const able = { vp9: true, vp8: true, h264: !!o.h264, h265: !!o.h265 };
  const prefer =
    o.prefer && able[o.prefer]
      ? o.prefer
      : able.h264
        ? "h264"
        : able.h265
          ? "h265"
          : "vp9";
  return create(SupportedDecodingSchema, {
    abilityVp9: 1,
    abilityVp8: 1,
    abilityH264: able.h264 ? 1 : 0,
    abilityH265: able.h265 ? 1 : 0,
    prefer: PREFER[prefer],
  });
}

/** LoginRequest.option: what we decode, and the saved quality and frame rate. */
export function videoLoginOption(
  opts: DecodingOptions & QualityOptions = {},
): OptionMessage {
  // Quality and frame rate start the session as saved instead of at the peer's default.
  return applyQualityOptions(
    opts,
    create(OptionMessageSchema, { supportedDecoding: supportedDecoding(opts) }),
  );
}

/** Misc.option message: change what we decode during a session (the peer may switch codec). */
export function decodingMessage(o: DecodingOptions): Message {
  return create(MessageSchema, {
    union: {
      case: "misc",
      value: create(MiscSchema, {
        union: {
          case: "option",
          value: create(OptionMessageSchema, {
            supportedDecoding: supportedDecoding(o),
          }),
        },
      }),
    },
  });
}
