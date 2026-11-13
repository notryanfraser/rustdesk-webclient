// View settings panel: image quality, frame rate and scaling for this peer (saved per peer
// by the session view), and the app theme (saved for the app).
import { useState } from "preact/hooks";
import {
  CUSTOM_QUALITY_MAX,
  CUSTOM_QUALITY_MIN,
  type ImageQualitySetting,
} from "@rustdesk-web/core";
import {
  applyTheme,
  loadTheme,
  type PeerSettings,
  type Scaling,
  type Theme,
} from "./settings";

const FPS_CHOICES = [5, 10, 15, 20, 30, 45, 60, 90, 120];

const qualityKey = (q: ImageQualitySetting | undefined) =>
  q === undefined ? "default" : typeof q === "string" ? q : "custom";

export function ViewSettings(props: {
  settings: PeerSettings;
  onChange: (s: PeerSettings) => void;
}) {
  const s = props.settings;
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [custom, setCustom] = useState(
    typeof s.quality === "object" ? s.quality.custom : 50,
  );
  const setQuality = (key: string) =>
    props.onChange({
      ...s,
      quality:
        key === "default"
          ? undefined
          : key === "custom"
            ? { custom }
            : (key as ImageQualitySetting),
    });

  return (
    <form
      class="view-settings"
      aria-label="View settings"
      onSubmit={(e) => e.preventDefault()}
    >
      <label for="vs-quality">Quality</label>
      <select
        id="vs-quality"
        value={qualityKey(s.quality)}
        onChange={(e) => setQuality(e.currentTarget.value)}
      >
        <option value="default">Default (balanced)</option>
        <option value="low">Low (less bandwidth)</option>
        <option value="balanced">Balanced</option>
        <option value="best">Best</option>
        <option value="custom">Custom…</option>
      </select>
      {typeof s.quality === "object" && (
        <>
          <label for="vs-custom">Bitrate %</label>
          <input
            id="vs-custom"
            type="number"
            min={CUSTOM_QUALITY_MIN}
            max={CUSTOM_QUALITY_MAX}
            step={10}
            value={custom}
            onChange={(e) => {
              const n = Number(e.currentTarget.value);
              if (!Number.isFinite(n)) return;
              setCustom(n);
              props.onChange({ ...s, quality: { custom: n } });
            }}
          />
        </>
      )}
      <label for="vs-fps">Frame rate</label>
      <select
        id="vs-fps"
        value={s.fps === undefined ? "default" : String(s.fps)}
        onChange={(e) => {
          const v = e.currentTarget.value;
          props.onChange({
            ...s,
            fps: v === "default" ? undefined : Number(v),
          });
        }}
      >
        <option value="default">Default (up to 30 fps)</option>
        {FPS_CHOICES.map((f) => (
          <option key={f} value={String(f)}>
            Up to {f} fps
          </option>
        ))}
      </select>
      <label for="vs-scaling">Scaling</label>
      <select
        id="vs-scaling"
        value={s.scaling}
        onChange={(e) =>
          props.onChange({ ...s, scaling: e.currentTarget.value as Scaling })
        }
      >
        <option value="fit">Fit to window</option>
        <option value="original">Original size (scroll)</option>
      </select>
      <label for="vs-keyboard">Keyboard</label>
      <select
        id="vs-keyboard"
        value={s.keyboard}
        onChange={(e) =>
          props.onChange({
            ...s,
            keyboard: e.currentTarget.value as PeerSettings["keyboard"],
          })
        }
      >
        <option value="map">By key position (remote layout)</option>
        <option value="translate">By character (your layout)</option>
      </select>
      <label for="vs-theme">Theme</label>
      <select
        id="vs-theme"
        value={theme}
        onChange={(e) => {
          const t = e.currentTarget.value as Theme;
          setTheme(t);
          applyTheme(t);
        }}
      >
        <option value="auto">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <p class="note">
        Quality, frame rate, scaling and keyboard are remembered for this
        remote. "By character" types what your keyboard shows even when the
        remote uses another layout; shortcuts (Ctrl+C) still go by position.
        Frame rate is an upper limit: the remote sends fewer frames when the
        screen is still or the link is slow.
      </p>
    </form>
  );
}
