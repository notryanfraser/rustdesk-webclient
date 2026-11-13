import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { MessageSchema, MiscSchema } from "../gen/message_pb.js";
import type { Message } from "../gen/message_pb.js";

type Union = NonNullable<Message["union"]>;

export function encodeMessage(msg: Message): Uint8Array {
  return toBinary(MessageSchema, msg);
}

export function encodeUnion(union: Union): Uint8Array {
  return encodeMessage(create(MessageSchema, { union }));
}

export function decodeMessage(frame: Uint8Array): Message {
  return fromBinary(MessageSchema, frame);
}

/**
 * Misc{close_reason: ""}: how a controller says goodbye. The 1.5.3 native client sends it on
 * a user-initiated close (src/client/io_loop.rs send_close_reason 669-679, Data::Close 759-761)
 * and the peer handles it first thing in on_message (src/server/connection.rs:2890-2897:
 * on_close("Peer close") + check_remove_session). The 1.2.5 web client sends nothing and just
 * closes the socket (websock.ts close()). An empty string still serialises (oneof presence).
 */
export function encodeCloseReason(reason = ""): Uint8Array {
  return encodeUnion({
    case: "misc",
    value: create(MiscSchema, {
      union: { case: "closeReason", value: reason },
    }),
  });
}
