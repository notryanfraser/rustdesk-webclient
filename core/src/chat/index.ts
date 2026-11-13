// Chat: text messages between the controller and the person at the remote machine.
//
// Upstream (rustdesk 1.5.3): Misc.chat_message{text} in both directions (message.proto
// ChatMessage). The peer hands it to its connection-manager window (the "Write a message" box
// beside Disconnect), marks the chat unanswered and resets its auto-disconnect timer
// (src/server/connection.rs 3921-3925); what the remote user types there comes back as the same
// message. Plain text: render it as text, never as HTML.
import { create } from "@bufbuild/protobuf";
import {
  ChatMessageSchema,
  MessageSchema,
  MiscSchema,
} from "../gen/message_pb.js";
import type { Message } from "../gen/message_pb.js";

/** Longest message sent (characters); longer text is cut. The protocol itself has no limit. */
export const CHAT_MAX_CHARS = 10_000;

/** Misc.chat_message carrying `text` (trimmed to CHAT_MAX_CHARS). */
export function chatMessage(text: string): Message {
  return create(MessageSchema, {
    union: {
      case: "misc",
      value: create(MiscSchema, {
        union: {
          case: "chatMessage",
          value: create(ChatMessageSchema, {
            text: [...text].slice(0, CHAT_MAX_CHARS).join(""),
          }),
        },
      }),
    },
  });
}

/** The text of a peer's chat message, or undefined if `msg` is not one. */
export function readChatMessage(msg: Message): string | undefined {
  const u = msg.union;
  if (u.case !== "misc" || u.value.union.case !== "chatMessage")
    return undefined;
  return u.value.union.value.text;
}
