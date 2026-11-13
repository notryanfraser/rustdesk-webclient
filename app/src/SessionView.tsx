// Session view: the remote screen (canvas) and the chrome around it. Connects on mount (the
// canvas must exist first, see live.ts); reports the end of the session, or a failure to connect,
// through onEnded.
//
// One DOM for every layout: the canvases never move or remount (the video worker owns them), so a
// rotation or a window resize changes which controls surround the screen, and CSS does the rest.
// Panels, banners and sheets are siblings of .screen: it scrolls in original-size mode.
import { Fragment, type JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  describeError,
  type ErrorDescription,
  type VideoStats,
} from "@rustdesk-web/core";
import type { AppConfig } from "./config";
import { ChatPanel } from "./ChatPanel";
import { FilesPanel, type TransferSummary } from "./FilesPanel";
import { DockHead, PANELS, panelId, tabId, type PanelName } from "./Dock";
import { LiveSession, type LiveSnapshot } from "./live";
import type { Phase } from "./main";
import { loadRecent, rememberPeer } from "./recent";
import {
  PEER_DEFAULT_FPS,
  PEER_DEFAULT_QUALITY,
  loadPeerSettings,
  loadGestureHelpSeen,
  loadPointerMode,
  loginQuality,
  saveGestureHelpSeen,
  savePeerSettings,
  savePointerMode,
  type PeerSettings,
  type PointerMode,
} from "./settings";
import { ViewSettings } from "./ViewSettings";
import { pickDownloadTarget } from "./files";
import { KeyBar } from "./KeyBar";
import { TouchGestures } from "./touch";
import { Banners, GestureCard } from "./Banners";
import {
  BottomRow,
  Rail,
  SessionBar,
  StatusStrip,
  type BarItem,
} from "./SessionBar";
import { ConfirmDialog, MenuSheet, type SheetItem } from "./MenuSheet";
import {
  CadIcon,
  ChatIcon,
  DisplayIcon,
  ExitFullscreenIcon,
  FilesIcon,
  FullscreenIcon,
  GestureIcon,
  KeysIcon,
  MutedIcon,
  RecordIcon,
  SettingsIcon,
  SoundIcon,
  StatsIcon,
  StopIcon,
} from "./icons";

// Layouts, by size (styles.css repeats these breakpoints).
/** Phones in portrait: no bar, a status strip on top and the Menu at the bottom. */
const NARROW = "(max-width: 599px)";
/** Phones in landscape: the screen takes the height, the controls stand in a rail. */
const SHORT_LANDSCAPE = "(max-height: 499px) and (orientation: landscape)";
/** Room for every group in the session bar; below it Session moves into "More". */
const WIDE_BAR = "(min-width: 1100px)";

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

/** Stats overlay: the codec and, when known, whether its decoder is a hardware one. */
const codecLabel = (v: VideoStats) =>
  v.decoder ? `${v.codec} (${v.decoder} decoder)` : v.codec;

/** A touch screen as the main pointer (phones, tablets): show the key bar by default. */
const coarsePointer = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

type Stage = "connecting" | "approval" | "live";
type Layout = "full" | "narrow" | "rail";
/** Where gesture help came from: the menu moves focus to it, the first time it does not. */
type GestureHelp = "auto" | "menu";

const CHORD_HINT =
  "Keyboard goes to the remote. Press Ctrl+Alt+Shift to reach the session controls, Escape to go back.";

export function SessionView(props: {
  config: AppConfig;
  phase: Extract<Phase, { kind: "session" }>;
  // dropped: the session was live when it failed (a failed attempt to connect is not).
  onEnded: (
    error?: ErrorDescription,
    notice?: string,
    dropped?: boolean,
  ) => void;
}) {
  const { phase } = props;
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const [stage, setStage] = useState<Stage>("connecting");
  const [live, setLive] = useState<LiveSession>();
  const [snap, setSnap] = useState<LiveSnapshot>();
  const [fullscreen, setFullscreen] = useState(false);
  // Which side panel is open. FilesPanel mounts on first use and then stays (hidden while another
  // panel or none shows): it opens its own file-transfer session, and transfers must outlive the
  // panel being closed. That session ends with this view.
  const [panel, setPanel] = useState<PanelName>();
  const [filesOpened, setFilesOpened] = useState(false);
  const [transfers, setTransfers] = useState<TransferSummary>({
    running: 0,
    percent: undefined,
  });
  const dock = useRef<HTMLDivElement>(null);
  const dockHeading = useRef<HTMLHeadingElement>(null);
  // The control that opened the panel, which gets focus back when it closes.
  const opener = useRef<HTMLElement | null>(null);
  const [gestureHelp, setGestureHelp] = useState<GestureHelp>();
  const [sheet, setSheet] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Recording: a ticking clock for the indicator, and errors from starting one.
  const [now, setNow] = useState(Date.now());
  const [recordError, setRecordError] = useState("");
  const [soundDismissed, setSoundDismissed] = useState(false);
  const [announce, setAnnounce] = useState("");
  // All displays at once: fresh canvases for the other displays, one generation per entry.
  const [wantAll, setWantAll] = useState(false);
  const allGen = useRef(0);
  const otherCanvases = useRef(new Map<number, HTMLCanvasElement>());
  const rail = useMediaQuery(SHORT_LANDSCAPE);
  const narrow = useMediaQuery(NARROW);
  const wideBar = useMediaQuery(WIDE_BAR);
  const layout: Layout = rail ? "rail" : narrow ? "narrow" : "full";
  const [showKeys, setShowKeys] = useState(
    () =>
      coarsePointer() &&
      !(
        typeof matchMedia === "function" && matchMedia(SHORT_LANDSCAPE).matches
      ),
  );
  const [zoomed, setZoomed] = useState(false);
  const gestures = useRef<TouchGestures>();
  const otherGestures = useRef<TouchGestures[]>([]);
  // Direct touch or trackpad: an app-wide choice, also set from the key bar and view settings.
  const [pointerMode, setPointerMode] = useState<PointerMode>(loadPointerMode);
  const pointerModeRef = useRef(pointerMode);
  // Quality, frame rate and scaling for this peer: sent at login, changed live.
  const [settings, setSettings] = useState<PeerSettings>(() =>
    loadPeerSettings(phase.peerId),
  );
  // The escape chord and the Back gesture fire from long-lived listeners: they call the latest
  // closures through these.
  const chord = useRef(() => {});
  const back = useRef(() => {});
  const busyRef = useRef<string[]>([]);
  const typeNext = useRef(false);

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
      onEscapeChord: () => chord.current(),
    }).then(
      (s) => {
        session = s;
        if (cancelled) return void s.close();
        rememberPeer(loadRecent(), phase.peerId, s.snapshot.platform);
        phase.audioStats.fn = (a) => s.setAudioStats(a);
        s.subscribe(() => setSnap(s.snapshot));
        setSnap(s.snapshot);
        setLive(s);
        setStage("live");
        setAnnounce(CHORD_HINT);
        setTimeout(() => !cancelled && setAnnounce(""), 10000);
        canvas.current?.focus();
        s.ended.then(
          (why) =>
            !cancelled &&
            props.onEnded(why, why ? undefined : "Disconnected.", !!why),
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
  const clock = recording
    ? `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`
    : undefined;

  // What a disconnect would lose, as phrases for "Disconnect from X? <reason>. It will stop."
  // (MenuSheet). Add one per thing that runs in the background, e.g. a file transfer.
  const busyReasons: string[] = [];
  if (recording) busyReasons.push("a recording is running");
  if (transfers.running) busyReasons.push("a file transfer is running");
  busyRef.current = busyReasons;

  // An open chat panel has seen everything that arrives.
  const unread = snap?.chatUnread ?? 0;
  useEffect(() => {
    if (panel === "chat" && unread) live?.markChatRead();
  }, [panel, unread]);

  const disconnectNow = () => {
    setConfirming(false);
    setSheet(false);
    if (live) void live.close();
    else props.onEnded(undefined, "Cancelled.");
  };
  const requestDisconnect = () =>
    busyReasons.length ? setConfirming(true) : disconnectNow();
  back.current = requestDisconnect;

  // A live session is not lost by accident: leaving the page asks first, and the Back gesture
  // (browser button, Android/iOS edge swipe) runs the disconnect flow instead of leaving.
  useEffect(() => {
    if (stage !== "live") return;
    const entry = { rdSession: true };
    history.pushState(entry, "");
    let pushed = true;
    const onPop = () => {
      pushed = false;
      if (busyRef.current.length) {
        // Asking first: keep an entry for the next Back.
        history.pushState(entry, "");
        pushed = true;
      }
      back.current();
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    addEventListener("popstate", onPop);
    addEventListener("beforeunload", onUnload);
    return () => {
      removeEventListener("popstate", onPop);
      removeEventListener("beforeunload", onUnload);
      // Ended normally: drop the entry so Back does not land on a dead session.
      if (pushed && history.state?.rdSession) history.back();
    };
  }, [stage]);

  // Sheets only exist in the narrow and rail layouts.
  useEffect(() => {
    if (layout === "full") setSheet(false);
  }, [layout]);

  // Touch gestures on the remote screen once the session is live. A layout effect: it runs
  // with the render that removes the "Connecting" overlay, so no early tap is lost (a plain effect
  // waits for the next paint).
  useLayoutEffect(() => {
    if (!live || !canvas.current) return;
    const g = new TouchGestures(
      canvas.current,
      () => live.inputController,
      (scale) => setZoomed(scale > 1),
      pointerModeRef.current,
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
        new TouchGestures(
          el,
          () => live.inputFor(index),
          undefined,
          pointerModeRef.current,
        ),
    );
    otherGestures.current = layers;
    return () => {
      layers.forEach((g) => g.detach());
      otherGestures.current = [];
    };
  }, [wantAll, live]);

  const changePointerMode = (m: PointerMode) => {
    pointerModeRef.current = m;
    setPointerMode(m);
    savePointerMode(m);
    gestures.current?.setMode(m);
    otherGestures.current.forEach((g) => g.setMode(m));
  };

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

  // Keyboard users cannot leave the canvas (the core forwards every key): the chord (Ctrl+Alt+Shift,
  // pressed alone) lands on the first control of the bar, or on the Menu button where there is
  // no bar; Escape goes back.
  chord.current = () => {
    if (layout === "full")
      box.current
        ?.querySelector<HTMLElement>(".bar button:not(:disabled), .bar select")
        ?.focus();
    else menuBtn.current?.focus();
  };
  const escapeToCanvas: JSX.KeyboardEventHandler<HTMLElement> = (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if ((e.target as HTMLElement).matches("input, textarea")) return;
    e.preventDefault();
    canvas.current?.focus();
  };

  // The rail's "Type" opens the soft keyboard, which lives in the key bar: show the bar first.
  const focusTyping = () =>
    box.current
      ?.querySelector<HTMLTextAreaElement>(".keybar .soft-keyboard")
      ?.focus();
  const typeOnRemote = () => {
    if (showKeys) return focusTyping();
    typeNext.current = true;
    setShowKeys(true);
  };
  useLayoutEffect(() => {
    if (showKeys && live && typeNext.current) {
      typeNext.current = false;
      focusTyping();
    }
  }, [showKeys, live]);

  const chooseDisplay = (v: string) => {
    if (v === "all") {
      allGen.current++;
      setWantAll(true);
      return;
    }
    setWantAll(false);
    live?.showOneDisplay();
    live?.switchDisplay(Number(v));
  };
  // The sheet's Display button steps through the displays, then "All displays".
  const cycleDisplay = () => {
    if (!snap) return;
    const order = [...snap.displays.map((d) => String(d.index)), "all"];
    const at = order.indexOf(wantAll ? "all" : String(snap.display));
    chooseDisplay(order[(at + 1) % order.length]!);
  };

  const showPanel = (p: PanelName, from?: HTMLElement | null) => {
    if (!panel)
      opener.current = from ?? (document.activeElement as HTMLElement);
    if (p === "files") setFilesOpened(true);
    setPanel(p);
  };
  const closePanel = () => {
    setPanel(undefined);
    // Never silently to the canvas: back to the opener, or to the controls if it is gone.
    const to = opener.current?.isConnected
      ? opener.current
      : layout === "full"
        ? box.current?.querySelector<HTMLElement>(".bar button:not(:disabled)")
        : menuBtn.current;
    opener.current = null;
    to?.focus();
  };
  const openPanel = (p: PanelName, e: MouseEvent) =>
    panel === p ? closePanel() : showPanel(p, e.currentTarget as HTMLElement);
  // A panel that opens takes focus: the message box in Chat, else its heading (phones) or its
  // first control. Switching tabs leaves focus on the tab.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (panel && !wasOpen.current) {
      const root = dock.current?.querySelector<HTMLElement>(
        `#${panelId(panel)}`,
      );
      const first =
        panel === "chat"
          ? root?.querySelector<HTMLElement>("textarea")
          : narrow
            ? dockHeading.current
            : root?.querySelector<HTMLElement>(
                "input:checked, select, button:not(:disabled), textarea",
              );
      (first ?? root)?.focus();
    }
    wasOpen.current = !!panel;
  }, [panel]);

  // Gesture help the first time a session goes live on a touch screen.
  useEffect(() => {
    if (stage === "live" && coarsePointer() && !loadGestureHelpSeen())
      setGestureHelp("auto");
  }, [stage]);
  const dismissGestures = () => {
    setGestureHelp(undefined);
    saveGestureHelpSeen();
  };
  const filesStatus = transfers.running
    ? [
        `${transfers.running} transfer${transfers.running > 1 ? "s" : ""}`,
        transfers.percent !== undefined ? `${transfers.percent}%` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  // Not on iPhone Safari (no Fullscreen API for elements there).
  const canFullscreen = document.fullscreenEnabled === true;
  const recordTitle =
    snap?.recordingAllowed === false
      ? 'The remote does not allow recording (its "Enable recording session" is off)'
      : "Record the session (video of the shown display, and audio) to a WebM file";
  const recordDisabled =
    !live || (!recording && snap?.recordingAllowed === false);
  const muteLabel = snap?.muted ? "Unmute" : "Mute";
  const recordLabel = recording ? "Stop recording" : "Record";
  const fullscreenLabel = fullscreen ? "Exit full screen" : "Full screen";

  const inputItems: BarItem[] = [
    {
      key: "cad",
      label: "Ctrl+Alt+Del",
      icon: <CadIcon />,
      title: "Send Ctrl+Alt+Del",
      disabled: !live,
      onClick: () => live?.ctrlAltDel(),
    },
  ];
  const sessionItems: BarItem[] = [
    {
      key: "mute",
      label: muteLabel,
      icon: snap?.muted ? <MutedIcon /> : <SoundIcon />,
      pressed: snap?.muted,
      disabled: !live,
      onClick: () => live?.setMuted(!snap?.muted),
    },
    {
      key: "record",
      label: recordLabel,
      icon: recording ? <StopIcon /> : <RecordIcon />,
      pressed: !!recording,
      disabled: recordDisabled,
      title: recordTitle,
      onClick: () => void toggleRecording(),
    },
    ...(canFullscreen
      ? [
          {
            key: "fullscreen",
            label: fullscreenLabel,
            icon: fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />,
            pressed: fullscreen,
            onClick: () => void toggleFullscreen(),
          },
        ]
      : []),
  ];
  const panelItems: BarItem[] = [
    {
      key: "chat",
      label: "Chat",
      ariaLabel: unread ? `Chat, ${unread} unread` : undefined,
      icon: <ChatIcon />,
      badge: unread,
      pressed: panel === "chat",
      disabled: !live,
      onClick: (e) => openPanel("chat", e),
    },
    {
      key: "files",
      label: "Files",
      ariaLabel: filesStatus ? `Files, ${filesStatus}` : undefined,
      icon: <FilesIcon />,
      status: filesStatus,
      statusShort:
        transfers.running && transfers.percent !== undefined
          ? `${transfers.percent}%`
          : undefined,
      pressed: panel === "files",
      disabled: !live,
      onClick: (e) => openPanel("files", e),
    },
    {
      key: "view",
      label: "Settings",
      icon: <SettingsIcon />,
      pressed: panel === "view",
      onClick: (e) => openPanel("view", e),
    },
    {
      key: "stats",
      label: "Stats",
      icon: <StatsIcon />,
      pressed: panel === "stats",
      onClick: (e) => openPanel("stats", e),
    },
    {
      key: "keys",
      label: "Keys",
      icon: <KeysIcon />,
      pressed: showKeys,
      disabled: !live,
      onClick: () => setShowKeys(!showKeys),
    },
  ];

  const multiDisplay = !!snap && snap.displays.length > 1;
  const displaySelect = snap && multiDisplay && (
    <select
      aria-label="Display"
      value={wantAll ? "all" : snap.display}
      onChange={(e) => chooseDisplay(e.currentTarget.value)}
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
  const soundPaused =
    !!a &&
    !snap?.muted &&
    a.contextState !== "running" &&
    a.contextState !== "none" &&
    a.contextState !== "closed";
  useEffect(() => {
    if (!soundPaused) setSoundDismissed(false);
  }, [soundPaused]);

  // The sheet: the same actions as the bar, as a grid of big targets. Mute and Display stay open
  // so their new state can be seen; the rest act and close it.
  const closing = (fn: () => void) => () => {
    setSheet(false);
    fn();
  };
  const sheetItems: SheetItem[] = [
    {
      key: "chat",
      label: "Chat",
      note: unread ? `${unread} new` : undefined,
      icon: <ChatIcon size={24} />,
      disabled: !live,
      onClick: closing(() => showPanel("chat", menuBtn.current)),
    },
    {
      key: "files",
      label: "Files",
      note: transfers.running
        ? transfers.percent !== undefined
          ? `${transfers.percent}%`
          : `${transfers.running} transfers`
        : undefined,
      icon: <FilesIcon size={24} />,
      disabled: !live,
      onClick: closing(() => showPanel("files", menuBtn.current)),
    },
    {
      key: "view",
      label: "Settings",
      icon: <SettingsIcon size={24} />,
      onClick: closing(() => showPanel("view", menuBtn.current)),
    },
    ...(multiDisplay && snap
      ? [
          {
            key: "display",
            label: wantAll ? "All displays" : `Display ${snap.display + 1}`,
            icon: <DisplayIcon size={24} />,
            onClick: cycleDisplay,
          },
        ]
      : []),
    {
      key: "mute",
      label: muteLabel,
      icon: snap?.muted ? <MutedIcon size={24} /> : <SoundIcon size={24} />,
      pressed: snap?.muted,
      disabled: !live,
      onClick: () => live?.setMuted(!snap?.muted),
    },
    {
      key: "record",
      label: recordLabel,
      icon: recording ? <StopIcon size={24} /> : <RecordIcon size={24} />,
      pressed: !!recording,
      disabled: recordDisabled,
      onClick: closing(() => void toggleRecording()),
    },
    {
      key: "stats",
      label: "Stats",
      icon: <StatsIcon size={24} />,
      onClick: closing(() => showPanel("stats", menuBtn.current)),
    },
    ...(canFullscreen
      ? [
          {
            key: "fullscreen",
            label: fullscreenLabel,
            icon: fullscreen ? (
              <ExitFullscreenIcon size={24} />
            ) : (
              <FullscreenIcon size={24} />
            ),
            pressed: fullscreen,
            onClick: closing(() => void toggleFullscreen()),
          },
        ]
      : []),
    {
      key: "gestures",
      label: "Gestures",
      icon: <GestureIcon size={24} />,
      disabled: !live,
      onClick: closing(() => setGestureHelp("menu")),
    },
  ];
  const subtitle = [
    snap?.platform,
    snap && multiDisplay && !wantAll
      ? `Display ${snap.display + 1} of ${snap.displays.length}`
      : wantAll
        ? "All displays"
        : undefined,
    shown && !wantAll ? `${shown.width}×${shown.height}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const sheetOpen = layout !== "full" && (sheet || confirming);
  const peerTitle = snap
    ? `${snap.platform}, RustDesk ${snap.version}`
    : undefined;
  const delay = snap?.peerDelayMs ?? -1;
  const note =
    recordError ||
    (snap?.recordingNote ? `Recording stopped: ${snap.recordingNote}` : "");

  return (
    <div class={`session layout-${layout}`} ref={box}>
      <p class="sr-only" role="status">
        {announce}
      </p>
      {layout === "full" && (
        <SessionBar
          peer={phase.peerId}
          title={peerTitle}
          delayMs={delay}
          rec={clock}
          display={displaySelect}
          input={inputItems}
          session={sessionItems}
          panels={panelItems}
          compact={!wideBar}
          onDisconnect={requestDisconnect}
          onKeyDown={escapeToCanvas}
        />
      )}
      {layout === "narrow" && (
        <StatusStrip
          peer={phase.peerId}
          title={peerTitle}
          delayMs={delay}
          rec={clock}
        />
      )}
      <Banners
        soundPaused={soundPaused && !soundDismissed}
        onSoundOn={() => void phase.player.resume()}
        onDismissSound={() => setSoundDismissed(true)}
        clipboardPending={!!snap?.clipboard?.pending}
        onCopy={() => live?.copyPendingClipboard()}
        gestures={
          gestureHelp && layout !== "narrow"
            ? { mode: pointerMode, onDismiss: dismissGestures }
            : undefined
        }
        note={note}
        onDismissNote={() => {
          setRecordError("");
          live?.dismissRecordingNote();
        }}
      />
      <div class="stage">
        <div class="main">
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
          </div>
          {gestureHelp && layout === "narrow" && (
            <GestureCard
              mode={pointerMode}
              focus={gestureHelp === "menu"}
              onDismiss={dismissGestures}
            />
          )}
          {layout === "full" && (
            <footer class="hint">
              <span>
                Keyboard goes to the remote. Press <kbd>Ctrl+Alt+Shift</kbd> to
                reach these controls, <kbd>Esc</kbd> to go back.
              </span>
              {v && (
                <span class="summary">
                  {v.width}×{v.height} · {v.codec.toUpperCase()} ·{" "}
                  {v.fps.toFixed(0)} fps
                </span>
              )}
            </footer>
          )}
          {layout === "narrow" && (
            <BottomRow
              keys={showKeys}
              onKeys={() => setShowKeys(!showKeys)}
              keysDisabled={!live}
              menuRef={menuBtn}
              onMenu={() => setSheet(true)}
              onKeyDown={escapeToCanvas}
            />
          )}
          {showKeys && live && (
            <KeyBar
              input={() => live.inputController}
              zoomed={zoomed}
              pointerMode={pointerMode}
              onPointerMode={changePointerMode}
              onResetZoom={() => gestures.current?.resetZoom()}
              onCtrlAltDel={() => live.ctrlAltDel()}
              narrow={layout === "narrow"}
              macPeer={/mac/i.test(snap?.platform ?? "")}
            />
          )}
        </div>
        {layout === "rail" && (
          <Rail
            delayMs={delay}
            rec={clock}
            keys={showKeys}
            onKeys={() => setShowKeys(!showKeys)}
            onType={typeOnRemote}
            disabled={!live}
            menuRef={menuBtn}
            onMenu={() => setSheet(true)}
            onKeyDown={escapeToCanvas}
          />
        )}
        {/* The side panel: docked beside the screen on wide windows, over it where narrower. */}
        {(panel || filesOpened) && (
          <div
            class="dock"
            ref={dock}
            hidden={!panel}
            onKeyDown={(e) => {
              if (e.key !== "Escape" || e.defaultPrevented) return;
              e.preventDefault();
              closePanel();
            }}
          >
            {panel && (
              <DockHead
                panel={panel}
                title={narrow}
                headingRef={dockHeading}
                onSelect={(p) => showPanel(p)}
                onClose={closePanel}
              />
            )}
            {PANELS.map(({ name, label }) => (
              <div
                key={name}
                class="dock-panel"
                id={panelId(name)}
                role={narrow ? "region" : "tabpanel"}
                aria-label={narrow ? label : undefined}
                aria-labelledby={narrow ? undefined : tabId(name)}
                tabIndex={-1}
                hidden={panel !== name}
              >
                {name === "view" && panel === name && (
                  <ViewSettings
                    settings={settings}
                    onChange={changeSettings}
                    pointerMode={pointerMode}
                    onPointerMode={changePointerMode}
                  />
                )}
                {name === "chat" && panel === name && live && snap && (
                  <ChatPanel
                    entries={snap.chat}
                    onSend={(t) => live.sendChat(t)}
                  />
                )}
                {name === "files" && filesOpened && live && (
                  <FilesPanel
                    config={props.config}
                    peerId={phase.peerId}
                    password={phase.password}
                    onTransfers={(t) =>
                      setTransfers((prev) =>
                        prev.running === t.running && prev.percent === t.percent
                          ? prev
                          : t,
                      )
                    }
                  />
                )}
                {name === "stats" && panel === name && (
                  <dl class="stats">
                    {v && (
                      <>
                        <dt>
                          {wantAll && shown
                            ? `Display ${shown.index + 1}`
                            : "Video"}
                        </dt>
                        <dd>
                          {v.fps.toFixed(0)} fps, {v.width}x{v.height}{" "}
                          {codecLabel(v)}, decode {v.decodeMs.toFixed(1)} ms
                        </dd>
                      </>
                    )}
                    {Object.entries(snap?.videoOthers ?? {}).map(([d, o]) => (
                      <Fragment key={d}>
                        <dt>Display {Number(d) + 1}</dt>
                        <dd>
                          {o.fps.toFixed(0)} fps, {o.width}x{o.height}{" "}
                          {codecLabel(o)}, decode {o.decodeMs.toFixed(1)} ms
                        </dd>
                      </Fragment>
                    ))}
                    <dt>Network</dt>
                    <dd>{delay >= 0 ? `${delay} ms (peer-measured)` : "…"}</dd>
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
                      {snap?.clipboard
                        ? `${snap.clipboard.received} in${snap.clipboard.pending ? " (click to copy)" : ""}, ${snap.clipboard.sent} out${snap.clipboard.lastError ? `, ${snap.clipboard.lastError}` : ""}`
                        : "idle"}
                    </dd>
                    {snap && (
                      <>
                        <dt>Remote</dt>
                        <dd>
                          {snap.platform}, RustDesk {snap.version}
                        </dd>
                      </>
                    )}
                  </dl>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {sheetOpen && (
        <MenuSheet
          peer={phase.peerId}
          subtitle={subtitle}
          items={sheetItems}
          confirm={confirming ? busyReasons : undefined}
          returnFocus={menuBtn}
          onClose={() => {
            setSheet(false);
            setConfirming(false);
          }}
          onDisconnect={requestDisconnect}
          onDisconnectNow={disconnectNow}
        />
      )}
      {layout === "full" && confirming && (
        <ConfirmDialog
          peer={phase.peerId}
          reasons={busyReasons}
          onStay={() => setConfirming(false)}
          onDisconnect={disconnectNow}
        />
      )}
    </div>
  );
}
