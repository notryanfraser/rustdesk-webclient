// Quality / frame-rate options: the fields and packing the 1.5.3 native client sends.
import { describe, expect, it } from "vitest";
import {
  ImageQuality,
  applyQualityOptions,
  qualityMessage,
  videoLoginOption,
} from "../src/index.js";

describe("quality options", () => {
  it("presets set image_quality only", () => {
    expect(applyQualityOptions({ quality: "low" }).imageQuality).toBe(
      ImageQuality.Low,
    );
    expect(applyQualityOptions({ quality: "balanced" }).imageQuality).toBe(
      ImageQuality.Balanced,
    );
    const best = applyQualityOptions({ quality: "best" });
    expect(best.imageQuality).toBe(ImageQuality.Best);
    expect(best.customImageQuality).toBe(0);
    expect(best.customFps).toBe(0);
  });

  it("custom quality is percent << 8, clamped to 10..2000, as client.rs packs it", () => {
    expect(
      applyQualityOptions({ quality: { custom: 50 } }).customImageQuality,
    ).toBe(50 << 8);
    expect(
      applyQualityOptions({ quality: { custom: 1 } }).customImageQuality,
    ).toBe(10 << 8);
    expect(
      applyQualityOptions({ quality: { custom: 9999 } }).customImageQuality,
    ).toBe(2000 << 8);
    // the peer's decode (video_qos.rs): ratio = (q >> 8 & 0xFFF) * 2 / 100
    const q = applyQualityOptions({
      quality: { custom: 150 },
    }).customImageQuality;
    expect((((q >> 8) & 0xfff) * 2) / 100).toBe(3);
  });

  it("fps is clamped to the peer's 1..120", () => {
    expect(applyQualityOptions({ fps: 60 }).customFps).toBe(60);
    expect(applyQualityOptions({ fps: 0 }).customFps).toBe(1);
    expect(applyQualityOptions({ fps: 500 }).customFps).toBe(120);
  });

  it("mid-session changes are Misc.option", () => {
    const m = qualityMessage({ quality: "best", fps: 30 });
    expect(m.union.case).toBe("misc");
    const misc = m.union.value as {
      union: {
        case: string;
        value: { imageQuality: number; customFps: number };
      };
    };
    expect(misc.union.case).toBe("option");
    expect(misc.union.value).toMatchObject({
      imageQuality: ImageQuality.Best,
      customFps: 30,
    });
  });

  it("the login option keeps the codec declaration and adds saved quality", () => {
    const o = videoLoginOption({ quality: "low", fps: 20 });
    expect(o.supportedDecoding?.abilityVp9).toBe(1);
    expect(o.imageQuality).toBe(ImageQuality.Low);
    expect(o.customFps).toBe(20);
    expect(videoLoginOption().imageQuality).toBe(ImageQuality.NotSet);
  });
});
