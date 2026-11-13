// Session view: the remote screen (canvas), a toolbar, connection-state overlays and an optional
// stats overlay. Connects on mount (the canvas must exist first, see live.ts); reports the end of
// the session, or a failure to connect, through onEnded.
import { Fragment } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  describeError,
  type ErrorDescription,
  type VideoStats,
} from "@rustdesk-web/core";
import type { AppConfig } from "./config";
import { ChatPanel } from "./ChatPanel";
import { FilesPanel } from "./FilesPanel";
import { LiveSession, type LiveSnapshot } from "./live";
import type { Phase } from "./main";
import { loadRecent, rememberPeer } from "./recent";
import {
  PEER_DEFAULT_FPS,
  PEER_DEFAULT_QUALITY,
  loadPeerSettings,
  loginQuality,
  savePeerSettings,
  type PeerSettings,
} from "./settings";
import { ViewSettings } from "./ViewSettings";
import { pickDownloadTarget } from "./files";
import { KeyBar } from "./KeyBar";
import { TouchGestures } from "./touch";

/** Below this width the toolbar's secondary controls move into the "⋯" menu. */
const COMPACT = "(max-width: 759px)";

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(
    () => typeof matchMedia === "function" && matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    on();
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** A touch screen as the main pointer (phones, tablets): show the key bar by default. */
/** Stats overlay: the codec and, when known, whether its decoder is a hardware one. */
const codecLabel = (v: VideoStats) =>
  v.decoder ? `${v.codec} (${v.decoder} decoder)` : v.codec;

const coarsePointer = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

type Stage = "connecting" | "approval" | "live";

export function SessionView(props: {
  config: AppConfig;
  phase: Extract<Phase, { kind: "session" }>;
  onEnded: (error?: ErrorDescription, notice?: string) => void;
}) {
  const { phase } = props;
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [stage, setStage] = useState<Stage>("connecting");
  const [live, setLive] = useState<LiveSession>();
  const [snap, setSnap] = useState<LiveSnapshot>();
  const [fullscreen, setFullscreen] = useState(false);
  const [showStats, setShowStats] = useState(false);
  // Mounted on first use only: it opens its own file-transfer session.
  const [showFiles, setShowFiles] = useState(false);
  const [showView, setShowView] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showChat, setShowChat] = useState(false);
  // Recording: a ticking clock for the indicator, and errors from starting one.
  const [now, setNow] = useState(Date.now());
  const [recordError, setRecordError] = useState("");
  // All displays at once: fresh canvases for the other displays, one generation per entry.
  const [wantAll, setWantAll] = useState(false);
  const allGen = useRef(0);
  const otherCanvases = useRef(new Map<number, HTMLCanvasElement>());
  // Phones: the toolbar keeps ID, Files, Keys and Disconnect; the rest goes into a "⋯" menu.
  const compact = useMediaQuery(COMPACT);
  const [showKeys, setShowKeys] = useState(coarsePointer);
  const [zoomed, setZoomed] = useState(false);
  const gestures = useRef<TouchGestures>();
  // Quality, frame rate and scaling for this peer: sent at login, changed live.
  const [settings, setSettings] = useState<PeerSettings>(() =>
    loadPeerSettings(phase.peerId),
  );

  useEffect(() => {
    let cancelled = false;
    let session: LiveSession | undefined;
    LiveSession.connect({
      config: props.config,
      peerId: phase.peerId,
      password: phase.password,
      canvas: canvas.current!,
      player: phase.player,
      onWaitingForApproval: () => !cancelled && setStage("approval"),
      quality: loginQuality(settings),
      keyboardMode: settings.keyboard,
    }).then(
      (s) => {
        session = s;
        if (cancelled) return void s.close();
        rememberPeer(loadRecent(), phase.peerId);
        phase.audioStats.fn = (a) => s.setAudioStats(a);
        s.subscribe(() => setSnap(s.snapshot));
        setSnap(s.snapshot);
        setLive(s);
        setStage("live");
        canvas.current?.focus();
        s.ended.then(
          (why) =>
            !cancelled && props.onEnded(why, why ? undefined : "Disconnected."),
        );
      },
      (e) => !cancelled && props.onEnded(describeError(e)),
    );
    return () => {
      cancelled = true;
      void session?.close();
    };
  }, []);

  useEffect(() => {
    const onChange = () =>
      setFullscreen(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) return void document.exitFullscreen();
    await box.current?.requestFullscreen({ navigationUI: "hide" });
    // In fullscreen Chromium can also pass Ctrl+W, Alt+Tab etc. to the page (Keyboard Lock).
    await live?.lockKeyboard();
    canvas.current?.focus();
  };

  const recording = snap?.recording;
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [recording]);
  const toggleRecording = async () => {
    if (!live) return;
    if (recording) return void live.stopRecording();
    setRecordError("");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    try {
      // Pick first: the save picker needs this click's user gesture (targets).
      const target = await pickDownloadTarget(
        `rustdesk-${phase.peerId}-${stamp}.webm`,
        false,
        0,
      );
      live.startRecording(target);
    } catch (e) {
      if ((e as Error).name !== "AbortError")
        setRecordError((e as Error).message);
    }
  };
  const elapsed = recording
    ? Math.max(0, Math.floor((now - recording.startedAt) / 1000))
    : 0;
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  // An open chat panel has seen everything that arrives.
  const unread = snap?.chatUnread ?? 0;
  useEffect(() => {
    if (showChat && unread) live?.markChatRead();
  }, [showChat, unread]);

  // The "⋯" menu closes on a tap anywhere else.
  useEffect(() => {
    if (!showMenu) return;
    const close = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".menu, .more")) setShowMenu(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [showMenu]);

  // Touch gestures on the remote screen once the session is live. A layout effect: it runs
  // with the render that removes the "Connecting" overlay, so no early tap is lost (a plain effect
  // waits for the next paint).
  useLayoutEffect(() => {
    if (!live || !canvas.current) return;
    const g = new TouchGestures(
      canvas.current,
      () => live.inputController,
      (scale) => setZoomed(scale > 1),
    );
    gestures.current = g;
    return () => g.detach();
  }, [live]);

  // Hand the other displays' canvases over once they are in the DOM; each gets its own touch layer.
  useLayoutEffect(() => {
    if (!wantAll || !live) return;
    const canvases = new Map(otherCanvases.current);
    live.showAllDisplays(canvases);
    const layers = [...canvases].map(
      ([index, el]) =>
        new TouchGestures(el, () => live.inputFor(index), undefined),
    );
    return () => layers.forEach((g) => g.detach());
  }, [wantAll, live]);

  const changeSettings = (next: PeerSettings) => {
    if (next.keyboard !== settings.keyboard)
      live?.setKeyboardMode(next.keyboard);
    // "Default" cannot be sent as such: ask for the peer's defaults explicitly.
    if (next.quality !== settings.quality || next.fps !== settings.fps)
      live?.setQuality({
        quality: next.quality ?? PEER_DEFAULT_QUALITY,
        fps: next.fps ?? PEER_DEFAULT_FPS,
      });
    setSettings(next);
    savePeerSettings(phase.peerId, next);
  };

  // Not on iPhone Safari (no Fullscreen API for elements there).
  const canFullscreen = document.fullscreenEnabled === true;
  const secondary: {
    key: string;
    label: string;
    onClick: () => void;
    pressed?: boolean;
    disabled?: boolean;
    title?: string;
  }[] = [
    {
      key: "cad",
      label: "Ctrl+Alt+Del",
      title: "Send Ctrl+Alt+Del",
      disabled: !live,
      onClick: () => live?.ctrlAltDel(),
    },
    {
      key: "mute",
      label: snap?.muted ? "Unmute" : "Mute",
      pressed: snap?.muted,
      disabled: !live,
      onClick: () => live?.setMuted(!snap?.muted),
    },
    {
      key: "record",
      label: recording ? "Stop recording" : "Record",
      pressed: !!recording,
      disabled: !live || (!recording && snap?.recordingAllowed === false),
      title:
        snap?.recordingAllowed === false
          ? 'The remote does not allow recording (its "Enable recording session" is off)'
          : "Record the session (video of the shown display, and audio) to a WebM file",
      onClick: () => void toggleRecording(),
    },
    {
      key: "view",
      label: "View",
      pressed: showView,
      onClick: () => setShowView(!showView),
    },
    {
      key: "stats",
      label: "Stats",
      pressed: showStats,
      onClick: () => setShowStats(!showStats),
    },
    ...(canFullscreen
      ? [
          {
            key: "fullscreen",
            label: fullscreen ? "Exit full screen" : "Full screen",
            pressed: fullscreen,
            onClick: () => void toggleFullscreen(),
          },
        ]
      : []),
  ];
  const displaySelect = snap && snap.displays.length > 1 && (
    <select
      aria-label="Display"
      value={wantAll ? "all" : snap.display}
      onChange={(e) => {
        setShowMenu(false);
        const v = e.currentTarget.value;
        if (v === "all") {
          allGen.current++;
          setWantAll(true);
          return;
        }
        setWantAll(false);
        live?.showOneDisplay();
        live?.switchDisplay(Number(v));
      }}
    >
      {snap.displays.map((d) => (
        <option key={d.index} value={d.index}>
          Display {d.index + 1} ({d.width}x{d.height})
        </option>
      ))}
      <option value="all">All displays</option>
    </select>
  );
  // Side by side in their order on the remote desktop, each as wide as its share.
  const byX = snap
    ? [...snap.displays].sort((a, b) => a.x - b.x || a.y - b.y)
    : [];
  const placement = (index: number, width: number) =>
    wantAll
      ? { order: byX.findIndex((d) => d.index === index), flexGrow: width }
      : undefined;
  const others =
    wantAll && snap
      ? snap.displays.filter((d) => d.index !== snap.display)
      : [];

  const v = snap?.video;
  // Original size: the canvas is sized to the remote display (one remote pixel per CSS pixel);
  // input mapping still holds, as the canvas box then has the display's aspect ratio.
  const shown = snap?.displays.find((d) => d.index === snap.display);
  const originalSize =
    settings.scaling === "original" && shown && !wantAll
      ? { width: `${shown.width}px`, height: `${shown.height}px` }
      : undefined;
  const a = snap?.audio;
  return (
    <div class="session" ref={box}>
      <header class="toolbar" aria-label="Session controls">
        <span
          class="peer"
          title={
            snap ? `${snap.platform}, RustDesk ${snap.version}` : undefined
          }
        >
          {phase.peerId}
        </span>
        {!compact && displaySelect}
        {recording && (
          <span class="rec" role="status" aria-label={`Recording, ${clock}`}>
            ● REC {clock}
          </span>
        )}
        <span class="spacer" />
        {!compact &&
          secondary.map((b) => (
            <button
              key={b.key}
              type="button"
              disabled={b.disabled}
              aria-pressed={b.pressed}
              title={b.title}
              onClick={b.onClick}
            >
              {b.label}
            </button>
          ))}
        <button
          type="button"
          disabled={!live}
          aria-pressed={showChat}
          aria-label={unread ? `Chat, ${unread} unread` : "Chat"}
          onClick={() => setShowChat(!showChat)}
        >
          Chat
          {unread > 0 && (
            <span class="badge" aria-hidden="true">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
        <button
          type="button"
          disabled={!live}
          aria-pressed={showFiles}
          onClick={() => setShowFiles(!showFiles)}
        >
          Files
        </button>
        <button
          type="button"
          disabled={!live}
          aria-pressed={showKeys}
          onClick={() => setShowKeys(!showKeys)}
        >
          Keys
        </button>
        {compact && (
          <button
            type="button"
            class="more"
            aria-label="More"
            aria-expanded={showMenu}
            aria-haspopup="menu"
            onClick={() => setShowMenu(!showMenu)}
          >
            ⋯
          </button>
        )}
        <button
          type="button"
          class="danger"
          aria-label="Disconnect"
          title="Disconnect"
          onClick={() =>
            live ? live.close() : props.onEnded(undefined, "Cancelled.")
          }
        >
          {compact ? "✕" : "Disconnect"}
        </button>
        {compact && showMenu && (
          <div class="menu" role="menu" aria-label="More session controls">
            {displaySelect}
            {secondary.map((b) => (
              <button
                key={b.key}
                type="button"
                role="menuitem"
                disabled={b.disabled}
                aria-pressed={b.pressed}
                onClick={() => {
                  setShowMenu(false);
                  b.onClick();
                }}
              >
                {b.label}
              </button>
            ))}
          </div>
        )}
      </header>
      <div
        class={`screen${originalSize ? " original" : ""}${wantAll ? " multi" : ""}`}
      >
        {/* tabindex: keyboard input goes to the remote while the canvas has focus */}
        <canvas
          ref={canvas}
          tabIndex={0}
          style={
            originalSize ??
            (shown ? placement(shown.index, shown.width) : undefined)
          }
          aria-label={
            wantAll && shown
              ? `Remote display ${shown.index + 1} of ${phase.peerId}`
              : `Remote screen of ${phase.peerId}`
          }
          onPointerDown={() => void phase.player.resume()}
        />
        {others.map((d) => (
          <canvas
            key={`${d.index}-${allGen.current}`}
            ref={(el) => {
              if (el) otherCanvases.current.set(d.index, el);
              else otherCanvases.current.delete(d.index);
            }}
            tabIndex={0}
            style={placement(d.index, d.width)}
            aria-label={`Remote display ${d.index + 1} of ${phase.peerId}`}
            onPointerDown={() => void phase.player.resume()}
          />
        ))}
        {stage !== "live" && (
          <div class="overlay" role="status">
            <div class="spinner" aria-hidden="true" />
            <p>
              {stage === "connecting"
                ? `Connecting to ${phase.peerId}…`
                : "Waiting for the remote user to accept the connection…"}
            </p>
          </div>
        )}
        {showView && (
          <ViewSettings settings={settings} onChange={changeSettings} />
        )}
        {(recordError || snap?.recordingNote) && (
          <p class="rec-note" role="alert">
            {recordError || `Recording stopped: ${snap!.recordingNote}`}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => {
                setRecordError("");
                live?.dismissRecordingNote();
              }}
            >
              ×
            </button>
          </p>
        )}
        {showChat && live && snap && (
          <ChatPanel
            peerId={phase.peerId}
            entries={snap.chat}
            onSend={(t) => live.sendChat(t)}
            onClose={() => setShowChat(false)}
          />
        )}
        {showFiles && (
          <FilesPanel
            config={props.config}
            peerId={phase.peerId}
            password={phase.password}
            onClose={() => setShowFiles(false)}
          />
        )}
        {showStats && v && (
          <dl class="stats" aria-label="Statistics">
            <dt>{wantAll && shown ? `Display ${shown.index + 1}` : "Video"}</dt>
            <dd>
              {v.fps.toFixed(0)} fps, {v.width}x{v.height} {codecLabel(v)},
              decode {v.decodeMs.toFixed(1)} ms
            </dd>
            {Object.entries(snap!.videoOthers).map(([d, o]) => (
              <Fragment key={d}>
                <dt>Display {Number(d) + 1}</dt>
                <dd>
                  {o.fps.toFixed(0)} fps, {o.width}x{o.height} {codecLabel(o)},
                  decode {o.decodeMs.toFixed(1)} ms
                </dd>
              </Fragment>
            ))}
            <dt>Network</dt>
            <dd>
              {snap!.peerDelayMs >= 0
                ? `${snap!.peerDelayMs} ms (peer-measured)`
                : "…"}
            </dd>
            <dt>Audio</dt>
            <dd>
              {!a
                ? "none"
                : a.contextState !== "running"
                  ? "suspended: click the screen to enable sound"
                  : a.muted
                    ? "muted"
                    : `${a.latencyMs.toFixed(0)} ms buffer+output, ${a.rebuffers} rebuffers`}
            </dd>
            <dt>Clipboard</dt>
            <dd>
              {snap!.clipboard
                ? `${snap!.clipboard.received} in${snap!.clipboard.pending ? " (click to copy)" : ""}, ${snap!.clipboard.sent} out${snap!.clipboard.lastError ? `, ${snap!.clipboard.lastError}` : ""}`
                : "idle"}
            </dd>
          </dl>
        )}
      </div>
      {showKeys && live && (
        <KeyBar
          input={() => live.inputController}
          zoomed={zoomed}
          onResetZoom={() => gestures.current?.resetZoom()}
          macPeer={/mac/i.test(snap?.platform ?? "")}
        />
      )}
    </div>
  );
}
