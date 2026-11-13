// rustdesk-web app: connect screen <-> session view. Each connection attempt mounts a new
// SessionView (a fresh canvas; see live.ts). Errors come from the core's taxonomy
// (describeError / describeSessionClosed) and are shown on the connect screen.
import { render } from "preact";
import { useState } from "preact/hooks";
import { AudioPlayer, type ErrorDescription } from "@rustdesk-web/core";
import { loadConfig, type AppConfig } from "./config";
import { ConnectScreen } from "./ConnectScreen";
import { cleanTemporaryDownloads } from "./files";
import { applyTheme, loadTheme } from "./settings";
import { SessionView } from "./SessionView";

export type Phase =
  | {
      kind: "connect";
      error?: ErrorDescription;
      notice?: string;
      peerId?: string;
      /** The failed attempt's password, in memory only, so Reconnect is one click. */
      reconnect?: { peerId: string; password: string; dropped: boolean };
    }
  | {
      kind: "session";
      attempt: number;
      peerId: string;
      password: string;
      player: AudioPlayer;
      audioStats: {
        fn: (s: import("@rustdesk-web/core").AudioPlayerStats) => void;
      };
    };

let attempts = 0;

function App({ config }: { config: AppConfig }) {
  const [phase, setPhase] = useState<Phase>({ kind: "connect" });

  const connect = (peerId: string, password: string) => {
    // Created inside the click handler: browsers only start audio after a user gesture.
    const audioStats = { fn: (_: unknown) => {} };
    const player = new AudioPlayer({
      onStats: (s) => audioStats.fn(s),
      // A file, not a Blob URL: the CSP allows no blob: scripts.
      workletUrl: "audio-worklet.js",
    });
    setPhase({
      kind: "session",
      attempt: ++attempts,
      peerId,
      password,
      player,
      audioStats,
    });
  };

  if (phase.kind === "connect")
    return (
      <ConnectScreen
        error={phase.error}
        notice={phase.notice}
        initialPeerId={phase.peerId}
        reconnect={phase.reconnect}
        onConnect={connect}
        onForgetPassword={() =>
          setPhase((p) =>
            p.kind === "connect" && p.reconnect
              ? { ...p, reconnect: undefined }
              : p,
          )
        }
        onDismiss={() => setPhase({ kind: "connect", peerId: phase.peerId })}
      />
    );
  return (
    <SessionView
      key={phase.attempt}
      config={config}
      phase={phase}
      onEnded={(error, notice, dropped) =>
        setPhase({
          kind: "connect",
          error,
          notice,
          peerId: phase.peerId,
          // Only a failure offers Reconnect; a disconnect or cancel does not.
          reconnect: error
            ? {
                peerId: phase.peerId,
                password: phase.password,
                dropped: !!dropped,
              }
            : undefined,
        })
      }
    />
  );
}

function ConfigError({ missing }: { missing: string[] }) {
  return (
    <main class="connect">
      <h1>rustdesk-web</h1>
      <p class="error" role="alert">
        This deployment is not configured: {missing.join(", ")}{" "}
        {missing.length > 1 ? "are" : "is"} missing. Set{" "}
        {missing.length > 1 ? "them" : "it"} in the container's environment.
      </p>
    </main>
  );
}

// Downloads a closed or crashed tab never finished leave temporary files in OPFS.
void cleanTemporaryDownloads();
// The session fills the *visible* viewport: on phones that excludes the browser's own toolbars
// and, with the on-screen keyboard up, the keyboard (iOS does not shrink the layout viewport for
// it). styles.css falls back to 100dvh without visualViewport.
const vv = window.visualViewport;
if (vv) {
  const track = () => {
    const s = document.documentElement.style;
    s.setProperty("--vv-height", `${vv.height}px`);
    s.setProperty("--vv-top", `${vv.offsetTop}px`);
  };
  vv.addEventListener("resize", track);
  vv.addEventListener("scroll", track);
  track();
}

// The saved theme before the first render.
applyTheme(loadTheme(), false);

// Installable app with an offline shell. Relative URL: the scope is the app's directory.
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("sw.js").catch(() => {
    // not available (e.g. a non-secure context): the app works without it
  });

const root = document.getElementById("app")!;
const config = loadConfig();
render(
  "missing" in config ? (
    <ConfigError missing={config.missing} />
  ) : (
    <App config={config} />
  ),
  root,
);
