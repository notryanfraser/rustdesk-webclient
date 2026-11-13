// Chat: Misc.chat_message both ways.
import { describe, expect, it } from "vitest";
import {
  CHAT_MAX_CHARS,
  MessageSchema,
  chatMessage,
  create,
  fromBinary,
  readChatMessage,
  toBinary,
} from "../src/index.js";

describe("chat", () => {
  it("builds Misc.chat_message and reads it back, unicode intact", () => {
    const text = "hello from the web ✓ Grüße 😀";
    const m = chatMessage(text);
    expect(m.union.case).toBe("misc");
    const wire = fromBinary(MessageSchema, toBinary(MessageSchema, m));
    expect(readChatMessage(wire)).toBe(text);
  });

  it("ignores other messages", () => {
    expect(readChatMessage(create(MessageSchema, {}))).toBeUndefined();
  });

  it("cuts text at CHAT_MAX_CHARS characters, not in the middle of a character", () => {
    const long = "😀".repeat(CHAT_MAX_CHARS + 5);
    const got = readChatMessage(chatMessage(long))!;
    expect([...got].length).toBe(CHAT_MAX_CHARS);
    expect(got.endsWith("😀")).toBe(true);
  });
});
