// One live remote session: the core's pieces wired together. No UI here; the session view
// renders from the snapshot this exposes and calls its methods.
//
// connectSession -> Session (login, keepalive)
// VideoStream -> WorkerVideoSink -> video-worker.js (decode + draw on the canvas)
// AudioStream -> AudioPlayer (Opus decode + AudioWorklet jitter buffer)
// InputController -> keyboard/mouse from the canvas
//
// The canvas is transferred to the video worker (transferControlToOffscreen), which can happen
// once per element: every connection attempt needs a fresh canvas.
//
// All displays at once: the view renders a canvas for each other display and calls
// showAllDisplays(); each gets its own video worker and InputController with that display's
// geometry (so the mouse lands on the display it is over), while the primary display keeps the
// original canvas. VideoStream routes frames by display (sinkFor); showOneDisplay() undoes it.
import {
  AudioPlayer,
  AudioStream,
  InputController,
  VideoStream,
  WorkerVideoSink,
  connectSession,
  describeSessionClosed,
  videoLoginOption,
  decodingMessage,
  probeDecoders,
  qualityMessage,
  chatMessage,
  readChatMessage,
  type QualityOptions,
  type KeyboardInputMode,
  type AudioPlayerStats,
  type DecoderChoices,
  type DisplayInfo,
  type ErrorDescription,
  type RemoteGeometry,
  type Session,
  type SessionEvent,
  type VideoStats,
  type VideoSink,
  readRecordingPermission,
  recordStatusMessage,
} from "@rustdesk-web/core";
import type { DownloadTarget } from "./files";
import { SessionRecorder, type RecordingStatus } from "./recording";
import {
  ClipboardSync,
  isPasteShortcut,
  type ClipboardStatus,
} from "./clipboard";
import type { AppConfig } from "./config";

export interface LiveSnapshot {
  peerId: string;
  platform: string;
  version: string;
  displays: {
    index: number;
    /** Position on the remote desktop (orders displays shown side by side). */
    x: number;
    y: number;
    width: number;
    height: number;
    name: string;
  }[];
  display: number;
  muted: boolean;
  video?: VideoStats;
  audio?: AudioPlayerStats;
  /** Peer-measured round trip from its TestDelay probes, ms (-1 until the first one). */
  peerDelayMs: number;
  clipboard?: ClipboardStatus;
  /** This session's chat, oldest first; at most CHAT_LOG_MAX entries. */
  chat: ChatEntry[];
  /** Messages from the remote not yet seen (markChatRead clears it). */
  chatUnread: number;
  /** All displays shown at once. */
  allDisplays: boolean;
  /** Video stats of the other displays while allDisplays (the primary's are `video`). */
  videoOthers: Record<number, VideoStats>;
  /** The peer allows recording (its "Enable recording session"). */
  recordingAllowed: boolean;
  /** Set while recording. */
  recording?: RecordingStatus;
  /** Why the last recording ended on its own, for the view to show. */
  recordingNote?: string;
}

/** What can arrive before the session object exists (during connectSession). */
interface EarlyState {
  audioFormat?: { sampleRate: number; channels: number };
  recordingAllowed: boolean;
}

/** Another display shown beside the primary one. */
interface DisplayView {
  sink: WorkerVideoSink;
  input: InputController;
  geometry: RemoteGeometry;
}

export interface ChatEntry {
  from: "me" | "remote";
  text: string;
  /** ms since epoch */
  at: number;
}

const CHAT_LOG_MAX = 500;

export interface ConnectArgs {
  config: AppConfig;
  peerId: string;
  password: string;
  canvas: HTMLCanvasElement;
  /** Created in the Connect click handler, so the browser lets audio start. */
  player: AudioPlayer;
  onWaitingForApproval: () => void;
  /** Saved quality / frame rate for this peer, sent at login. */
  quality?: QualityOptions;
  /** Saved keyboard mode for this peer. */
  keyboardMode?: KeyboardInputMode;
}

export class LiveSession {
  private listeners = new Set<() => void>();
  private snap: LiveSnapshot;
  private geometry: RemoteGeometry;
  private input: InputController | undefined;
  private clipboard: ClipboardSync | undefined;
  private readonly displays: DisplayInfo[];
  private primarySink: VideoSink | undefined;
  private recorder: SessionRecorder | undefined;
  private readonly others = new Map<number, DisplayView>();
  private keyboardMode: KeyboardInputMode;

  /** Resolves once with why the session ended (undefined: we closed it). */
  readonly ended: Promise<ErrorDescription | undefined>;

  private constructor(
    private readonly session: Session,
    private readonly video: VideoStream,
    private readonly audio: AudioStream,
    peerId: string,
    canvas: HTMLCanvasElement,
    keyboardMode: KeyboardInputMode = "map",
    primarySink?: VideoSink,
    private readonly early: EarlyState = { recordingAllowed: true },
    /** What the browser decodes (probeDecoders()), for the other displays' workers. */
    private readonly decoders: DecoderChoices = {},
  ) {
    this.keyboardMode = keyboardMode;
    this.primarySink = primarySink;
    const pi = session.peerInfo;
    this.displays = pi.displays;
    const d = pi.displays[pi.currentDisplay];
    this.geometry = {
      x: d?.x ?? 0,
      y: d?.y ?? 0,
      width: d?.width ?? 0,
      height: d?.height ?? 0,
    };
    this.snap = {
      peerId,
      platform: pi.platform,
      version: pi.version,
      displays: pi.displays.map((x, index) => ({
        index,
        x: x.x,
        y: x.y,
        width: x.width,
        height: x.height,
        name: x.name,
      })),
      display: pi.currentDisplay,
      muted: false,
      peerDelayMs: -1,
      chat: [],
      chatUnread: 0,
      allDisplays: false,
      videoOthers: {},
      recordingAllowed: early.recordingAllowed,
    };
    this.input = new InputController({
      element: canvas,
      send: (m) => session.send(m),
      peerPlatform: pi.platform,
      geometry: this.geometry,
      isPasteShortcut,
      keyboardMode,
      // Touch is the gesture layer's (touch.ts): taps, long-press, drag, pinch-zoom.
      touch: "app",
    });
    this.clipboard = new ClipboardSync(
      canvas,
      (m) => session.send(m),
      (c) => this.patch({ clipboard: c }),
    );
    this.ended = session.closed.then((c) => {
      void this.recorder?.finish();
      this.recorder = undefined;
      this.closeOthers();
      this.input?.detach();
      this.clipboard?.detach();
      this.audio.close();
      this.video.close();
      return describeSessionClosed(c);
    });
  }

  /** Connect and wire everything; rejects with the core's typed errors (see describeError). */
  static async connect(a: ConnectArgs): Promise<LiveSession> {
    let live: LiveSession | undefined;
    const update = (patch: Partial<LiveSnapshot>) => live?.patch(patch);
    // H.264 / H.265 (the codecs a peer encodes on its GPU) are declared only where this
    // browser decodes them.
    const decoders = await probeDecoders();
    const able = { h264: !!decoders.h264, h265: !!decoders.h265 };
    // A browser can accept an H.264 / H.265 configuration and still fail on the peer's stream.
    // Three stats reports in a row with new decode errors and nothing drawn: stop declaring
    // that codec, and the peer goes back to VP9.
    let strikes = 0;
    let seen = { decodeErrors: 0, rendered: 0 };
    const watchDecoder = (s: VideoStats) => {
      const failing =
        s.decodeErrors > seen.decodeErrors && s.rendered === seen.rendered;
      if (s.rendered > seen.rendered) strikes = 0;
      seen = { decodeErrors: s.decodeErrors, rendered: s.rendered };
      if (!failing || (s.codec !== "h264" && s.codec !== "h265")) return;
      if (!able[s.codec] || ++strikes < 3) return;
      strikes = 0;
      able[s.codec] = false;
      live?.send(decodingMessage(able));
    };
    const worker = new Worker("video-worker.js", { type: "module" });
    const primarySink = new WorkerVideoSink(worker, a.canvas, {
      decoders,
      onStats: (s) => {
        watchDecoder(s);
        update({ video: s });
      },
      onResize: (width, height) => live?.setSize(width, height),
    });
    // The primary display's frames also feed a recording, when there is one.
    const tee: VideoSink = {
      submit: (chunks) => {
        live?.recorder?.video(chunks);
        return primarySink.submit(chunks);
      },
      close: () => primarySink.close(),
    };
    const early: EarlyState = { recordingAllowed: true };
    const video = new VideoStream({
      sink: tee,
      // Before the session is live every frame goes to the primary canvas, as with one display.
      sinkFor: (d) => (live ? live.sinkFor(d) : tee),
      onSwitchDisplay: (d) =>
        live?.onSwitchDisplay(d.display, d.x, d.y, d.width, d.height),
    });
    // The player was created in the Connect click handler (audio needs a user gesture); its
    // stats reach the snapshot through setAudioStats().
    const audio = new AudioStream(a.player);
    const onEvent = (e: SessionEvent) => {
      video.onEvent(e);
      audio.onEvent(e);
      if (e.type === "message") {
        const u = e.message.union;
        if (u.case === "audioFrame")
          live?.recorder?.audio(u.value.data.slice());
        else if (u.case === "misc" && u.value.union.case === "audioFormat")
          early.audioFormat = {
            sampleRate: u.value.union.value.sampleRate,
            channels: u.value.union.value.channels,
          };
        const allowed = readRecordingPermission(e.message);
        if (allowed !== undefined) {
          early.recordingAllowed = allowed;
          live?.setRecordingAllowed(allowed);
        }
        live?.clipboard?.onMessage(e.message);
        const text = readChatMessage(e.message);
        if (text !== undefined) live?.addChat("remote", text);
      }
      if (
        e.type === "message" &&
        e.message.union.case === "testDelay" &&
        !e.message.union.value.fromClient
      )
        update({ peerDelayMs: e.message.union.value.lastDelay });
    };
    try {
      const { session } = await connectSession({
        idServer: a.config.idServer,
        serverKey: a.config.key,
        peerId: a.peerId,
        password: a.password,
        pageIsHttps: a.config.wss,
        option: videoLoginOption({ ...a.quality, ...able }),
        autoAckVideo: false,
        onEvent,
        onWaitingForApproval: a.onWaitingForApproval,
      });
      video.attach(session);
      audio.attach(session);
      live = new LiveSession(
        session,
        video,
        audio,
        a.peerId,
        a.canvas,
        a.keyboardMode,
        tee,
        early,
        decoders,
      );
      return live;
    } catch (e) {
      video.close();
      audio.close();
      throw e;
    }
  }

  get snapshot(): LiveSnapshot {
    return this.snap;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Audio stats arrive through the player's callback, owned by the view. */
  setAudioStats(s: AudioPlayerStats): void {
    this.patch({ audio: s });
  }

  switchDisplay(index: number): void {
    const d = this.displays[index];
    if (!d || index === this.snap.display || this.snap.allDisplays) return;
    this.video.switchDisplay(index);
    this.onSwitchDisplay(index, d.x, d.y, d.width, d.height);
  }

  setMuted(muted: boolean): void {
    this.audio.setMuted(muted);
    this.patch({ muted });
  }

  /** Change image quality / frame rate now (Misc.option). */
  setQuality(o: QualityOptions): void {
    this.send(qualityMessage(o));
  }

  private send(m: Parameters<Session["send"]>[0]): void {
    try {
      this.session.send(m);
    } catch {
      // session already closed
    }
  }

  /** Keyboard / pointer input, for the touch layer and the key bar. */
  get inputController(): InputController | undefined {
    return this.input;
  }

  /** The input controller of a display's canvas: the primary's, or another shown beside it. */
  inputFor(display: number): InputController | undefined {
    return display === this.snap.display
      ? this.input
      : this.others.get(display)?.input;
  }

  setKeyboardMode(mode: KeyboardInputMode): void {
    this.keyboardMode = mode;
    this.input?.setKeyboardMode(mode);
    for (const v of this.others.values()) v.input.setKeyboardMode(mode);
  }

  /**
   * Show every display at once. `canvases` holds a fresh canvas for each display other
   * than the primary (snapshot.display), which keeps its own.
   */
  showAllDisplays(canvases: Map<number, HTMLCanvasElement>): void {
    if (this.snap.allDisplays) return;
    for (const [index, canvas] of canvases) {
      const d = this.displays[index];
      if (!d || index === this.snap.display) continue;
      const geometry = { x: d.x, y: d.y, width: d.width, height: d.height };
      const view: DisplayView = {
        geometry,
        sink: new WorkerVideoSink(
          new Worker("video-worker.js", { type: "module" }),
          canvas,
          {
            decoders: this.decoders,
            onStats: (s) =>
              this.patch({
                videoOthers: { ...this.snap.videoOthers, [index]: s },
              }),
            onResize: (width, height) => {
              view.geometry = { ...view.geometry, width, height };
              view.input.setGeometry(view.geometry);
            },
          },
        ),
        input: new InputController({
          element: canvas,
          send: (m) => this.session.send(m),
          peerPlatform: this.snap.platform,
          geometry,
          isPasteShortcut,
          keyboardMode: this.keyboardMode,
          touch: "app",
        }),
      };
      this.others.set(index, view);
    }
    this.video.showDisplays([this.snap.display, ...this.others.keys()]);
    // Every display starts on a keyframe: its decoder is new.
    this.video.refresh();
    this.patch({ allDisplays: true });
  }

  /**
   * Record the session (primary display and audio) into `target` . Throws if the peer does
   * not allow it or its video is not VP9/VP8. Tells the peer (client_record_status), which
   * restarts its encoder: the keyframe the recording starts on follows.
   */
  startRecording(target: DownloadTarget): void {
    if (this.recorder) return;
    if (!this.snap.recordingAllowed)
      throw new Error("The remote does not allow recording this session.");
    const v = this.snap.video;
    const codec = v?.codec;
    if (codec !== "vp9" && codec !== "vp8")
      throw new Error(
        `Recording (WebM) needs VP9 or VP8 video; this remote sends ${codec ? codec.toUpperCase() : "no video yet"}.`,
      );
    this.recorder = new SessionRecorder(
      target,
      codec,
      {
        width: v!.width || this.geometry.width,
        height: v!.height || this.geometry.height,
      },
      this.early.audioFormat,
      (reason) => this.endRecording(reason),
    );
    this.sendQuiet(recordStatusMessage(true));
    this.patch({
      recording: { startedAt: this.recorder.startedAt, bytes: 0 },
      recordingNote: undefined,
    });
  }

  /** Stop recording and save the file. */
  async stopRecording(): Promise<void> {
    const r = this.recorder;
    if (!r) return;
    this.endRecording();
    await r.finish();
  }

  dismissRecordingNote(): void {
    this.patch({ recordingNote: undefined });
  }

  private endRecording(reason?: string): void {
    if (!this.recorder) {
      // already stopped by the user; a save that failed afterwards still deserves a word
      if (reason) this.patch({ recordingNote: reason });
      return;
    }
    this.recorder = undefined;
    this.sendQuiet(recordStatusMessage(false));
    this.patch({ recording: undefined, recordingNote: reason });
  }

  private setRecordingAllowed(allowed: boolean): void {
    this.patch({ recordingAllowed: allowed });
    if (!allowed && this.recorder) {
      const r = this.recorder;
      this.endRecording(
        "the remote stopped allowing recording; the recording so far is saved",
      );
      void r.finish();
    }
  }

  private sendQuiet(m: Parameters<Session["send"]>[0]): void {
    try {
      this.session.send(m);
    } catch {
      // session already closed
    }
  }

  /** Back to the primary display only. */
  showOneDisplay(): void {
    if (!this.snap.allDisplays) return;
    this.closeOthers();
    this.video.switchDisplay(this.snap.display);
    this.patch({ allDisplays: false, videoOthers: {} });
  }

  private sinkFor(display: number) {
    if (display === this.snap.display) return this.primarySink;
    return this.others.get(display)?.sink;
  }

  private closeOthers(): void {
    for (const v of this.others.values()) {
      v.input.detach();
      v.sink.close();
    }
    this.others.clear();
  }

  /** Send a chat message to the person at the remote machine. */
  sendChat(text: string): void {
    if (!text.trim()) return;
    try {
      this.session.send(chatMessage(text));
    } catch {
      return; // session already closed
    }
    this.addChat("me", text);
  }

  markChatRead(): void {
    if (this.snap.chatUnread) this.patch({ chatUnread: 0 });
  }

  private addChat(from: ChatEntry["from"], text: string): void {
    const chat = [...this.snap.chat, { from, text, at: Date.now() }].slice(
      -CHAT_LOG_MAX,
    );
    this.patch({
      chat,
      chatUnread: this.snap.chatUnread + (from === "remote" ? 1 : 0),
    });
  }

  ctrlAltDel(): void {
    this.input?.sendCtrlAltDel();
  }

  lockKeyboard(): Promise<boolean> {
    return this.input?.lockKeyboard() ?? Promise.resolve(false);
  }

  /** Leave: tells the peer, closes everything; `ended` then resolves with undefined. */
  async close(): Promise<void> {
    await this.session.close();
  }

  private onSwitchDisplay(
    index: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ) {
    // With all displays shown, the peer announces each display's geometry: update that one.
    const other = this.others.get(index);
    if (other) {
      other.geometry = { x, y, width, height };
      other.input.setGeometry(other.geometry);
      return;
    }
    this.geometry = { x, y, width, height };
    this.input?.setGeometry(this.geometry);
    this.patch({ display: index });
  }

  private setSize(width: number, height: number) {
    this.geometry = { ...this.geometry, width, height };
    this.input?.setGeometry(this.geometry);
  }

  private patch(p: Partial<LiveSnapshot>) {
    this.snap = { ...this.snap, ...p };
    for (const l of this.listeners) l();
  }
}
