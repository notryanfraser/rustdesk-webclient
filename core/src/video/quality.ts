// Image quality and frame rate the controller asks for, as the native client sends them
// (rustdesk 1.5.3 src/client.rs get_option_message 3382-3406, save_image_quality,
// save_custom_image_quality 3545-3557, set_custom_fps 3595-3611):
// * a preset goes in OptionMessage.image_quality (Low / Balanced / Best);
// * "custom" is a percentage of the Balanced bitrate in custom_image_quality, shifted left by 8
// (the peer reads (q >> 8 & 0xFFF) * 2 / 100 as a bitrate ratio, clamped to 0.2..40,
// src/server/video_qos.rs user_image_quality 435-455); the native UI offers 10..2000, and caps
// it at 100 on the public server;
// * custom_fps asks for a frame rate; the peer ignores values outside 1..120 (MIN_FPS..MAX_FPS,
// video_qos.rs 52-53, user_custom_fps).
// At login they ride in LoginRequest.option; mid-session in Misc.option, which the peer applies in
// update_options (connection.rs 4925-4950).
import { create } from "@bufbuild/protobuf";
import {
  ImageQuality,
  MessageSchema,
  MiscSchema,
  OptionMessageSchema,
} from "../gen/message_pb.js";
import type { Message, OptionMessage } from "../gen/message_pb.js";

export type QualityPreset = "low" | "balanced" | "best";
export type ImageQualitySetting = QualityPreset | { custom: number };

/** The native client's custom-quality range, in percent of Balanced. */
export const CUSTOM_QUALITY_MIN = 10;
export const CUSTOM_QUALITY_MAX = 2000;
export const FPS_MIN = 1;
export const FPS_MAX = 120;

export interface QualityOptions {
  quality?: ImageQualitySetting;
  /** Frames per second to ask for (1..120). */
  fps?: number;
}

const presets: Record<QualityPreset, ImageQuality> = {
  low: ImageQuality.Low,
  balanced: ImageQuality.Balanced,
  best: ImageQuality.Best,
};

/** Set the quality and frame-rate fields of `option` (a new OptionMessage when omitted). */
export function applyQualityOptions(
  o: QualityOptions,
  option: OptionMessage = create(OptionMessageSchema),
): OptionMessage {
  const q = o.quality;
  if (typeof q === "string") option.imageQuality = presets[q];
  else if (q) {
    const pct = Math.round(
      Math.min(CUSTOM_QUALITY_MAX, Math.max(CUSTOM_QUALITY_MIN, q.custom)),
    );
    option.imageQuality = ImageQuality.NotSet;
    option.customImageQuality = pct << 8;
  }
  if (o.fps !== undefined)
    option.customFps = Math.round(Math.min(FPS_MAX, Math.max(FPS_MIN, o.fps)));
  return option;
}

/** Misc.option message: change quality / frame rate during a session. */
export function qualityMessage(o: QualityOptions): Message {
  return create(MessageSchema, {
    union: {
      case: "misc",
      value: create(MiscSchema, {
        union: { case: "option", value: applyQualityOptions(o) },
      }),
    },
  });
}
