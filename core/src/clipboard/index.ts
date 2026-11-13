// Clipboard messages: text in both directions. Pure TS; the browser side (Clipboard API,
// paste events) lives in the app.
//
// Upstream (rustdesk 1.5.3 src/clipboard.rs):
// * A peer sends `Message.clipboard` (one Clipboard) to controllers that do not support multiple
// formats, and `Message.multi_clipboards` to those that do: is_support_multi_clipboard
// (549-562) requires LoginRequest.version >= 1.3.0 and a platform other than "" / iOS. We send
// no version, so we get the single text clipboard (get_msg_if_not_support_multi_clip 788-807);
// multi_clipboards is still read here, first Text entry, in case a caller announces a version.
// * content is zstd-compressed when that makes it smaller (`compress`, plain_to_proto 646-660);
// decoded with fzstd, bounded by a size limit as it decodes.
// * We send text uncompressed (`compress = false`), which the peer accepts (from_clipboard 747-751).
import { create } from "@bufbuild/protobuf";
import { Decompress } from "fzstd";
import {
  ClipboardFormat,
  ClipboardSchema,
  MessageSchema,
} from "../gen/message_pb.js";
import type { Clipboard, Message } from "../gen/message_pb.js";

/** Largest decoded clipboard we accept, bytes (the peer itself allows 256 MB). */
export const CLIPBOARD_MAX_BYTES = 32 * 1024 * 1024;

export class ClipboardTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`clipboard larger than ${limit} bytes`);
    this.name = "ClipboardTooLargeError";
  }
}

/** Decode one zstd frame (as hbb_common::compress makes them), stopping at `limit` bytes. */
export function zstdDecompress(
  frame: Uint8Array,
  limit = CLIPBOARD_MAX_BYTES,
): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  const d = new Decompress((chunk) => {
    total += chunk.length;
    if (total > limit) throw new ClipboardTooLargeError(limit);
    if (chunk.length) parts.push(chunk);
  });
  d.push(frame, true);
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The text of a Clipboard (Text format only), or undefined for other formats. */
export function clipboardText(
  cb: Clipboard,
  limit = CLIPBOARD_MAX_BYTES,
): string | undefined {
  if (cb.format !== ClipboardFormat.Text) return undefined;
  const bytes = cb.compress ? zstdDecompress(cb.content, limit) : cb.content;
  if (bytes.length > limit) throw new ClipboardTooLargeError(limit);
  return new TextDecoder().decode(bytes);
}

/**
 * The text a peer message carries for the clipboard, or undefined if the message is not a
 * clipboard update (or carries no text). Throws on corrupt or oversized content.
 */
export function readClipboardMessage(
  msg: Message,
  limit = CLIPBOARD_MAX_BYTES,
): string | undefined {
  const u = msg.union;
  if (u.case === "clipboard") return clipboardText(u.value, limit);
  if (u.case === "multiClipboards")
    for (const cb of u.value.clipboards) {
      const t = clipboardText(cb, limit);
      if (t !== undefined) return t;
    }
  return undefined;
}

/** Message.clipboard with `text`, uncompressed, format Text. */
export function textClipboardMessage(text: string): Message {
  return create(MessageSchema, {
    union: {
      case: "clipboard",
      value: create(ClipboardSchema, {
        compress: false,
        content: new TextEncoder().encode(text),
        format: ClipboardFormat.Text,
      }),
    },
  });
}
