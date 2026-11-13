// Video worker entry: owns the VideoPipeline and the OffscreenCanvas, so decoding and
// drawing never run on the main thread. Bundle it as its own entry point and hand the Worker to
// WorkerVideoSink (worker-sink.ts). NOT exported from the package index: importing it installs
// the message handler on `self`.
import { VideoPipeline } from "./pipeline.js";
import type { WorkerRequest, WorkerResponse } from "./types.js";

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(m: WorkerResponse): void;
};
const post = (m: WorkerResponse) => scope.postMessage(m);
let pipeline: VideoPipeline | undefined;

scope.onmessage = (e) => {
  const req = e.data;
  switch (req.type) {
    case "init":
      try {
        pipeline = new VideoPipeline({
          canvas: req.canvas,
          statsIntervalMs: req.statsIntervalMs,
          onStats: (stats) => post({ type: "stats", stats }),
          onResize: (width, height) => post({ type: "resize", width, height }),
        });
      } catch (err) {
        post({ type: "fatal", error: String(err) });
      }
      return;
    case "decode":
      if (!pipeline) {
        post({ type: "done", id: req.id, error: "not initialised" });
        return;
      }
      pipeline.submit(req.chunks).then(
        () => post({ type: "done", id: req.id }),
        (err: unknown) =>
          post({ type: "done", id: req.id, error: String(err) }),
      );
      return;
    case "close":
      pipeline?.close();
      pipeline = undefined;
      return;
  }
};
