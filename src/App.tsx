import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  DownloadSimpleIcon,
  FileImageIcon,
  LightningIcon,
  UploadSimpleIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { ThemeProvider } from "next-themes";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Toaster } from "@/components/ui/sonner";
import {
  MAX_OUTPUT_MEGAPIXELS,
  processUpscaleAndUnmarkImage,
  type BatchProcessProgress,
  type UpscaleScale,
} from "@/lib/batchProcessor";
import { triggerBrowserDownload } from "@/lib/download";
import { createStoredZip } from "@/lib/storedZip";
import { cn } from "@/lib/utils";

type QueueStatus = "queued" | "processing" | "done" | "error" | "cancelled";

interface ProcessedOutput {
  blob: Blob;
  height: number;
  name: string;
  skippedVisibleRestore: boolean;
  unmarkerApplied: boolean;
  url: string;
  width: number;
}

interface QueueItem {
  error?: string;
  file: File;
  id: string;
  output?: ProcessedOutput;
  previewUrl: string;
  progress: number;
  sourceHeight?: number;
  sourceWidth?: number;
  stage: string;
  status: QueueStatus;
  warnings: string[];
}

const SCALE_OPTIONS = [2, 3, 4] as const;

function App() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [scale, setScale] = useState<UpscaleScale>(2);
  const [applyUnmarker, setApplyUnmarker] = useState(true);
  const [jpegQuality, setJpegQuality] = useState(0.88);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const itemsRef = useRef<QueueItem[]>([]);

  const completedItems = useMemo(() => items.filter(hasOutput), [items]);
  const failedCount = items.filter((item) => item.status === "error").length;
  const overallProgress = useMemo(() => {
    if (items.length === 0) {
      return 0;
    }

    const total = items.reduce((sum, item) => sum + item.progress, 0);
    return Math.round(total / items.length);
  }, [items]);

  const updateItem = useCallback(
    (id: string, update: (item: QueueItem) => QueueItem) => {
      setItems((previousItems) =>
        previousItems.map((item) => (item.id === id ? update(item) : item)),
      );
    },
    [],
  );

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const incomingFiles = Array.from(fileList);
    const imageFiles = incomingFiles.filter((file) =>
      file.type.toLowerCase().startsWith("image/"),
    );

    if (imageFiles.length === 0) {
      toast.error("Ajoute au moins une image lisible par le navigateur.");
      return;
    }

    const nextItems = imageFiles.map((file): QueueItem => ({
      file,
      id: createId(),
      previewUrl: URL.createObjectURL(file),
      progress: 0,
      stage: "En attente",
      status: "queued",
      warnings: [],
    }));

    setItems((previousItems) => [...previousItems, ...nextItems]);

    if (incomingFiles.length !== imageFiles.length) {
      toast("Certains fichiers ignores ne sont pas des images.");
    }
  }, []);

  const handleFileInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (event.target.files) {
        addFiles(event.target.files);
      }
      event.target.value = "";
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      addFiles(event.dataTransfer.files);
    },
    [addFiles],
  );

  const removeItem = useCallback((id: string) => {
    setItems((previousItems) => {
      const target = previousItems.find((item) => item.id === id);
      if (target) {
        revokeItemUrls(target);
      }
      return previousItems.filter((item) => item.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    abortControllerRef.current?.abort();
    setItems((previousItems) => {
      for (const item of previousItems) {
        revokeItemUrls(item);
      }
      return [];
    });
  }, []);

  const cancelProcessing = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const startProcessing = useCallback(async () => {
    if (items.length === 0 || isProcessing) {
      return;
    }

    const batch = items;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setIsProcessing(true);

    for (const item of batch) {
      if (item.output) {
        URL.revokeObjectURL(item.output.url);
      }
    }

    setItems((previousItems) =>
      previousItems.map((item) => ({
        ...item,
        error: undefined,
        output: undefined,
        progress: 0,
        stage: "En attente",
        status: "queued",
        warnings: [],
      })),
    );

    let successCount = 0;
    let errorCount = 0;

    for (const item of batch) {
      if (abortController.signal.aborted) {
        break;
      }

      updateItem(item.id, (currentItem) => ({
        ...currentItem,
        progress: 1,
        stage: "Demarrage",
        status: "processing",
      }));

      try {
        const result = await processUpscaleAndUnmarkImage(
          item.file,
          { applyUnmarker, jpegQuality, scale },
          abortController.signal,
          (progress) => updateProcessingProgress(item.id, progress, updateItem),
        );
        const outputUrl = URL.createObjectURL(result.blob);

        updateItem(item.id, (currentItem) => ({
          ...currentItem,
          output: {
            blob: result.blob,
            height: result.outputHeight,
            name: result.fileName,
            skippedVisibleRestore: result.skippedVisibleRestore,
            unmarkerApplied: result.unmarkerApplied,
            url: outputUrl,
            width: result.outputWidth,
          },
          progress: 100,
          sourceHeight: result.sourceHeight,
          sourceWidth: result.sourceWidth,
          stage: "Termine",
          status: "done",
          warnings: result.warnings,
        }));
        successCount += 1;
      } catch (error) {
        if (isAbortError(error)) {
          updateItem(item.id, (currentItem) => ({
            ...currentItem,
            progress: 0,
            stage: "Annule",
            status: "cancelled",
          }));
          break;
        }

        updateItem(item.id, (currentItem) => ({
          ...currentItem,
          error:
            error instanceof Error
              ? error.message
              : "Traitement impossible pour cette image.",
          progress: 0,
          stage: "Erreur",
          status: "error",
        }));
        errorCount += 1;
      }
    }

    if (abortControllerRef.current === abortController) {
      abortControllerRef.current = null;
    }
    setIsProcessing(false);

    if (abortController.signal.aborted) {
      toast("Traitement annule.");
      return;
    }

    if (successCount > 0 && errorCount === 0) {
      toast.success(`${successCount} image(s) pretes.`);
    } else if (successCount > 0) {
      toast(`${successCount} image(s) pretes, ${errorCount} erreur(s).`);
    } else {
      toast.error("Aucune image n'a pu etre traitee.");
    }
  }, [applyUnmarker, isProcessing, items, jpegQuality, scale, updateItem]);

  const downloadOne = useCallback((item: QueueItem & { output: ProcessedOutput }) => {
    triggerBrowserDownload(item.output.url, item.output.name);
  }, []);

  const downloadZip = useCallback(async () => {
    if (completedItems.length === 0 || isZipping) {
      return;
    }

    setIsZipping(true);
    try {
      const seenNames = new Map<string, number>();
      const zipBlob = await createStoredZip(
        completedItems.map((item) => ({
          blob: item.output.blob,
          lastModified: item.file.lastModified,
          name: makeUniqueFileName(item.output.name, seenNames),
        })),
      );
      const url = URL.createObjectURL(zipBlob);
      triggerBrowserDownload(
        url,
        `images-upscaled-${applyUnmarker ? "unmarked" : "only"}-${completedItems.length}.zip`,
      );
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.success("ZIP pret.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ZIP impossible.");
    } finally {
      setIsZipping(false);
    }
  }, [applyUnmarker, completedItems, isZipping]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      for (const item of itemsRef.current) {
        revokeItemUrls(item);
      }
    };
  }, []);

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      storageKey="theme"
    >
      <div className="bg-background text-foreground min-h-dvh font-sans selection:bg-primary selection:text-primary-foreground">
        <main className="mx-auto flex w-full max-w-[1480px] flex-col gap-5 px-(--page-gutter) py-5 sm:gap-6 sm:py-7">
          <header className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center gap-2 text-ui-overline text-primary">
                <LightningIcon weight="bold" />
                <span>{applyUnmarker ? "Upscale + Unmarker" : "Upscale seul"}</span>
              </div>
              <h1 className="text-3xl leading-tight font-black sm:text-5xl lg:text-6xl">
                Traitement image en une passe
              </h1>
            </div>

            <div className="grid gap-2 sm:grid-cols-3 lg:w-[36rem]">
              <Metric label="Images" value={String(items.length)} />
              <Metric label="Pretes" value={String(completedItems.length)} />
              <Metric label="Erreurs" value={String(failedCount)} />
            </div>
          </header>

          <section className="grid gap-4 lg:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)] xl:grid-cols-[minmax(22rem,26rem)_minmax(0,1fr)]">
            <aside className="flex flex-col gap-4">
              <div
                className={cn(
                  "flex min-h-72 flex-col items-center justify-center gap-4 border border-dashed p-5 text-center transition-colors",
                  isDragging
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card",
                )}
                onDragLeave={() => setIsDragging(false)}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDrop={handleDrop}
              >
                <div className="bg-muted flex size-14 items-center justify-center border">
                  <UploadSimpleIcon className="size-7" weight="bold" />
                </div>
                <div className="flex flex-col gap-1">
                  <h2 className="text-xl font-black">Deposer les images</h2>
                  <p className="text-muted-foreground text-sm font-medium">
                    Selection multiple, traitement local, sortie JPG.
                  </p>
                </div>
                <input
                  ref={fileInputRef}
                  className="hidden"
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleFileInput}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileImageIcon data-icon="inline-start" weight="bold" />
                  Choisir des fichiers
                </Button>
              </div>

              <div className="bg-card flex flex-col gap-4 border p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-ui-title">Facteur</span>
                  <div className="grid grid-cols-3 border">
                    {SCALE_OPTIONS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={cn(
                          "h-9 min-w-12 border-r px-3 text-sm font-black last:border-r-0",
                          scale === option
                            ? "bg-primary text-primary-foreground"
                            : "bg-background hover:bg-muted",
                        )}
                        disabled={isProcessing}
                        onClick={() => setScale(option)}
                      >
                        x{option}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ui-title">Qualite JPG</span>
                    <span className="text-muted-foreground text-sm font-black">
                      {Math.round(jpegQuality * 100)}%
                    </span>
                  </div>
                  <input
                    className="accent-primary h-8 w-full"
                    type="range"
                    min="70"
                    max="96"
                    value={Math.round(jpegQuality * 100)}
                    disabled={isProcessing}
                    onChange={(event) =>
                      setJpegQuality(Number(event.target.value) / 100)
                    }
                  />
                </label>

                <label className="flex items-start gap-3 border p-3">
                  <input
                    className="accent-primary mt-1 size-4 shrink-0"
                    type="checkbox"
                    checked={applyUnmarker}
                    disabled={isProcessing}
                    onChange={(event) => setApplyUnmarker(event.target.checked)}
                  />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-ui-title">Appliquer Unmarker</span>
                    <span className="text-muted-foreground text-xs font-medium">
                      Desactive pour uniquement upscaler et exporter en JPG.
                    </span>
                  </span>
                </label>

                <p className="text-muted-foreground text-xs font-medium">
                  Limite navigateur: {MAX_OUTPUT_MEGAPIXELS} MP apres upscale
                  par image.
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  size="lg"
                  disabled={items.length === 0 || isProcessing}
                  onClick={startProcessing}
                >
                  <LightningIcon data-icon="inline-start" weight="bold" />
                  {applyUnmarker ? "Upscaler + unmarker" : "Upscaler seulement"}
                </Button>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={completedItems.length === 0 || isZipping}
                    onClick={downloadZip}
                  >
                    {isZipping ? (
                      <CircleNotchIcon
                        data-icon="inline-start"
                        className="animate-spin"
                      />
                    ) : (
                      <DownloadSimpleIcon
                        data-icon="inline-start"
                        weight="bold"
                      />
                    )}
                    ZIP
                  </Button>
                  {isProcessing ? (
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={cancelProcessing}
                    >
                      <XIcon data-icon="inline-start" weight="bold" />
                      Annuler
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={items.length === 0}
                      onClick={clearAll}
                    >
                      <XIcon data-icon="inline-start" weight="bold" />
                      Vider
                    </Button>
                  )}
                </div>
              </div>

              {items.length > 0 && (
                <div className="bg-card flex flex-col gap-2 border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ui-title">Progression</span>
                    <span className="text-muted-foreground text-sm font-black">
                      {overallProgress}%
                    </span>
                  </div>
                  <Progress value={overallProgress} />
                </div>
              )}
            </aside>

            <section className="min-w-0">
              {items.length === 0 ? (
                <EmptyState />
              ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {items.map((item) => (
                    <ImageJobCard
                      key={item.id}
                      item={item}
                      onDownload={downloadOne}
                      onRemove={removeItem}
                    />
                  ))}
                </div>
              )}
            </section>
          </section>
        </main>
      </div>
      <Toaster />
    </ThemeProvider>
  );
}

export default App;

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card flex items-center justify-between gap-3 border p-3">
      <span className="text-muted-foreground text-xs font-black uppercase">
        {label}
      </span>
      <span className="text-xl font-black">{value}</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-card flex min-h-[30rem] flex-col items-center justify-center gap-4 border p-8 text-center">
      <div className="bg-muted flex size-16 items-center justify-center border">
        <FileImageIcon className="size-8" weight="bold" />
      </div>
      <div className="flex max-w-md flex-col gap-1">
        <h2 className="text-2xl font-black">Aucune image</h2>
        <p className="text-muted-foreground text-sm font-medium">
          Les resultats apparaissent ici avec le telechargement individuel.
        </p>
      </div>
    </div>
  );
}

function ImageJobCard({
  item,
  onDownload,
  onRemove,
}: {
  item: QueueItem;
  onDownload: (item: QueueItem & { output: ProcessedOutput }) => void;
  onRemove: (id: string) => void;
}) {
  const canDownload = hasOutput(item);

  return (
    <article className="bg-card flex min-w-0 flex-col overflow-hidden border">
      <div className="bg-muted relative aspect-[4/3] overflow-hidden">
        <img
          className="size-full object-cover"
          src={item.output?.url ?? item.previewUrl}
          alt=""
        />
        <div className="absolute top-2 left-2">
          <StatusBadge status={item.status} />
        </div>
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          className="absolute top-2 right-2"
          aria-label="Retirer"
          onClick={() => onRemove(item.id)}
        >
          <XIcon weight="bold" />
        </Button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3 p-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="truncate text-base font-black">{item.file.name}</h3>
          <p className="text-muted-foreground text-xs font-medium">
            {formatFileSize(item.file.size)}
            {item.sourceWidth && item.sourceHeight
              ? ` - ${item.sourceWidth} x ${item.sourceHeight}`
              : ""}
            {item.output ? ` -> ${item.output.width} x ${item.output.height}` : ""}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground truncate text-xs font-black uppercase">
              {item.stage}
            </span>
            <span className="text-muted-foreground text-xs font-black">
              {item.progress}%
            </span>
          </div>
          <Progress value={item.progress} />
        </div>

        {item.error && (
          <p className="text-destructive text-xs font-medium">{item.error}</p>
        )}

        {item.warnings.length > 0 && (
          <div className="text-muted-foreground flex gap-2 text-xs font-medium">
            <WarningCircleIcon className="mt-0.5 shrink-0" weight="bold" />
            <span>{item.warnings[0]}</span>
          </div>
        )}

        <div className="mt-auto flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            disabled={!canDownload}
            onClick={() => {
              if (canDownload) {
                onDownload(item);
              }
            }}
          >
            <DownloadSimpleIcon data-icon="inline-start" weight="bold" />
            Image
          </Button>
          {item.status === "error" || item.status === "cancelled" ? (
            <div className="text-muted-foreground flex size-8 shrink-0 items-center justify-center border">
              <ArrowClockwiseIcon weight="bold" />
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function StatusBadge({ status }: { status: QueueStatus }) {
  const config = getStatusConfig(status);
  const Icon = config.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 border px-2 py-1 text-xs font-black",
        config.className,
      )}
    >
      <Icon
        className={cn("size-3.5", status === "processing" && "animate-spin")}
        weight="bold"
      />
      {config.label}
    </span>
  );
}

function getStatusConfig(status: QueueStatus) {
  switch (status) {
    case "queued":
      return {
        className: "border-border bg-background text-foreground",
        icon: FileImageIcon,
        label: "File",
      };
    case "processing":
      return {
        className: "border-primary/30 bg-primary text-primary-foreground",
        icon: CircleNotchIcon,
        label: "Run",
      };
    case "done":
      return {
        className:
          "border-emerald-500/30 bg-emerald-500 text-white dark:bg-emerald-600",
        icon: CheckCircleIcon,
        label: "Pret",
      };
    case "error":
      return {
        className: "border-destructive/30 bg-destructive text-white",
        icon: WarningCircleIcon,
        label: "Erreur",
      };
    case "cancelled":
      return {
        className: "border-border bg-muted text-muted-foreground",
        icon: XIcon,
        label: "Annule",
      };
  }
}

function updateProcessingProgress(
  id: string,
  progress: BatchProcessProgress,
  updateItem: (id: string, update: (item: QueueItem) => QueueItem) => void,
) {
  updateItem(id, (item) => ({
    ...item,
    progress: progress.progress,
    stage: progress.label,
  }));
}

function hasOutput(item: QueueItem): item is QueueItem & { output: ProcessedOutput } {
  return Boolean(item.output);
}

function revokeItemUrls(item: QueueItem) {
  URL.revokeObjectURL(item.previewUrl);
  if (item.output) {
    URL.revokeObjectURL(item.output.url);
  }
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function makeUniqueFileName(name: string, seenNames: Map<string, number>) {
  const count = seenNames.get(name) ?? 0;
  seenNames.set(name, count + 1);

  if (count === 0) {
    return name;
  }

  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return `${name}-${count + 1}`;
  }

  return `${name.slice(0, dot)}-${count + 1}${name.slice(dot)}`;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
