import { processGeminiVisibleWatermark } from "@/lib/geminiWorkerClient";
import {
  applyCrush,
  applyShake,
  applyStir,
  DEFAULT_OPTIONS,
} from "@/lib/pipeline";
import type { GeminiWorkerProgressStage } from "@/lib/types";

export const MAX_OUTPUT_MEGAPIXELS = 64;
export const MAX_CANVAS_SIDE = 16_384;

export type UpscaleScale = 2 | 3 | 4;

export type BatchProcessStage =
  | "decode"
  | "upscale"
  | "restore"
  | "shake"
  | "stir"
  | "sharpen"
  | "crush"
  | "export"
  | "complete";

export interface BatchProcessOptions {
  applyUnmarker: boolean;
  jpegQuality: number;
  scale: UpscaleScale;
}

export interface BatchProcessProgress {
  label: string;
  progress: number;
  stage: BatchProcessStage;
}

export interface ProcessedImageResult {
  blob: Blob;
  fileName: string;
  outputHeight: number;
  outputWidth: number;
  skippedVisibleRestore: boolean;
  sourceHeight: number;
  sourceWidth: number;
  unmarkerApplied: boolean;
  warnings: string[];
}

type ProgressHandler = (progress: BatchProcessProgress) => void;

export async function processUpscaleAndUnmarkImage(
  file: File,
  options: BatchProcessOptions,
  signal?: AbortSignal,
  onProgress?: ProgressHandler,
): Promise<ProcessedImageResult> {
  const warnings: string[] = [];

  report(onProgress, "decode", "Lecture de l'image", 4);
  const image = await loadImageFromFile(file, signal);
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const outputWidth = Math.round(sourceWidth * options.scale);
  const outputHeight = Math.round(sourceHeight * options.scale);

  assertCanvasBudget(outputWidth, outputHeight);

  let canvas = createCanvasFromImage(image, sourceWidth, sourceHeight);

  if (options.applyUnmarker) {
    const ctx = getCanvasContext(canvas);
    report(onProgress, "restore", "Unmarker visible", 14);
    const skippedVisibleRestore = await runVisibleRestore(
      ctx,
      canvas,
      warnings,
      signal,
      onProgress,
      14,
      34,
    );

    report(onProgress, "shake", "Unmarker geometry", 36);
    const shakeSource = createCanvasSnapshot(canvas);
    await applyShake(ctx, shakeSource, DEFAULT_OPTIONS.shake, signal);

    report(onProgress, "stir", "Unmarker bruit", 48);
    await applyStir(ctx, DEFAULT_OPTIONS.stir, signal);

    report(onProgress, "upscale", `Upscale x${options.scale}`, 60);
    canvas = await upscaleCanvas(
      canvas,
      sourceWidth,
      sourceHeight,
      outputWidth,
      outputHeight,
      signal,
      onProgress,
      60,
      84,
    );

    report(onProgress, "sharpen", "Nettete upscale", 88);
    await sharpenCanvas(canvas, signal);

    report(onProgress, "crush", "Export JPG nettoye", 94);
    const blob = await applyCrush(
      canvas,
      { quality: options.jpegQuality },
      signal,
    );

    report(onProgress, "complete", "Pret", 100);

    return {
      blob,
      fileName: buildOutputFileName(file.name, options.scale, true),
      outputHeight,
      outputWidth,
      skippedVisibleRestore,
      sourceHeight,
      sourceWidth,
      unmarkerApplied: true,
      warnings,
    };
  }

  report(onProgress, "upscale", `Upscale x${options.scale}`, 14);
  canvas = await upscaleCanvas(
    canvas,
    sourceWidth,
    sourceHeight,
    outputWidth,
    outputHeight,
    signal,
    onProgress,
    14,
    84,
  );

  report(onProgress, "sharpen", "Nettete upscale", 88);
  await sharpenCanvas(canvas, signal);

  report(onProgress, "export", "Export JPG upscale", 94);
  const blob = await encodeCanvasAsJpeg(canvas, options.jpegQuality, signal);

  report(onProgress, "complete", "Pret", 100);

  return {
    blob,
    fileName: buildOutputFileName(file.name, options.scale, false),
    outputHeight,
    outputWidth,
    skippedVisibleRestore: true,
    sourceHeight,
    sourceWidth,
    unmarkerApplied: false,
    warnings,
  };
}

function report(
  onProgress: ProgressHandler | undefined,
  stage: BatchProcessStage,
  label: string,
  progress: number,
) {
  onProgress?.({
    label,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    stage,
  });
}

async function loadImageFromFile(file: File, signal?: AbortSignal) {
  assertNotAborted(signal);

  const image = new Image();
  image.decoding = "async";
  const objectUrl = URL.createObjectURL(file);

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Image illisible par le navigateur"));
      image.src = objectUrl;
    });
    assertNotAborted(signal);
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function createCanvasFromImage(
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  const ctx = getCanvasContext(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, sourceWidth, sourceHeight);
  return canvas;
}

async function upscaleCanvas(
  sourceCanvas: HTMLCanvasElement,
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
  signal: AbortSignal | undefined,
  onProgress: ProgressHandler | undefined,
  progressStart: number,
  progressEnd: number,
) {
  let currentCanvas = sourceCanvas;

  const totalSteps = Math.max(
    1,
    Math.ceil(Math.log(outputWidth / sourceWidth) / Math.log(2)),
  );
  let completedSteps = 0;

  while (
    currentCanvas.width !== outputWidth ||
    currentCanvas.height !== outputHeight
  ) {
    assertNotAborted(signal);

    const nextWidth =
      currentCanvas.width * 2 >= outputWidth
        ? outputWidth
        : Math.round(currentCanvas.width * 2);
    const nextHeight =
      nextWidth === outputWidth
        ? outputHeight
        : Math.round(sourceHeight * (nextWidth / sourceWidth));
    const nextCanvas = document.createElement("canvas");
    nextCanvas.width = nextWidth;
    nextCanvas.height = nextHeight;

    const nextCtx = getCanvasContext(nextCanvas);
    nextCtx.imageSmoothingEnabled = true;
    nextCtx.imageSmoothingQuality = "high";
    nextCtx.drawImage(currentCanvas, 0, 0, nextWidth, nextHeight);

    currentCanvas.width = 1;
    currentCanvas.height = 1;
    currentCanvas = nextCanvas;
    completedSteps += 1;

    report(
      onProgress,
      "upscale",
      `Upscale ${nextWidth} x ${nextHeight}`,
      progressStart +
        (completedSteps / totalSteps) * (progressEnd - progressStart),
    );
    await nextFrame();
  }

  return currentCanvas;
}

async function sharpenCanvas(
  canvas: HTMLCanvasElement,
  signal?: AbortSignal,
  amount = 0.18,
) {
  assertNotAborted(signal);

  const ctx = getCanvasContext(canvas);
  const { width, height } = canvas;
  const original = ctx.getImageData(0, 0, width, height);
  const blurredCanvas = createCanvasSnapshot(canvas);
  const blurredCtx = getCanvasContext(blurredCanvas);
  blurredCtx.clearRect(0, 0, width, height);
  blurredCtx.filter = "blur(0.8px)";
  blurredCtx.drawImage(canvas, 0, 0);
  blurredCtx.filter = "none";
  const blurred = blurredCtx.getImageData(0, 0, width, height);
  const output = original.data;
  const blurData = blurred.data;

  const bytesPerChunk = 1_048_576;
  for (let index = 0; index < output.length; index += 4) {
    output[index] = clampByte(
      output[index] + (output[index] - blurData[index]) * amount,
    );
    output[index + 1] = clampByte(
      output[index + 1] + (output[index + 1] - blurData[index + 1]) * amount,
    );
    output[index + 2] = clampByte(
      output[index + 2] + (output[index + 2] - blurData[index + 2]) * amount,
    );

    if (index > 0 && index % bytesPerChunk === 0) {
      assertNotAborted(signal);
      await nextFrame();
    }
  }

  assertNotAborted(signal);
  ctx.putImageData(original, 0, 0);
  await nextFrame();
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

async function runVisibleRestore(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  warnings: string[],
  signal: AbortSignal | undefined,
  onProgress: ProgressHandler | undefined,
  progressStart: number,
  progressEnd: number,
) {
  try {
    const result = await processGeminiVisibleWatermark(
      ctx.getImageData(0, 0, canvas.width, canvas.height),
      {
        signal,
        onProgress: (stage) =>
          report(
            onProgress,
            "restore",
            getVisibleRestoreLabel(stage),
            getVisibleRestoreProgress(stage, progressStart, progressEnd),
          ),
      },
    );
    assertNotAborted(signal);
    ctx.putImageData(result.imageData, 0, 0);
    return result.skipped;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    warnings.push(
      "La restauration visible n'a pas abouti; les perturbations locales ont quand meme ete appliquees.",
    );
    return true;
  }
}

function getVisibleRestoreLabel(stage: GeminiWorkerProgressStage) {
  switch (stage) {
    case "loading-opencv":
    case "loading-alpha":
      return "Chargement unmarker";
    case "detecting":
      return "Scan watermark visible";
    case "restoring":
    case "inpainting":
      return "Retouche watermark visible";
    case "done":
      return "Watermark visible traite";
    case "skipped":
      return "Aucun watermark visible";
    case "error":
      return "Scan visible ignore";
  }
}

function getVisibleRestoreProgress(
  stage: GeminiWorkerProgressStage,
  progressStart: number,
  progressEnd: number,
) {
  const span = progressEnd - progressStart;

  switch (stage) {
    case "loading-opencv":
      return progressStart + span * 0.15;
    case "loading-alpha":
      return progressStart + span * 0.3;
    case "detecting":
      return progressStart + span * 0.6;
    case "restoring":
      return progressStart + span * 0.78;
    case "inpainting":
      return progressStart + span * 0.9;
    case "done":
    case "skipped":
    case "error":
      return progressEnd;
  }
}

function assertCanvasBudget(width: number, height: number) {
  if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
    throw new Error(
      `Image trop grande apres upscale (${width} x ${height}). Limite navigateur: ${MAX_CANVAS_SIDE}px par cote.`,
    );
  }

  const megapixels = (width * height) / 1_000_000;
  if (megapixels > MAX_OUTPUT_MEGAPIXELS) {
    throw new Error(
      `Image trop grande apres upscale (${megapixels.toFixed(1)} MP). Limite: ${MAX_OUTPUT_MEGAPIXELS} MP.`,
    );
  }
}

function getCanvasContext(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Canvas indisponible dans ce navigateur");
  }
  return ctx;
}

function createCanvasSnapshot(canvas: HTMLCanvasElement) {
  const snapshot = document.createElement("canvas");
  snapshot.width = canvas.width;
  snapshot.height = canvas.height;
  const snapshotCtx = getCanvasContext(snapshot);
  snapshotCtx.drawImage(canvas, 0, 0);
  return snapshot;
}

function buildOutputFileName(
  fileName: string,
  scale: UpscaleScale,
  applyUnmarker: boolean,
) {
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const safeBase =
    base
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "image";

  return `${safeBase}-x${scale}-${applyUnmarker ? "unmarked" : "upscaled"}.jpg`;
}

function encodeCanvasAsJpeg(
  canvas: HTMLCanvasElement,
  quality: number,
  signal?: AbortSignal,
) {
  assertNotAborted(signal);
  const clampedQuality = Math.max(0.7, Math.min(0.96, quality));

  return new Promise<Blob>((resolve, reject) => {
    let settled = false;

    function cleanup() {
      signal?.removeEventListener("abort", onAbort);
    }

    function finish(blob: Blob) {
      if (settled) return;

      settled = true;
      cleanup();
      resolve(blob);
    }

    function fail(error: unknown) {
      if (settled) return;

      settled = true;
      cleanup();
      reject(error);
    }

    function onAbort() {
      fail(createAbortError());
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            fail(new Error("Export JPG impossible"));
            return;
          }

          finish(blob);
        },
        "image/jpeg",
        clampedQuality,
      );
    } catch (error) {
      fail(error);
    }
  });
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function createAbortError() {
  const error = new Error("Traitement annule");
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
