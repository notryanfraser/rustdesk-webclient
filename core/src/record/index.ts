// Session recording, protocol side. Upstream (rustdesk 1.5.3):
// * The peer's "recording" permission ("Enable recording session"): at the start of a session
// the peer sends PermissionInfo{Recording, enabled: false} only when recording is NOT allowed,
// and sends the new state whenever its user toggles it (src/server/connection.rs 694-696,
// 867-869). So: allowed until told otherwise.
// * Misc.client_record_status{true|false} tells the peer a controller records
// (connection.rs 4031-4034). Its video service then restarts the encoder ("switch due to
// record changed") with a keyframe every 240 frames, so a recording stays decodable throughout
// (video_service.rs 1489-1492, get_encoder_config keyframe_interval); the restart also gives
// the keyframe a new recording starts on.
// The file itself is written by WebmWriter (webm.ts).
import { create } from "@bufbuild/protobuf";
import {
  MessageSchema,
  MiscSchema,
  PermissionInfo_Permission,
} from "../gen/message_pb.js";
import type { Message } from "../gen/message_pb.js";

export * from "./webm.js";

/** Misc.client_record_status: tell the peer whether we are recording. */
export function recordStatusMessage(recording: boolean): Message {
  return create(MessageSchema, {
    union: {
      case: "misc",
      value: create(MiscSchema, {
        union: { case: "clientRecordStatus", value: recording },
      }),
    },
  });
}

/** The peer's recording permission if `msg` announces it, else undefined. */
export function readRecordingPermission(msg: Message): boolean | undefined {
  const u = msg.union;
  if (u.case !== "misc" || u.value.union.case !== "permissionInfo")
    return undefined;
  const p = u.value.union.value;
  return p.permission === PermissionInfo_Permission.Recording
    ? p.enabled
    : undefined;
}
