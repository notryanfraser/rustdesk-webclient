// Public surface of @rustdesk-web/core.
// Generated protobuf types (package `hbb`, from rustdesk 1.5.3 protos).
// 64-bit integers are `bigint`, except fields upstream marks [jstype = JS_STRING]
// (CursorData.id, Message.cursor_id), which are decimal `string`s.
export * from "./gen/rendezvous_pb.js";
export * from "./gen/message_pb.js";
export { create, toBinary, fromBinary } from "@bufbuild/protobuf";
export * from "./errors.js";
export * from "./describe.js";
export * from "./transport/types.js";
export * from "./transport/ws.js";
export * from "./rendezvous/index.js";
export * from "./crypto/index.js";
export * from "./session/index.js";
export * from "./video/index.js";
export * from "./input/index.js";
export * from "./audio/index.js";
export * from "./clipboard/index.js";
export * from "./files/index.js";
export * from "./chat/index.js";
export * from "./record/index.js";
