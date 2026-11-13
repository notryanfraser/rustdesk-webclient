// AudioStream: the session side of audio. Routes Misc.audio_format / AudioFrame to an
// AudioSink and implements mute. No browser APIs; the decode/playback half is AudioPlayer.
//
// Upstream behaviour (rustdesk 1.5.3):
// * The peer's audio service sends Misc.audio_format{sample_rate, channels} when the connection
// subscribes (a service snapshot, src/server/audio_service.rs 128-135 / create_format_msg
// 614-622), then one AudioFrame per Opus packet. On Linux: 48 kHz stereo, Opus LowDelay,
// 10 ms per packet (AUDIO_DATA_SIZE_U8 = 960 f32 = 480 stereo frames).
// * After ~800 consecutive all-zero packets (MAX_AUDIO_ZERO_COUNT, "noise gate", 625-659) the
// peer stops sending until the sound returns: silence on the wire is a gap, not an error.
// * OptionMessage.disable_audio = Yes unsubscribes this connection from the audio service, No
// subscribes it again (connection.rs update_options 4995-5015), and the peer then sends
// audio_format again. Mute therefore stops the stream at the source and silences locally at
// once; unmute waits for the new audio_format.

import { create } from "@bufbuild/protobuf";
import {
  MessageSchema,
  MiscSchema,
  OptionMessageSchema,
  OptionMessage_BoolOption,
} from "../gen/message_pb.js";
import type { Message } from "../gen/message_pb.js";
import type { SessionEvent } from "../session/session.js";

export interface AudioOutputFormat {
  sampleRate: number;
  channels: number;
}

/** Where AudioStream sends audio. Implementations must not throw. */
export interface AudioSink {
  /** A (new) format: (re)configure the decoder; may be called again mid-stream. */
  configure(format: AudioOutputFormat): void;
  /** One Opus packet. Ignored until configured. */
  push(packet: Uint8Array): void;
  setMuted(muted: boolean): void;
  close(): void;
}

export interface AudioStreamStats {
  formats: number;
  frames: number;
  bytes: number;
  /** Frames that arrived before any audio_format (dropped). */
  framesBeforeFormat: number;
  muted: boolean;
}

export class AudioStream {
  private session: { send(m: Message): void } | undefined;
  private readonly outbox: Message[] = [];
  private configured = false;
  private closed = false;
  private readonly counts: AudioStreamStats = {
    formats: 0,
    frames: 0,
    bytes: 0,
    framesBeforeFormat: 0,
    muted: false,
  };

  constructor(private readonly sink: AudioSink) {}

  /** Pass as (or call from) connectSession's onEvent so the first audio_format is not missed. */
  readonly onEvent = (e: SessionEvent): void => {
    if (e.type === "message") this.handle(e.message);
    else this.close();
  };

  attach(session: { send(m: Message): void }): void {
    this.session = session;
    for (const m of this.outbox.splice(0)) session.send(m);
  }

  get stats(): AudioStreamStats {
    return { ...this.counts };
  }

  handle(msg: Message): void {
    if (this.closed) return;
    const u = msg.union;
    if (u.case === "misc" && u.value.union.case === "audioFormat") {
      const f = u.value.union.value;
      this.counts.formats++;
      this.configured = true;
      this.sink.configure({ sampleRate: f.sampleRate, channels: f.channels });
    } else if (u.case === "audioFrame") {
      if (!this.configured) {
        this.counts.framesBeforeFormat++;
        return;
      }
      this.counts.frames++;
      this.counts.bytes += u.value.data.length;
      // Own the bytes: protobuf-es fields can be views into a shared buffer.
      this.sink.push(u.value.data.slice());
    }
  }

  /** Mute: silence now, and ask the peer to stop sending (disable_audio). */
  setMuted(muted: boolean): void {
    if (this.closed || muted === this.counts.muted) return;
    this.counts.muted = muted;
    this.sink.setMuted(muted);
    const option = create(OptionMessageSchema, {
      disableAudio: muted
        ? OptionMessage_BoolOption.Yes
        : OptionMessage_BoolOption.No,
    });
    const m = create(MessageSchema, {
      union: {
        case: "misc",
        value: create(MiscSchema, { union: { case: "option", value: option } }),
      },
    });
    if (this.session) {
      try {
        this.session.send(m);
      } catch {
        this.close(); // session already closed
      }
    } else this.outbox.push(m);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sink.close();
  }
}
