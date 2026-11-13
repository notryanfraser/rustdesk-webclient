// AudioStream on the real capture (fixtures/decoded/2026-11-12-audio-frames.json: a 440 Hz
// tone from a live 1.5.3 peer): format first, packets routed in order as owned bytes, mute via
// OptionMessage.disable_audio. Decoding and playback are browser-only.
import raw from "../fixtures/decoded/2026-11-12-audio-frames.json?raw";
import { describe, expect, it } from "vitest";
import {
  AudioStream,
  MessageSchema,
  OptionMessage_BoolOption,
  fromBinary,
  type AudioOutputFormat,
  type AudioSink,
  type Message,
} from "../src/index.js";

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
const fixture = JSON.parse(raw) as {
  entries: { kind: string; len?: number; hex: string }[];
};
const messages = fixture.entries.map((e) =>
  fromBinary(MessageSchema, bytes(e.hex)),
);
const frameCount = fixture.entries.filter(
  (e) => e.kind === "audio_frame",
).length;

class FakeSink implements AudioSink {
  formats: AudioOutputFormat[] = [];
  packets: Uint8Array[] = [];
  muted: boolean[] = [];
  closed = false;
  configure(f: AudioOutputFormat) {
    this.formats.push(f);
  }
  push(p: Uint8Array) {
    this.packets.push(p);
  }
  setMuted(m: boolean) {
    this.muted.push(m);
  }
  close() {
    this.closed = true;
  }
}

describe("captured audio fixture", () => {
  it("is audio_format (48 kHz stereo) then Opus packets", () => {
    expect(fixture.entries[0]!.kind).toBe("misc.audioFormat");
    const f = messages[0]!.union;
    expect(
      f.case === "misc" &&
        f.value.union.case === "audioFormat" &&
        f.value.union.value,
    ).toMatchObject({
      sampleRate: 48000,
      channels: 2,
    });
    expect(frameCount).toBeGreaterThan(200);
    // Opus TOC byte: config 0-31 in the top 5 bits; CELT-only fullband 10 ms is config 30/31.
    const toc = (messages[1]!.union.value as { data: Uint8Array }).data[0]!;
    expect(toc >> 3).toBeGreaterThanOrEqual(28);
  });
});

describe("AudioStream", () => {
  it("configures on audio_format and hands every packet over in order, as owned bytes", () => {
    const sink = new FakeSink();
    const a = new AudioStream(sink);
    for (const m of messages) a.handle(m);
    expect(sink.formats).toEqual([{ sampleRate: 48000, channels: 2 }]);
    expect(sink.packets).toHaveLength(frameCount);
    const lens = fixture.entries
      .filter((e) => e.kind === "audio_frame")
      .map((e) => e.len);
    expect(sink.packets.map((p) => p.length)).toEqual(lens);
    expect(sink.packets[0]!.byteOffset).toBe(0);
    expect(sink.packets[0]!.buffer.byteLength).toBe(sink.packets[0]!.length);
    expect(a.stats).toMatchObject({
      formats: 1,
      frames: frameCount,
      framesBeforeFormat: 0,
    });
  });

  it("drops packets that arrive before any audio_format", () => {
    const sink = new FakeSink();
    const a = new AudioStream(sink);
    a.handle(messages[1]!);
    expect(sink.packets).toHaveLength(0);
    expect(a.stats.framesBeforeFormat).toBe(1);
  });

  it("mute silences locally and sends disable_audio Yes; unmute sends No; queued until attach", () => {
    const sink = new FakeSink();
    const a = new AudioStream(sink);
    a.setMuted(true);
    a.setMuted(true); // no-op
    const sent: Message[] = [];
    a.attach({ send: (m) => sent.push(m) });
    a.setMuted(false);
    expect(sink.muted).toEqual([true, false]);
    const opts = sent.map((m) => {
      const u = m.union;
      return u.case === "misc" && u.value.union.case === "option"
        ? u.value.union.value.disableAudio
        : undefined;
    });
    expect(opts).toEqual([
      OptionMessage_BoolOption.Yes,
      OptionMessage_BoolOption.No,
    ]);
  });

  it("closes the sink when the session closes, then ignores input", () => {
    const sink = new FakeSink();
    const a = new AudioStream(sink);
    a.onEvent({ type: "closed", closed: { kind: "local", message: "" } });
    expect(sink.closed).toBe(true);
    a.handle(messages[0]!);
    expect(sink.formats).toHaveLength(0);
  });
});
