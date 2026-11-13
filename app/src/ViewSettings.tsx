// Settings panel: "This remote" (image quality, frame rate, scaling, keyboard: saved per peer by
// the session view) and "This device" (touch input and theme: saved for the app).
import type { ComponentChildren } from "preact";
import { useId, useState } from "preact/hooks";
import {
  CUSTOM_QUALITY_MAX,
  CUSTOM_QUALITY_MIN,
  type ImageQualitySetting,
} from "@rustdesk-web/core";
import {
  applyTheme,
  loadTheme,
  type PeerSettings,
  type PointerMode,
  type Scaling,
  type Theme,
} from "./settings";

const FPS_CHOICES = [5, 10, 15, 20, 30, 45, 60, 90, 120];

// No saved choice means the peer's default, Balanced.
const qualityKey = (q: ImageQualitySetting | undefined) =>
  q === undefined ? "balanced" : typeof q === "string" ? q : "custom";

/**
 * A segmented control made of native radios: the group, the arrow keys and the checked state come
 * from the browser. The choices wrap onto more lines when they do not fit.
 */
function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  hint?: ComponentChildren;
}) {
  const id = useId();
  return (
    <fieldset
      class="field"
      aria-describedby={props.hint ? `${id}-hint` : undefined}
    >
      <legend>{props.label}</legend>
      <div class="seg">
        {props.options.map(([v, text]) => (
          <label key={v}>
            <input
              type="radio"
              name={id}
              value={v}
              checked={props.value === v}
              onChange={() => props.onChange(v)}
            />
            <span>{text}</span>
          </label>
        ))}
      </div>
      {props.hint && (
        <p class="field-hint" id={`${id}-hint`}>
          {props.hint}
        </p>
      )}
    </fieldset>
  );
}

export function ViewSettings(props: {
  settings: PeerSettings;
  onChange: (s: PeerSettings) => void;
  pointerMode: PointerMode;
  onPointerMode: (m: PointerMode) => void;
}) {
  const s = props.settings;
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [custom, setCustom] = useState(
    typeof s.quality === "object" ? s.quality.custom : 50,
  );
  const setQuality = (key: string) =>
    props.onChange({
      ...s,
      quality: key === "custom" ? { custom } : (key as ImageQualitySetting),
    });

  return (
    <form
      class="view-settings"
      aria-label="Settings"
      onSubmit={(e) => e.preventDefault()}
    >
      <h3>This remote</h3>
      <Segmented
        label="Image quality"
        value={qualityKey(s.quality)}
        options={[
          ["low", "Low"],
          ["balanced", "Balanced"],
          ["best", "Best"],
          ["custom", "Custom"],
        ]}
        onChange={setQuality}
      />
      {typeof s.quality === "object" && (
        <div class="field">
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
        </div>
      )}
      <div class="field">
        <label for="vs-fps">Frame rate limit</label>
        <select
          id="vs-fps"
          aria-describedby="vs-fps-hint"
          value={s.fps === undefined ? "default" : String(s.fps)}
          onChange={(e) => {
            const v = e.currentTarget.value;
            props.onChange({
              ...s,
              fps: v === "default" ? undefined : Number(v),
            });
          }}
        >
          <option value="default">Up to 30 fps (default)</option>
          {FPS_CHOICES.map((f) => (
            <option key={f} value={String(f)}>
              Up to {f} fps
            </option>
          ))}
        </select>
        <p class="field-hint" id="vs-fps-hint">
          The remote sends fewer frames when the screen is still.
        </p>
      </div>
      <Segmented<Scaling>
        label="Scaling"
        value={s.scaling}
        options={[
          ["fit", "Fit to window"],
          ["original", "Original size"],
        ]}
        onChange={(scaling) => props.onChange({ ...s, scaling })}
      />
      <Segmented<PeerSettings["keyboard"]>
        label="Keyboard"
        value={s.keyboard}
        options={[
          ["map", "By key position"],
          ["translate", "By character"],
        ]}
        onChange={(keyboard) => props.onChange({ ...s, keyboard })}
        hint="By key position uses the remote's keyboard layout. By character types what your keyboard shows. Shortcuts always go by position."
      />
      <h3>This device</h3>
      <Segmented<PointerMode>
        label="Touch input"
        value={props.pointerMode}
        options={[
          ["touch", "Direct touch"],
          ["trackpad", "Trackpad"],
        ]}
        onChange={props.onPointerMode}
        hint={
          props.pointerMode === "touch"
            ? "Tap where you want to click."
            : "Drag to move a cursor, tap to click."
        }
      />
      <Segmented<Theme>
        label="Theme"
        value={theme}
        options={[
          ["auto", "System"],
          ["light", "Light"],
          ["dark", "Dark"],
        ]}
        onChange={(t) => {
          setTheme(t);
          applyTheme(t);
        }}
      />
    </form>
  );
}
