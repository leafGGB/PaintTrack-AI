"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import toast, { Toaster } from "react-hot-toast";
import { uploadFile } from "../muapi.js";
import { createImageTask, getImageTaskCatalog, waitForImageTask, deleteAsset, assetIdFromResultUrl, IMAGE_TASK_ASPECT_RATIOS } from "../taskClient.js";
import { formatErrorMessage } from "../utils/formatError.js";
import { scopedPersistKey } from "../persistKey.js";
import useStudioHistory from "../useStudioHistory.js";
import { invalidateAssets } from '../assetInvalidations.js';
import DrawModal from "./DrawModal.jsx";
import ConfirmDialog from "./ui/ConfirmDialog.jsx";
import ModelParameterControls from "./ModelParameterControls.jsx";
import MobileGenerationActions, {
  GenerationCopyButtons,
} from "./MobileGenerationActions.jsx";
import {
  t2iModels,
  getAspectRatiosForModel,
  getResolutionsForModel,
  getQualityFieldForModel,
  getAspectRatiosForI2IModel,
  getResolutionsForI2IModel,
  getQualityFieldForI2IModel,
  getMaxImagesForI2IModel,
  getEffectsForI2IModel,
  getDefaultEffectForI2IModel,
  getI2IModelById,
} from "../models.js";
import {
  getFamilyVariant,
  getImageReferenceVariant,
  imageModelCatalog,
  imageModelPickerEntries,
  imageModelPickerEntryByVariantId,
} from "../modelFamilies.js";
import {
  buildReferenceParams,
  getModelMediaCapabilities,
} from "../modelCapabilities.js";
import {
  buildSupplementalInputPayload,
  createModelParameterValues,
  getSupplementalModelInputs,
} from "../modelParameters.js";
import {
  PROMPT_CONTROL_LABEL_CLASS,
  PROMPT_MEDIA_PREVIEW_CLASS,
  PromptAspectRatioIcon,
  PromptAction,
  PromptChevronIcon,
  PromptComposer,
  PromptControls,
  PromptFooter,
  PromptMenuItem,
  PromptMenuList,
  PromptPopover,
  PromptPopoverHeader,
  PromptQualityIcon,
  PromptTextarea,
  promptControlClassName,
  promptMediaButtonClassName,
} from "./prompt/PromptComposer.jsx";
import en from "../messages/en/imageStudio.json";
import zh from "../messages/zh/imageStudio.json";
import { resolveCopy } from "../i18nUtils";

// ─── helpers ────────────────────────────────────────────────────────────────

async function downloadImage(url, filename) {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  } catch {
    window.open(url, "_blank");
  }
}

// ─── UploadButton (inline picker) ───────────────────────────────────────────

function UploadButton({ apiKey, maxImages, onSelect, onClear, initialUrls = [], label = null, persistedHistory = null, onHistoryChange = null, copy }) {
  const t = copy.uploadButton;
  const [panelOpen, setPanelOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedEntries, setSelectedEntries] = useState([]); // [{url, thumbnail}]
  const [uploadHistory, setUploadHistory] = useState(persistedHistory || []); // [{id, name, url, thumbnail}]
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Notify parent whenever uploadHistory changes (for localStorage persistence)
  const onHistoryChangeRef = useRef(onHistoryChange);
  onHistoryChangeRef.current = onHistoryChange;
  useEffect(() => {
    onHistoryChangeRef.current?.(uploadHistory);
  }, [uploadHistory]);

  // Sync if parent provides a new persistedHistory (e.g. on first mount from localStorage)
  useEffect(() => {
    if (persistedHistory && persistedHistory.length > 0) {
      setUploadHistory((prev) => {
        // Merge: add any entries from persistedHistory that aren't already present
        const existingUrls = new Set(prev.map(h => h.url));
        const missing = persistedHistory.filter(h => h.url && !existingUrls.has(h.url));
        return missing.length > 0 ? [...prev, ...missing] : prev;
      });
    }
  }, [persistedHistory]);
  
  const [lastUploadProgress, setLastUploadProgress] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef(null);
  const panelRef = useRef(null);
  const triggerRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!panelOpen) return;
    const handler = (e) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target)
      ) {
        setPanelOpen(false);
      }
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [panelOpen]);

  // Sync initialUrls from parent (e.g. restored from localStorage)
  useEffect(() => {
    const nextUrls = initialUrls || [];
    const currentUrls = selectedEntries.map((entry) => entry.url);
    const isSame =
      nextUrls.length === currentUrls.length &&
      nextUrls.every((url, index) => url === currentUrls[index]);
    if (isSame) return;

    setSelectedEntries(nextUrls.map((url) => ({ url })));
    if (nextUrls.length === 0) return;

    // Also ensure restored selections are available in the history panel.
    setUploadHistory((history) => {
      const existingUrls = new Set(history.map((entry) => entry.url));
      const missing = nextUrls
        .filter((url) => !existingUrls.has(url))
        .map((url) => ({
          id: `restored-${url}`,
          name: "Restored Image",
          url,
          progress: 100,
        }));
      return missing.length > 0 ? [...missing, ...history] : history;
    });
  }, [initialUrls]); // eslint-disable-line react-hooks/exhaustive-deps

  // When maxImages changes, trim excess selections
  useEffect(() => {
    if (selectedEntries.length > maxImages) {
      const trimmed = selectedEntries.slice(0, maxImages);
      setSelectedEntries(trimmed);
      if (trimmed.length === 0) onClear?.();
    }
    if (fileInputRef.current) {
      fileInputRef.current.multiple = maxImages > 1;
    }
  }, [maxImages]); // eslint-disable-line react-hooks/exhaustive-deps

  const fireOnSelect = useCallback(
    (entries) => {
      if (!entries.length) return;
      const urls = entries.map((e) => e.url);
      onSelectRef.current?.({ url: urls[0], urls, thumbnail: entries[0].url });
    },
    [],
  );

  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = "";
    await processFiles(files);
  };

  const processFiles = async (files) => {
    if (!files.length) return;

    const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
    const tooLarge = files.filter((f) => f.size > MAX_IMAGE_SIZE);
    if (tooLarge.length > 0) {
      alert(
        t.tooLargeAlert.replace("{names}", tooLarge.map((f) => f.name).join(", ")),
      );
      return;
    }

    setUploading(true);
    try {
      const toUpload =
        maxImages === 1
          ? files.slice(0, 1)
          : files.slice(0, maxImages - selectedEntries.length || 1);

      await Promise.all(
        toUpload.map(async (file) => {
          const id = Date.now().toString() + Math.random();

          // Add a placeholder to history immediately without local preview
          const placeholder = { id, name: file.name, url: null, progress: 0 };
          setUploadHistory((prev) => [placeholder, ...prev]);

          try {
            const uploadedUrl = await uploadFile(apiKey, file, (pct) => {
              setLastUploadProgress(pct);
              setUploadHistory((prev) =>
                prev.map((h) => (h.id === id ? { ...h, progress: pct } : h)),
              );
            });

            // Update history with real URL and Mark as 100%
            setUploadHistory((prev) =>
              prev.map((h) => {
                if (h.id === id) {
                  return { ...h, url: uploadedUrl, progress: 100 };
                }
                return h;
              }),
            );

            // Auto-select if there's room
            if (selectedEntries.length < maxImages) {
              const newEntry = { url: uploadedUrl };
              setSelectedEntries((prev) => [...prev, newEntry]);

              if (maxImages === 1) {
                fireOnSelect([newEntry]);
                setPanelOpen(false);
              }
            }
          } catch (err) {
            console.error("[UploadButton] Upload failed for", file.name, err);
            setUploadHistory((prev) => prev.filter((h) => h.id !== id));
            throw err;
          }
        }),
      );
    } catch (err) {
      alert(t.uploadFailedAlert.replace("{message}", err.message));
    } finally {
      setUploading(false);
      setLastUploadProgress(0);
    }
  };

  const handleTriggerDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const handleTriggerDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  };

  const handleTriggerDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleTriggerDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length > 0) {
      processFiles(files);
    }
  };

  const handleCellClick = (entry) => {
    const selIdx = selectedEntries.findIndex((e) => e.url === entry.url);
    const isSelected = selIdx !== -1;
    const atMax =
      maxImages > 1 && !isSelected && selectedEntries.length >= maxImages;
    if (atMax) return;

    if (maxImages === 1) {
      const newSelected = [{ url: entry.url, localUrl: entry.localUrl }];
      setSelectedEntries(newSelected);
      fireOnSelect(newSelected);
      setPanelOpen(false);
    } else {
      let next;
      if (isSelected) {
        next = selectedEntries.filter((_, i) => i !== selIdx);
        if (next.length === 0) onClear?.();
      } else {
        next = [
          ...selectedEntries,
          { url: entry.url, localUrl: entry.localUrl },
        ];
      }
      setSelectedEntries(next);
    }
  };

  const handleRemoveFromHistory = (e, entry) => {
    e.stopPropagation();
    if (entry.localUrl) URL.revokeObjectURL(entry.localUrl);
    setUploadHistory((prev) => prev.filter((h) => h.id !== entry.id));

    const next = selectedEntries.filter((s) => s.url !== entry.url);
    if (next.length !== selectedEntries.length) {
      setSelectedEntries(next);
      if (next.length === 0) onClear?.();
    }
  };

  const handleDone = (e) => {
    e.stopPropagation();
    fireOnSelect(selectedEntries);
    setPanelOpen(false);
  };

  const reset = () => {
    setSelectedEntries([]);
    setPanelOpen(false);
  };

  // expose reset via ref pattern — parent calls reset() directly
  // (handled by parent through uploadedImageUrls state reset)

  const isMulti = maxImages > 1;
  const count = selectedEntries.length;
  const hasSelection = count > 0;

  // Trigger icon content
  const triggerContent = uploading ? (
    <div className="flex flex-col items-center justify-center w-full h-full absolute inset-0 bg-black/80 z-20 backdrop-blur-[2px]">
      <svg className="w-8 h-8 -rotate-90">
        <circle
          cx="16"
          cy="16"
          r="14"
          stroke="currentColor"
          strokeWidth="2"
          fill="transparent"
          className="text-white/10"
        />
        <circle
          cx="16"
          cy="16"
          r="14"
          stroke="currentColor"
          strokeWidth="2"
          fill="transparent"
          strokeDasharray={88}
          strokeDashoffset={88 - (88 * lastUploadProgress) / 100}
          className="text-[#22d3ee] transition-all duration-300"
        />
      </svg>
      <span className="absolute text-[9px] font-black text-[#22d3ee] leading-none">
        {lastUploadProgress}%
      </span>
    </div>
  ) : label === copy.promptBar.swapFaceLabel ? (
    hasSelection ? (
      <img src={selectedEntries[0].url} alt="" className="w-full h-full object-cover" />
    ) : (
      <span className="text-[10px] font-bold text-white/50">{t.faceLabel}</span>
    )
  ) : (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className="text-white/40 group-hover:text-[#22d3ee] transition-colors"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );

  const defaultLabel = isMulti ? t.addUpToImages.replace("{max}", maxImages) : t.referenceImageLabel;
  const triggerTitle = hasSelection
    ? count > 1
      ? t.multiSelectedTitle.replace("{count}", count).replace("{max}", maxImages)
      : isMulti
        ? t.singleSelectedTitle.replace("{max}", maxImages)
        : label || t.referenceImageLabel
    : label || defaultLabel;

  return (
    <div className="relative">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple={isMulti}
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        title={triggerTitle}
        onClick={(e) => {
          e.stopPropagation();
          setPanelOpen((o) => !o);
        }}
        onDragEnter={handleTriggerDragEnter}
        onDragLeave={handleTriggerDragLeave}
        onDragOver={handleTriggerDragOver}
        onDrop={handleTriggerDrop}
        className={`${promptMediaButtonClassName({
          active: hasSelection,
        })}${isDragging ? " ring-2 ring-primary border-primary bg-primary/10" : ""}`}
      >
        {triggerContent}
      </button>

      {/* Panel */}
      {panelOpen && (
        <PromptPopover
          ref={panelRef}
          onClick={(e) => e.stopPropagation()}
          className="w-96 max-w-[calc(100vw-2rem)]"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-1 pb-3 mb-2 border-b border-white/5">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-bold text-secondary">
                {t.headerTitle}
              </span>
              {isMulti && (
                <span className="text-[9px] text-muted">
                  {t.selectUpTo.replace("{max}", maxImages)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {isMulti && hasSelection && (
                <button
                  type="button"
                  onClick={handleDone}
                  className="flex items-center gap-1 px-3 py-1.5 bg-primary text-black rounded-xl text-xs font-black transition-all hover:scale-105"
                >
                  {t.doneButton.replace("{count}", count)}
                </button>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPanelOpen(false);
                  fileInputRef.current?.click();
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary rounded-full text-xs font-bold transition-all border border-primary/20"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                >
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                {isMulti ? t.uploadFilesButton : t.uploadNewButton}
              </button>
            </div>
          </div>

          {/* Grid or empty state */}
          {uploadHistory.length === 0 ? (
            <div className="py-6 flex flex-col items-center gap-2 opacity-40">
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="text-secondary"
              >
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span className="text-xs text-secondary">{t.emptyState}</span>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2 max-h-56 overflow-y-auto custom-scrollbar pr-0.5">
              {uploadHistory.map((entry) => {
                const selIdx = selectedEntries.findIndex(
                  (e) => e.url === entry.url,
                );
                const isSelected = selIdx !== -1;
                const atMax =
                  isMulti && !isSelected && selectedEntries.length >= maxImages;

                return (
                  <div
                    key={entry.id}
                    title={entry.name}
                    onClick={() => entry.url && handleCellClick(entry)}
                    className={`relative rounded-xl overflow-hidden border-2 cursor-pointer group/cell aspect-square transition-all ${
                      isSelected
                        ? "border-primary shadow-glow"
                        : "border-white/10 hover:border-white/30"
                    } ${atMax ? "opacity-40 cursor-not-allowed" : ""} ${!entry.url ? "cursor-wait" : ""}`}
                  >
                    {entry.url ? (
                      <img
                        src={entry.url}
                        alt={entry.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full bg-white/5 flex flex-col items-center justify-center">
                        <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin mb-1" />
                        <span className="text-[10px] font-black text-primary">
                          {entry.progress}%
                        </span>
                      </div>
                    )}

                    {/* Hover overlay with delete */}
                    {entry.url && (
                      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover/cell:opacity-100 transition-opacity flex items-end justify-end p-1">
                        <button
                          type="button"
                          title={t.removeFromHistory}
                          onClick={(e) => handleRemoveFromHistory(e, entry)}
                          className="w-5 h-5 bg-red-500/80 hover:bg-red-500 rounded-md flex items-center justify-center transition-colors"
                        >
                          <svg
                            width="8"
                            height="8"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="white"
                            strokeWidth="3"
                          >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    )}

                    {/* Selection badge */}
                    {isSelected && (
                      <div className="absolute top-1 left-1 min-w-[20px] h-5 bg-primary rounded-full flex items-center justify-center px-1">
                        {isMulti ? (
                          <span className="text-[10px] font-black text-black">
                            {selIdx + 1}
                          </span>
                        ) : (
                          <svg
                            width="9"
                            height="9"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="black"
                            strokeWidth="4"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Bottom bar for multi-select */}
          {isMulti && hasSelection && (
            <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between">
              <span className="text-xs text-secondary">
                {t.selectedCount.replace("{count}", count).replace("{max}", maxImages)}
              </span>
              <button
                type="button"
                onClick={handleDone}
                className="px-4 py-1.5 bg-primary text-black rounded-xl text-xs font-black transition-all hover:scale-105"
              >
                {t.useSelected}
              </button>
            </div>
          )}
        </PromptPopover>
      )}
    </div>
  );
}

// ─── ModelDropdown ────────────────────────────────────────────────────────────

const PROVIDER_LOGOS = {
  openai: "https://cdn.muapi.ai/models/openai.png",
  google: "https://cdn.muapi.ai/models/gemini.png",
  kling: "https://cdn.muapi.ai/models/kling.png",
  alibaba: "https://cdn.muapi.ai/models/alibaba.png",
  bytedance: "https://cdn.muapi.ai/models/bytedance.png",
  blackforest: "https://cdn.muapi.ai/models/bfl.png",
  minimax: "https://cdn.muapi.ai/models/minimax.png",
  suno: "https://cdn.muapi.ai/models/suno.png",
  anthropic: "https://cdn.muapi.ai/models/claude.png",
  meshy: "https://cdn.muapi.ai/models/meshy-3.png",
  tripo3d: "https://cdn.muapi.ai/models/tripo3d.png",
  grok: "https://cdn.muapi.ai/models/xai.png",
  muapi: "https://cdn.muapi.ai/models/muapi.png",
  midjourney: "https://cdn.muapi.ai/models/midjourney.png",
  vidu: "https://cdn.muapi.ai/models/vidu.png",
  runway: "https://cdn.muapi.ai/models/runway.png",
  luma: "https://cdn.muapi.ai/models/luma.png",
  ideogram: "https://cdn.muapi.ai/models/ideogram.png",
  leonardoai: "https://cdn.muapi.ai/models/leonardoai.png",
  hunyuan: "https://cdn.muapi.ai/models/hunyuan.png",
  hidream: "https://cdn.muapi.ai/models/hidream.png",
  lightricks: "https://cdn.muapi.ai/models/lightricks.png",
  pixverse: "https://cdn.muapi.ai/models/pixverse.png",
  reve: "https://cdn.muapi.ai/models/reve.png",
  stability: "https://cdn.muapi.ai/models/stability.png"
};

const invertLogos = ['openai', 'blackforest', 'runway', 'ideogram', 'lightricks', 'grok'];

function ModelDropdown({ selectedModel, onSelect, onClose, copy }) {
  const t = copy.modelDropdown;
  const [search, setSearch] = useState("");
  const selectedEntry = imageModelPickerEntryByVariantId.get(selectedModel);
  const modelCategories = [
    {
      id: "all",
      label: t.categoryAll,
      entries: imageModelPickerEntries,
    },
    {
      id: "t2i",
      label: t.categoryT2I,
      entries: imageModelPickerEntries.filter((entry) => entry.variantsByMode.t2i),
    },
    {
      id: "i2i",
      label: t.categoryI2I,
      entries: imageModelPickerEntries.filter((entry) => entry.variantsByMode.i2i),
    },
  ];
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [selectedProvider, setSelectedProvider] = useState("all");
  const activeCategory = modelCategories.find((category) => category.id === selectedCategory) || modelCategories[0];
  const modelEntries = activeCategory.entries;

  const activeItemRef = useRef(null);

  useEffect(() => {
    // Automatically scroll the active model into view when opening
    if (activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: "nearest" });
    }
  }, []);

  const getProviderStyle = (provider) => {
    switch (provider) {
      case "grok":
        return { text: "xI", bg: "bg-orange-500/10 text-orange-400 border-orange-500/25" };
      case "openai":
        return { text: "O", bg: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25" };
      case "google":
        return { text: "G", bg: "bg-blue-500/10 text-blue-400 border-blue-500/25" };
      case "blackforest":
        return { text: "BF", bg: "bg-amber-500/10 text-amber-400 border-amber-500/25" };
      case "bytedance":
        return { text: "BD", bg: "bg-purple-500/10 text-purple-400 border-purple-500/25" };
      case "midjourney":
        return { text: "MJ", bg: "bg-indigo-500/10 text-indigo-400 border-indigo-500/25" };
      case "kling":
        return { text: "KL", bg: "bg-rose-500/10 text-rose-400 border-rose-500/25" };
      case "vidu":
        return { text: "VD", bg: "bg-cyan-500/10 text-cyan-400 border-cyan-500/25" };
      case "minimax":
        return { text: "MX", bg: "bg-pink-500/10 text-pink-400 border-pink-500/25" };
      case "ideogram":
        return { text: "ID", bg: "bg-yellow-500/10 text-yellow-400 border-yellow-500/25" };
      case "luma":
        return { text: "LM", bg: "bg-teal-500/10 text-teal-400 border-teal-500/25" };
      case "alibaba":
        return { text: "AL", bg: "bg-sky-500/10 text-sky-400 border-sky-500/25" };
      case "leonardoai":
        return { text: "LE", bg: "bg-violet-500/10 text-violet-400 border-violet-500/25" };
      case "stability":
        return { text: "SD", bg: "bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/25" };
      default:
        const name = provider ? provider.toUpperCase() : "AI";
        return { text: name.substring(0, 2), bg: "bg-primary/10 text-primary border-primary/25" };
    }
  };

  // Dynamically compute list of providers from the input models list
  const availableProviders = [];
  const seenProviders = new Set();
  
  modelEntries.forEach(({ family }) => {
    const pId = family.provider || 'muapi';
    const pName = family.provider_name || 'Muapi';
    if (!seenProviders.has(pId)) {
      seenProviders.add(pId);
      availableProviders.push({ id: pId, name: pName });
    }
  });

  const filtered = modelEntries.filter((entry) => {
    const { family } = entry;
    // 1. Filter by provider tab
    if (selectedProvider !== "all") {
      const pId = family.provider || 'muapi';
      if (pId !== selectedProvider) return false;
    }
    // 2. Filter by search query
    const query = search.toLowerCase();
    return entry.searchText.includes(query);
  });

  return (
    <div className="flex gap-4 h-full max-h-[60vh] min-h-[350px] overflow-x-hidden">
      {/* Left Sidebar: Provider tabs */}
      <div className="flex flex-col gap-2.5 items-center pr-2 border-r border-white/5 shrink-0 select-none overflow-y-auto custom-scrollbar w-14 pt-0.5">
        <button
          type="button"
          onClick={() => setSelectedProvider("all")}
          className={`w-8 h-8 rounded-full flex items-center justify-center border transition-all flex-shrink-0 cursor-pointer ${
            selectedProvider === "all"
              ? "bg-white/10 text-yellow-400 border-yellow-500/30 shadow-md scale-105"
              : "bg-white/[0.02] text-white/50 border-white/[0.03] hover:bg-white/5 hover:text-white"
          }`}
          title={t.allProviders}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill={selectedProvider === "all" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </button>
        
        {availableProviders.map(p => {
          const style = getProviderStyle(p.id);
          const isSelected = selectedProvider === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedProvider(p.id)}
              aria-pressed={isSelected}
              className={`w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center overflow-hidden font-black text-[10px] border transition-all cursor-pointer ${
                isSelected
                  ? `${style.bg} scale-105 shadow-md shadow-black/10`
                  : "bg-white/[0.02] text-white/40 border-white/[0.02] hover:bg-white/5 hover:text-white/80"
              }`}
              title={p.name}
            >
              {PROVIDER_LOGOS[p.id] ? (
                <img
                  src={PROVIDER_LOGOS[p.id]}
                  alt={p.name}
                  className={`w-full h-full rounded-full object-contain ${invertLogos.includes(p.id) ? "invert" : ""}`}
                />
              ) : (
                style.text
              )}
            </button>
          );
        })}
      </div>

      {/* Right Pane: Search input + Models list */}
      <div className="flex-1 flex flex-col gap-2 min-w-0">
        <div className="border-b border-white/5 shrink-0 pb-2 space-y-2">
          <div className="flex gap-1.5 overflow-x-auto custom-scrollbar pb-0.5">
            {modelCategories.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => {
                  setSelectedCategory(category.id);
                  setSelectedProvider("all");
                }}
                className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[10px] font-bold transition-colors border ${
                  selectedCategory === category.id
                    ? "bg-primary/15 text-primary border-primary/30"
                    : "bg-white/[0.02] text-white/50 border-white/[0.04] hover:bg-white/5 hover:text-white"
                }`}
              >
                {category.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-2 border border-white/5 focus-within:border-primary/50 transition-colors">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              className="text-muted"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder={t.searchPlaceholder}
              value={search}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                const value = e.target.value;
                setSearch(value);
                if (value.trim()) setSelectedProvider("all");
              }}
              className="bg-transparent border-none text-xs text-white focus:ring-0 w-full p-0 focus:outline-none"
            />
          </div>
        </div>
        
        <div className="text-xs font-semibold text-secondary py-1 shrink-0 flex items-center justify-between">
          <span>{activeCategory.label} {t.modelsSuffix}</span>
          {selectedProvider !== "all" && (
            <span className="text-[10px] bg-white/5 px-2 py-0.5 rounded text-white/60">
              {availableProviders.find(p => p.id === selectedProvider)?.name || selectedProvider}
            </span>
          )}
        </div>
        
        <div className="flex flex-col gap-1.5 overflow-y-auto custom-scrollbar pr-1 pb-2 flex-1">
          {filtered.length === 0 ? (
            <div className="text-xs text-white/30 text-center py-6">
              {t.noModelsFound}
            </div>
          ) : (
            filtered.map((entry) => {
              const { family } = entry;
              const isSelected = selectedEntry === entry;
              return (
              <div
                key={entry.id}
                ref={isSelected ? activeItemRef : null}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(entry, activeCategory.id);
                  onClose();
                }}
                className={`flex items-center justify-between p-3 hover:bg-white/5 rounded-lg cursor-pointer transition-all border border-transparent hover:border-white/5 ${
                  isSelected ? "bg-white/5 border-white/5" : ""
                }`}
              >
                <div className="flex items-center gap-3">
                  {PROVIDER_LOGOS[family.provider] ? (
                    <div className="w-8 h-8 rounded-full border border-white/5 overflow-hidden shrink-0 flex items-center justify-center bg-white/[0.02]">
                      <img
                        src={PROVIDER_LOGOS[family.provider]}
                        alt={family.provider_name}
                        className={`w-full h-full object-contain p-1 ${invertLogos.includes(family.provider) ? "invert" : ""}`}
                      />
                    </div>
                  ) : (
                    <div
                      className={`w-8 h-8 ${
                        family.id.includes("kontext")
                          ? "bg-blue-500/10 text-blue-400 border-blue-500/10"
                          : family.id.includes("effects")
                            ? "bg-purple-500/10 text-purple-400 border-purple-500/10"
                            : "bg-primary/10 text-primary border-primary/10"
                      } border rounded-full flex items-center justify-center font-bold text-xs shadow-inner uppercase`}
                    >
                      {entry.name.charAt(0)}
                    </div>
                  )}
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-xs font-bold text-white tracking-tight truncate">
                      {entry.name}
                    </span>
                    <div className="flex items-center gap-1.5">
                    {selectedProvider === "all" && family.provider_name && (
                      <span className="text-[9px] text-white/40">
                        {family.provider_name}
                      </span>
                    )}
                    </div>
                  </div>
                </div>
                {isSelected && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#22d3ee"
                    strokeWidth="4"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ─── SimpleDropdown ───────────────────────────────────────────────────────────

function SimpleDropdown({ title, options, selected, onSelect, onClose }) {
  return (
    <>
      <PromptPopoverHeader>{title}</PromptPopoverHeader>
      <PromptMenuList>
        {options.map((opt) => (
          <PromptMenuItem
            key={opt}
            selected={selected === opt}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(opt);
              onClose();
            }}
          >
            {opt}
          </PromptMenuItem>
        ))}
      </PromptMenuList>
    </>
  );
}

function CatalogModelSelect({ models, selectedModelId, onSelect, disabled, copy }) {
  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="sr-only">{copy.popovers.model}</span>
      <select
        aria-label={copy.popovers.model}
        value={selectedModelId || ""}
        disabled={disabled || models.length === 0}
        onChange={(event) => onSelect(event.target.value)}
        className="max-w-[220px] min-w-0 bg-transparent text-xs font-bold text-white outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {models.length === 0 ? <option value="">{copy.modelDropdown.noModelsFound}</option> : null}
        {models.map((model) => (
          <option key={model.logicalModelId} value={model.logicalModelId}>
            {model.displayName} ({model.logicalModelId})
          </option>
        ))}
      </select>
    </label>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ImageStudio({
  apiKey,
  accountId = null,
  taskModelId = null,
  onGenerationStart,
  onGenerationEnd,
  onGenerationComplete,
  onGenerationError,
  historyItems,
  onDeleteHistoryItem,
  droppedFiles,
  onFilesHandled,
  locale = "en",
}) {
  const copy = resolveCopy(en, zh, locale);
  const LEGACY_PERSIST_KEY = "hg_image_studio_persistent";
  const persistIdentity = accountId || apiKey || null;
  const PERSIST_KEY = scopedPersistKey(LEGACY_PERSIST_KEY, persistIdentity);

  // ── Model state ─────────────────────────────────────────────────────────
  const initialFamily = imageModelCatalog.familyByVariantId.get(t2iModels[0].id);
  const [imageMode, setImageMode] = useState(false); // 任务服务当前仅支持文生图
  const [catalogModels, setCatalogModels] = useState([]);
  const [selectedModelId, setSelectedModelId] = useState(null);
  const [selectedFamilyId, setSelectedFamilyId] = useState(initialFamily.id);
  const [selectedAr, setSelectedAr] = useState(
    t2iModels[0].inputs?.aspect_ratio?.default || "1:1",
  );
  const [selectedQuality, setSelectedQuality] = useState(() => {
    const resolutions = getResolutionsForModel(t2iModels[0].id);
    return resolutions[0] || null;
  });
  const [selectedEffect, setSelectedEffect] = useState("");
  const [modelParameterValues, setModelParameterValues] = useState(() =>
    createModelParameterValues(t2iModels[0]),
  );

  // ── Prompt / upload state ───────────────────────────────────────────────
  const [prompt, setPrompt] = useState("");
  const [uploadedImageUrls, setUploadedImageUrls] = useState([]);
  const [swapImageUrl, setSwapImageUrl] = useState(null);
  const [uploadHistory, setUploadHistory] = useState([]); // persisted reference images history

  // ── UI state ────────────────────────────────────────────────────────────
  const [dropdownOpen, setDropdownOpen] = useState(null); // 'model' | 'ar' | 'quality' | null
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(null);
  const [taskModelLoading, setTaskModelLoading] = useState(true);
  const [taskModelError, setTaskModelError] = useState(null);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [fullscreenUrl, setFullscreenUrl] = useState(null);
  const studioHistory = useStudioHistory(accountId, "image");
  const useAccountHistory = Boolean(accountId);
  const activeHistoryItems = useAccountHistory ? studioHistory.items : historyItems;
  const isHistoryLoading = useAccountHistory && studioHistory.loading;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setTaskModelLoading(true);
    setTaskModelError(null);
    setCatalogModels([]);
    setSelectedModelId(null);
    getImageTaskCatalog({ signal: controller.signal })
      .then((models) => {
        if (!active) return;
        setCatalogModels(models);
        setImageMode(false);
        const requested = taskModelId == null ? null : models.find((model) => model.logicalModelId === taskModelId);
        if (taskModelId != null && !requested) {
          setSelectedModelId(null);
          setTaskModelError("TASK_MODEL_NOT_IN_CATALOG");
          return;
        }
        const nextModel = requested || models[0] || null;
        setSelectedModelId(nextModel?.logicalModelId ?? null);
        setTaskModelError(nextModel ? null : "NO_IMAGE_TASK_MODEL");
      })
      .catch((error) => {
        if (!active || error?.name === "AbortError") return;
        setCatalogModels([]);
        setSelectedModelId(null);
        const safeCode = ["CATALOG_QUERY_FAILED", "CATALOG_UNAVAILABLE", "UNAUTHENTICATED", "FORBIDDEN", "MFA_REQUIRED", "INVALID_IMAGE_CATALOG", "DUPLICATE_IMAGE_MODEL_ID"].includes(error?.code)
          ? error.code : "CATALOG_QUERY_FAILED";
        setTaskModelError(safeCode);
      })
      .finally(() => {
        if (active) setTaskModelLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [taskModelId, catalogRetry, accountId]);
  const [isDrawModalOpen, setIsDrawModalOpen] = useState(false);

  // ── Canvas / history state ──────────────────────────────────────────────
  const [currentImageUrl, setCurrentImageUrl] = useState(null);
  const [activeHistoryIdx, setActiveHistoryIdx] = useState(0);
  const [localHistory, setLocalHistory] = useState([]);

  // 删除确认走应用内的 ConfirmDialog，而不是浏览器原生 confirm：原生弹窗
  // 会带出「<host> 显示」标题、按钮文案跟随浏览器语言、并且无法展示「删除中」
  // 与失败原因（失败即丢弃上下文）。
  const [pendingDelete, setPendingDelete] = useState(null); // { entry, idx }
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  // Explicit callers can provide their own history; standalone signed-in studios use the account API.
  const history = activeHistoryItems ?? localHistory;

  // When historyItems is server-backed (White Label / backfilled sessions),
  // localHistory isn't what's rendered — removal has to go through the
  // parent so it deletes server-side (UsageLog + S3) and updates the same
  // state `history` reads from. Falls back to the old local-only removal
  // when there's no server-backed list (e.g. standalone/embedded studio).
  //
  // PaintTrack 任务服务归档的图片另有归属：条目带 assetId（或 url 是
  // /api/assets/<id>/content）时，必须先调用 DELETE /api/assets/:id 让服务端
  // 软删除、内容地址立即失效，再从列表移除。服务端失败时保留条目，用户可以重试。
  const handleDeleteEntry = useCallback(async (entry, idx) => {
    const assetId = entry?.assetId || assetIdFromResultUrl(entry?.url);
    if (assetId) await deleteAsset(assetId);
    if (useAccountHistory) {
      await studioHistory.refresh();
      invalidateAssets(accountId);
    } else if (historyItems && onDeleteHistoryItem) {
      await onDeleteHistoryItem(entry);
    } else {
      setLocalHistory((prev) => prev.filter((_, i) => i !== idx));
    }
  }, [useAccountHistory, studioHistory.refresh, historyItems, onDeleteHistoryItem]);

  const describeDeleteError = useCallback((err) => (
    err?.code === "ASSET_NOT_DELETABLE"
      ? copy.gallery.deleteNotReady
      : formatErrorMessage(err, copy.gallery.deleteFailed)
  ), [copy.gallery.deleteFailed, copy.gallery.deleteNotReady]);

  // 打开确认弹窗（不立即发请求）。
  const requestDelete = useCallback((entry, idx) => {
    setDeleteError(null);
    setPendingDelete({ entry, idx });
  }, []);

  // 取消：请求进行中不允许关闭，避免用户以为已中止而重复操作。
  const cancelDelete = useCallback(() => {
    if (deleteBusy) return;
    setPendingDelete(null);
    setDeleteError(null);
  }, [deleteBusy]);

  // 确认后才真正删除。失败保留弹窗并把原因显示在弹窗内，用户可重试或取消。
  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await handleDeleteEntry(pendingDelete.entry, pendingDelete.idx);
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(describeDeleteError(err));
    } finally {
      setDeleteBusy(false);
    }
  }, [pendingDelete, deleteBusy, handleDeleteEntry, describeDeleteError]);

  // ── Refs ────────────────────────────────────────────────────────────────
  const textareaRef = useRef(null);
  const dropdownRef = useRef(null);
  const uploadPickerResetRef = useRef(null); // not used directly — managed via key
  const selectionRef = useRef(null);
  const generationControllerRef = useRef(null);
  selectionRef.current = { imageMode, selectedFamilyId, selectedModelId };

  const generationActiveRef = useRef(false);
  useEffect(() => () => {
    generationActiveRef.current = false;
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
  }, []);

  // ── Close dropdown on outside click ─────────────────────────────────────
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(null);
      }
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [dropdownOpen]);

  // ── Persistence: Load ────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const stored = localStorage.getItem(PERSIST_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        // 任务服务仅支持文生图，旧编辑模式和参考图不得恢复到当前草稿。
        setImageMode(false);
        setUploadedImageUrls([]);
        if (data.selectedAr) setSelectedAr(data.selectedAr);
        if (data.selectedQuality) setSelectedQuality(data.selectedQuality);
        if (data.selectedEffect) setSelectedEffect(data.selectedEffect);
        if (data.prompt) setPrompt(data.prompt);
        if (data.uploadHistory) setUploadHistory(data.uploadHistory);
        if (!accountId && data.localHistory) setLocalHistory(data.localHistory);
      }
    } catch (err) {
      console.warn("Failed to load ImageStudio persistence:", err);
    }
  }, [PERSIST_KEY, accountId]);

  // ── Adjust height on load ────────────────────────────────────────────────
  // ── Persistence: Save ────────────────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const state = {
          imageMode,
          selectedModelId,
          selectedFamilyId,
          selectedAr,
          selectedQuality,
          selectedEffect,
          prompt,
          uploadedImageUrls,
          uploadHistory,
          ...(!accountId ? { localHistory } : {}),
        };
        localStorage.setItem(PERSIST_KEY, JSON.stringify(state));
      } catch (err) {
        console.warn("Failed to save ImageStudio persistence:", err);
      }
    }, 500); // 500ms debounce
    return () => clearTimeout(timer);
  }, [
    imageMode,
    selectedModelId,
    selectedFamilyId,
    selectedAr,
    selectedQuality,
    selectedEffect,
    modelParameterValues,
    prompt,
    uploadedImageUrls,
    uploadHistory,
    localHistory,
    accountId,
    PERSIST_KEY,
  ]);

  const processDroppedImages = async (files) => {
    const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
    const tooLarge = files.filter((f) => f.size > MAX_IMAGE_SIZE);
    if (tooLarge.length > 0) {
      alert(
        copy.uploadButton.tooLargeAlert.replace("{names}", tooLarge.map((f) => f.name).join(", "))
      );
      return;
    }

    const family = imageModelCatalog.familyById.get(selectedFamilyId);
    const editor = null;
    if (!editor) {
      toast.error("参考图功能尚未接入任务服务。");
      return;
    }

    setGenerating(true); // Show as generating/busy
    try {
      const uploadLimit = getMaxImagesForI2IModel(editor.model.id);
      const toUpload =
        uploadLimit === 1
          ? files.slice(0, 1)
          : files.slice(0, uploadLimit);
      const urls = await Promise.all(
        toUpload.map(async (file) => {
          try {
            return await uploadFile(apiKey, file);
          } catch (err) {
            console.error(
              "[ImageStudio] Drop upload failed for",
              file.name,
              err
            );
            throw err;
          }
        })
      );

      handleUploadSelect({ urls });
    } catch (err) {
      alert(copy.uploadButton.uploadFailedAlert.replace("{message}", err.message));
    } finally {
      setGenerating(false);
    }
  };

  // ── Handle Dropped Files ────────────────────────────────────────────────
  useEffect(() => {
    if (droppedFiles && droppedFiles.length > 0) {
      const imageFiles = droppedFiles.filter(f => f.type.startsWith('image/'));
      if (imageFiles.length > 0) {
        processDroppedImages(imageFiles);
      }
      onFilesHandled?.();
    }
  }, [droppedFiles, onFilesHandled, processDroppedImages]);

  // ── Derived: current model lists & helpers ───────────────────────────────
  const currentAspectRatios = IMAGE_TASK_ASPECT_RATIOS;
  const currentResolutions = [];
  const currentQualityField = null;
  const showQualityBtn = false;
  const currentEffects = [];
  const showEffectBtn = false;
  const selectedFamily = imageModelCatalog.familyById.get(selectedFamilyId) || initialFamily;
  const selectedCatalogModel = catalogModels.find((model) => model.logicalModelId === selectedModelId) || null;
  const selectedPickerEntry = imageModelPickerEntryByVariantId.get(selectedModelId);
  const selectedModelDisplayName = selectedCatalogModel?.displayName || copy.popovers.model;
  const canGenerate = !generating && !taskModelLoading && !taskModelError
    && Boolean(selectedCatalogModel && prompt.trim());
  const catalogStatus = taskModelLoading ? "loading"
    : taskModelError === "NO_IMAGE_TASK_MODEL" ? "empty"
      : taskModelError ? "error" : "loaded";
  const catalogStatusCode = taskModelLoading ? "IMAGE_MODEL_CATALOG_LOADING" : taskModelError;
  const currentMode = "t2i";
  const selectedVariant = null;
  const supplementalInputs = [];
  const referenceVariant = null;
  const referenceImageLimit = 0;

  const applySelectedVariant = useCallback((variant, mode, family) => {
    const model = variant.model;
    const nextImageMode = mode === "i2i";
    const ars = nextImageMode
      ? getAspectRatiosForI2IModel(model.id)
      : getAspectRatiosForModel(model.id);
    const resolutions = nextImageMode
      ? getResolutionsForI2IModel(model.id)
      : getResolutionsForModel(model.id);

    selectionRef.current = {
      imageMode: nextImageMode,
      selectedFamilyId: family.id,
      selectedModelId: model.id,
    };
    setImageMode(nextImageMode);
    setSelectedFamilyId(family.id);
    setSelectedModelId(model.id);
    setModelParameterValues((values) =>
      createModelParameterValues(model, values),
    );
    setSelectedAr(ars[0] || "1:1");
    setSelectedQuality(resolutions[0] || null);

    if (nextImageMode) {
      const effects = getEffectsForI2IModel(model.id);
      setSelectedEffect(
        effects.length > 0
          ? (getDefaultEffectForI2IModel(model.id) || effects[0])
          : "",
      );
    } else {
      setSelectedEffect("");
    }
  }, []);

  const applyUserSelectedVariant = useCallback((variant, mode, family) => {
    if (mode === "t2i") {
      setUploadedImageUrls([]);
    } else {
      const maxImages = getMaxImagesForI2IModel(variant.model.id);
      setUploadedImageUrls((urls) => urls.slice(0, maxImages));
    }
    setSwapImageUrl(null);
    applySelectedVariant(variant, mode, family);
  }, [applySelectedVariant]);

  // ── Textarea auto-resize ─────────────────────────────────────────────────
  // ── Upload picker callbacks ──────────────────────────────────────────────
  const handleUploadSelect = useCallback(
    ({ url, urls }) => {
      const newUrls = urls || [url];
      const selection = selectionRef.current;
      const family = imageModelCatalog.familyById.get(selection.selectedFamilyId);
      const target = getImageReferenceVariant(
        imageModelCatalog,
        family,
        selection.selectedModelId,
      );
      if (!target) {
        toast.error(copy.errors.noImageReferenceSupport.replace("{name}", family.name));
        return;
      }

      const limit = getModelMediaCapabilities(target.model).image.maxItems;
      setUploadedImageUrls(newUrls.slice(0, limit));
      const currentMode = selection.imageMode ? "i2i" : "t2i";
      if (target.model.id !== selection.selectedModelId || target.mode !== currentMode) {
        applySelectedVariant(target, target.mode, family);
      }
    },
    [applySelectedVariant],
  );

  const handleUploadClear = useCallback(() => {
    setUploadedImageUrls([]);
    setImageMode(false);
  }, []);

  // ── Model selection ──────────────────────────────────────────────────────
  const handleModelSelect = (logicalModelId) => {
    if (!catalogModels.some((model) => model.logicalModelId === logicalModelId)) return;
    setSelectedModelId(logicalModelId);
    setTaskModelError(null);
  };

  // ── History helpers ──────────────────────────────────────────────────────
  const addToHistory = useCallback(
    (entry) => {
      if (useAccountHistory) {
        void studioHistory.refresh();
        invalidateAssets(accountId);
      } else if (!historyItems) {
        setLocalHistory((prev) => [entry, ...prev.slice(0, 49)]);
      }
      setActiveHistoryIdx(0);
      setCurrentImageUrl(entry.url);
    },
    [useAccountHistory, studioHistory.refresh, historyItems],
  );

  // ── View state ─────────────────────────────────────

  const resetToPrompt = () => {
    generationActiveRef.current = false;
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
    setCurrentImageUrl(null);
    setPrompt("");
    setUploadedImageUrls([]);
    setImageMode(false);
    const firstT2I = t2iModels[0];
    const ars = getAspectRatiosForModel(firstT2I.id);
    const resolutions = getResolutionsForModel(firstT2I.id);
    const family = imageModelCatalog.familyByVariantId.get(firstT2I.id);
    setSelectedModelId(catalogModels[0]?.logicalModelId ?? null);
    setSelectedFamilyId(family.id);
    setSelectedAr(ars[0] || "1:1");
    setSelectedQuality(resolutions[0] || null);
    setSelectedEffect("");
    setModelParameterValues(createModelParameterValues(firstT2I));
  };

  // ── Generation ───────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (generating) return;
    if (imageMode || uploadedImageUrls.length > 0 || swapImageUrl) {
      const message = "参考图和图生图功能尚未接入任务服务。";
      setGenerateError(message);
      onGenerationError?.(message);
      return;
    }
    if (!prompt.trim()) {
      alert(copy.errors.enterPromptFirst);
      return;
    }
    if (taskModelLoading) {
      setGenerateError("IMAGE_MODEL_CATALOG_LOADING");
      return;
    }
    if (!selectedModelId || !catalogModels.some((model) => model.logicalModelId === selectedModelId)) {
      const message = taskModelError || "IMAGE_TASK_MODEL_UNAVAILABLE";
      setGenerateError(message);
      onGenerationError?.(message);
      return;
    }

    onGenerationStart?.();
    setGenerating(true);
    setGenerateError(null);
    const controller = new AbortController();
    generationControllerRef.current = controller;
    generationActiveRef.current = true;
    try {
      const aspectRatio = IMAGE_TASK_ASPECT_RATIOS.includes(selectedAr) ? selectedAr : "1:1";
      const createdTask = await createImageTask({
        logicalModelId: selectedModelId,
        outputCount: 1,
        prompt: prompt.trim(),
        aspectRatio,
        signal: controller.signal,
      });
      const completedTask = await waitForImageTask(createdTask.id, { signal: controller.signal });
      if (!generationActiveRef.current || controller.signal.aborted) return;
      const url = completedTask.result.resultUrl;
      addToHistory({
        id: completedTask.id,
        assetId: completedTask.result.assetId || assetIdFromResultUrl(url),
        url,
        prompt: prompt.trim(),
        model: selectedModelId,
        aspect_ratio: aspectRatio,
        timestamp: new Date().toISOString(),
      });
      onGenerationComplete?.({ url, model: selectedModelId, prompt: prompt.trim(), type: "image" });
    } catch (e) {
      if (!generationActiveRef.current || e?.name === "AbortError") return;
      console.error("[ImageStudio] Generation failed:", e);
      const errMsg = e?.code === "IMAGE_RESULT_NOT_AVAILABLE"
        ? "The task completed, but its image has not been archived for preview yet."
        : formatErrorMessage(e, copy.errors.generationFailed);
      setGenerateError(errMsg);
      if (onGenerationError) onGenerationError(errMsg);
      else toast.error(errMsg);
    } finally {
      if (generationControllerRef.current === controller) generationControllerRef.current = null;
      generationActiveRef.current = false;
      controller.abort();
      setGenerating(false);
      onGenerationEnd?.();
    }
  };

  const placeholderText =
    uploadedImageUrls.length > 1
      ? copy.promptBar.placeholderMultiImage.replace("{count}", uploadedImageUrls.length)
      : imageMode
        ? copy.promptBar.placeholderI2I
        : copy.promptBar.placeholderT2I;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-app-bg relative p-4 md:p-6 overflow-hidden">
      
      {/* ── CENTRAL GALLERY AREA ── */}
      <div className="flex-1 w-full max-w-7xl mx-auto overflow-y-auto custom-scrollbar pb-40 lg:pb-32 px-2">
        {useAccountHistory && studioHistory.error && (
          <div role="alert" className="mt-4 text-center text-sm text-red-300">
            {locale === "zh" ? "账号历史加载失败，不会显示本地历史。" : "Account history could not be loaded. Local history is not used."}
            <button type="button" className="ml-2 underline" disabled={isHistoryLoading} onClick={() => void studioHistory.retry()}>
              {locale === "zh" ? "重试" : "Retry"}
            </button>
          </div>
        )}
        {isHistoryLoading && <div role="status" className="py-4 text-center text-sm text-white/60">{locale === "zh" ? "正在加载历史…" : "Loading history…"}</div>}
        {generateError && (
          <div role="alert" className="mt-4 text-center text-sm text-red-300">
            {generateError}
            <button type="button" className="ml-2 underline" disabled={!canGenerate} onClick={handleGenerate}>{locale === "zh" ? "重试生成" : "Retry generation"}</button>
          </div>
        )}
        {history.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 w-full pt-4 animate-fade-in-up">
            {history.map((entry, idx) => (
              <div
                key={entry.id || idx}
                className="relative group rounded-lg overflow-hidden border border-white/10 bg-[#0a0a0a] shadow-xl hover:border-primary/50 transition-all duration-300 flex flex-col cursor-pointer"
                onClick={() => setFullscreenUrl(entry.url)}
              >
                <img
                  src={entry.url}
                  alt={entry.prompt?.substring(0, 30) || copy.gallery.generatedImageAlt}
                  className="w-full aspect-square object-cover bg-black/40 hover:opacity-80 transition-opacity"
                />

                {/* Overlay actions */}
                <div className="absolute top-2 right-2 hidden md:flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <GenerationCopyButtons
                    prompt={entry.prompt}
                    imageUrl={entry.url}
                    onCopyError={onGenerationError}
                  />
                  <button
                    type="button"
                    title={copy.gallery.download}
                    onClick={(e) => {
                      e.stopPropagation();
                      downloadImage(entry.url, `muapi-${entry.id || idx}.jpg`);
                    }}
                    className="p-2 bg-black/60 backdrop-blur-md rounded-full text-white hover:bg-primary hover:text-black transition-all border border-white/10"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    title={copy.gallery.delete}
                    onClick={(e) => {
                      e.stopPropagation();
                      requestDelete(entry, idx);
                    }}
                    className="p-2 bg-black/60 backdrop-blur-md rounded-full text-red-400 hover:bg-red-500 hover:text-white transition-all border border-white/10"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      <line x1="10" y1="11" x2="10" y2="17" />
                      <line x1="14" y1="11" x2="14" y2="17" />
                    </svg>
                  </button>
                </div>
                <MobileGenerationActions
                  prompt={entry.prompt}
                  imageUrl={entry.url}
                  onCopyError={onGenerationError}
                  actions={[
                    {
                      kind: "download",
                      label: copy.gallery.download,
                      onSelect: () =>
                        downloadImage(entry.url, `muapi-${entry.id || idx}.jpg`),
                    },
                    {
                      kind: "delete",
                      label: copy.gallery.delete,
                      danger: true,
                      onSelect: () => requestDelete(entry, idx),
                    },
                  ]}
                />

                {/* Prompt & Details */}
                <div className="p-3 bg-black/80 backdrop-blur-sm border-t border-white/5 flex-1 flex flex-col justify-between gap-2">
                  <p className="text-white/70 text-xs line-clamp-3 leading-relaxed" title={entry.prompt}>
                    {entry.prompt || copy.gallery.noPrompt}
                  </p>
                  <div className="flex items-center justify-between mt-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-primary px-2 py-0.5 bg-primary/10 rounded border border-primary/20 capitalize">
                        {entry.model?.replace("-", " ") || copy.gallery.modelFallback}
                      </span>
                      <span className="text-[10px] text-white/40">{entry.aspect_ratio}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : !isHistoryLoading && !(useAccountHistory && studioHistory.error) ? (
          <div className="flex flex-col items-center justify-center h-full animate-fade-in-up transition-all duration-700 min-h-[50vh]">
            {/* Overlapping floating cards */}
            <div className="flex items-center justify-center gap-1.5 md:gap-3 mb-10 select-none scale-90 sm:scale-100">
              <div className="w-18 h-22 sm:w-24 sm:h-28 rounded-2xl border border-white/10 shadow-2xl -rotate-[12deg] transform hover:rotate-0 hover:scale-110 hover:z-20 transition-all duration-300 overflow-hidden bg-white/[0.01] flex-shrink-0">
                <img
                  src="https://d3adwkbyhxyrtq.cloudfront.net/webassets/videomodels/sdxl-image.avif"
                  alt="Creative asset 1"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="w-18 h-22 sm:w-24 sm:h-28 rounded-2xl border border-white/10 shadow-2xl -rotate-[4deg] transform hover:rotate-0 hover:scale-110 hover:z-20 transition-all duration-300 overflow-hidden bg-white/[0.01] -ml-3 sm:-ml-4 flex-shrink-0">
                <img
                  src="https://d3adwkbyhxyrtq.cloudfront.net/webassets/videomodels/chroma-image.avif"
                  alt="Creative asset 2"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="w-18 h-18 sm:w-24 sm:h-24 rounded-full border border-white/10 shadow-2xl rotate-[6deg] transform hover:rotate-0 hover:scale-110 hover:z-20 transition-all duration-300 overflow-hidden bg-white/[0.01] -ml-3 sm:-ml-4 flex-shrink-0">
                <img
                  src="https://d3adwkbyhxyrtq.cloudfront.net/webassets/videomodels/neta-lumina.avif"
                  alt="Creative asset 3"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="w-18 h-22 sm:w-24 sm:h-28 rounded-2xl border border-white/10 shadow-2xl rotate-[12deg] transform hover:rotate-0 hover:scale-110 hover:z-20 transition-all duration-300 overflow-hidden bg-white/[0.01] -ml-3 sm:-ml-4 flex-shrink-0">
                <img
                  src="https://d3adwkbyhxyrtq.cloudfront.net/webassets/videomodels/perfect-pony-xl.avif"
                  alt="Creative asset 4"
                  className="w-full h-full object-cover"
                />
              </div>
            </div>

            <h1 className="text-2xl sm:text-4xl md:text-5xl font-extrabold tracking-tight mb-4 text-center px-4 flex flex-col items-center">
              <span className="text-white font-black uppercase text-xl sm:text-3xl tracking-wide mb-1 opacity-90">{copy.emptyState.heading}</span>
              <span className="text-[#22d3ee] font-black uppercase text-2xl sm:text-4xl sm:mt-1 tracking-tight">
                {selectedModelDisplayName}
              </span>
            </h1>
            <p className="text-white/40 text-xs sm:text-sm font-medium tracking-wide text-center max-w-lg leading-relaxed px-4">
              {copy.emptyState.subtitle}
            </p>
          </div>
        ) : null}
        {useAccountHistory && studioHistory.nextCursor && !studioHistory.error && (
          <button type="button" className="mx-auto my-4 block text-sm text-primary underline" disabled={isHistoryLoading} onClick={() => void studioHistory.loadMore()}>
            {locale === "zh" ? "加载更多" : "Load more"}
          </button>
        )}
      </div>

      {/* ── BOTTOM PROMPT BAR ── */}
      <PromptComposer>
          <div
            role={catalogStatus === "error" || catalogStatus === "empty" ? "alert" : "status"}
            aria-live="polite"
            className="flex flex-wrap items-center gap-2 text-xs text-amber-200"
            data-image-catalog-status={catalogStatus}
          >
            <span>
              {catalogStatus === "loading"
                ? (locale === "zh" ? "正在加载图片模型目录…" : "Loading image model catalog…")
                : catalogStatus === "empty"
                  ? (locale === "zh" ? "图片模型目录为空，暂无文生图模型。" : "The image model catalog is empty; no text-to-image models are available.")
                  : catalogStatus === "error"
                    ? (locale === "zh" ? "图片模型目录加载失败或所选模型不可用，暂不能生成。" : "The image catalog failed to load or the selected model is unavailable; generation is unavailable.")
                    : (locale === "zh" ? `已加载 ${catalogModels.length} 个文生图模型。` : `${catalogModels.length} text-to-image models loaded.`)}
            </span>
            {catalogStatusCode && <code>{catalogStatusCode}</code>}
            <button
              type="button"
              className="underline disabled:opacity-50"
              disabled={taskModelLoading || generating}
              onClick={() => setCatalogRetry((count) => count + 1)}
            >
              {locale === "zh" ? "重试加载图片模型" : "Retry image models"}
            </button>
            {catalogStatus === "empty" && (
              <span className="basis-full">
                {locale === "zh"
                  ? "若用于本地 Mock 测试且尚未开启 Mock，请在启动器显式设置 PAINTTRACK_LOCAL_MOCK_ROUTING=1 并完整重启启动器；生成还需开启 Worker。空目录不代表已确认 Mock 未开启，不会自动回退到 Mock。"
                  : "For local Mock testing, if Mock is not enabled, explicitly set PAINTTRACK_LOCAL_MOCK_ROUTING=1 in the launcher and fully restart it; generation also requires a Worker. An empty catalog does not confirm that Mock is disabled, and never triggers an automatic Mock fallback."}
              </span>
            )}
          </div>
          {/* Top row: upload picker + textarea */}
          <div className="flex flex-col gap-3">
            {/* Inline list of uploaded files */}
            <div className="flex items-center gap-2.5 flex-wrap">
              {uploadedImageUrls && uploadedImageUrls.length > 0 && uploadedImageUrls.map((url, idx) => (
                <div key={url} className={PROMPT_MEDIA_PREVIEW_CLASS}>
                  <img src={url} alt="" className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => {
                      const next = uploadedImageUrls.filter((_, i) => i !== idx);
                      setUploadedImageUrls(next);
                      if (next.length === 0) handleUploadClear();
                    }}
                    className="absolute top-0.5 right-0.5 w-4 h-4 bg-black/60 hover:bg-black rounded-full flex items-center justify-center text-white/85 hover:text-white text-[8px] border border-white/5"
                  >
                    ×
                  </button>
                </div>
              ))}
              
              {/* Main Upload Trigger */}
              {/* 参考图和图生图控件尚未接入任务服务，暂不显示。 */}
            </div>

            {/* Input prompt text area */}
            <PromptTextarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={placeholderText}
            />
          </div>

          {/* Bottom row: controls + generate */}
          <PromptFooter>
            {/* Left controls */}
            <PromptControls ref={dropdownRef}>
              {/* Model button */}
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDropdownOpen((o) => (o === "model" ? null : "model"));
                  }}
                  className={promptControlClassName({
                    active: dropdownOpen === "model",
                  })}
                >
                  <span className={PROMPT_CONTROL_LABEL_CLASS}>
                    {selectedModelDisplayName}
                  </span>
                  <PromptChevronIcon />
                </button>

                {dropdownOpen === "model" && (
                  <PromptPopover
                    onClick={(e) => e.stopPropagation()}
                    className="w-[calc(100vw-2rem)] md:w-[480px] max-w-md md:max-w-none max-h-[70vh]"
                  >
                    <PromptPopoverHeader>{copy.popovers.model}</PromptPopoverHeader>
                    <CatalogModelSelect
                      models={catalogModels}
                      selectedModelId={selectedModelId}
                      onSelect={handleModelSelect}
                      disabled={taskModelLoading}
                      copy={copy}
                    />
                  </PromptPopover>
                )}
              </div>


              {/* Aspect ratio button */}
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDropdownOpen((o) => (o === "ar" ? null : "ar"));
                  }}
                  className={promptControlClassName({
                    active: dropdownOpen === "ar",
                  })}
                >
                  <PromptAspectRatioIcon />
                  <span className={PROMPT_CONTROL_LABEL_CLASS}>
                    {selectedAr}
                  </span>
                </button>

                {dropdownOpen === "ar" && (
                  <PromptPopover
                    onClick={(e) => e.stopPropagation()}
                  >
                    <SimpleDropdown
                      title={copy.popovers.aspectRatio}
                      options={currentAspectRatios}
                      selected={selectedAr}
                      onSelect={(val) => setSelectedAr(val)}
                      onClose={() => setDropdownOpen(null)}
                    />
                  </PromptPopover>
                )}
              </div>

              {/* Quality/resolution button (represented as Diamond icon) */}
              {showQualityBtn && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDropdownOpen((o) => (o === "quality" ? null : "quality"));
                    }}
                    className={promptControlClassName({
                      active: dropdownOpen === "quality",
                    })}
                  >
                    <PromptQualityIcon />
                    <span className={PROMPT_CONTROL_LABEL_CLASS}>
                      {selectedQuality || currentResolutions[0]}
                    </span>
                  </button>

                  {dropdownOpen === "quality" && (
                    <PromptPopover
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SimpleDropdown
                        title={copy.popovers.resolution}
                        options={currentResolutions}
                        selected={selectedQuality}
                        onSelect={(val) => setSelectedQuality(val)}
                        onClose={() => setDropdownOpen(null)}
                      />
                    </PromptPopover>
                  )}
                </div>
              )}

              {/* Effect type button */}
              {showEffectBtn && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDropdownOpen((o) => (o === "effect" ? null : "effect"));
                    }}
                    className={promptControlClassName({
                      active: dropdownOpen === "effect",
                    })}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-40 text-white">
                      <path d="M5 3l14 9-14 9V3z" />
                    </svg>
                    <span className={`${PROMPT_CONTROL_LABEL_CLASS} max-w-[140px] truncate`}>
                      {selectedEffect || copy.promptBar.effectFallback}
                    </span>
                  </button>

                  {dropdownOpen === "effect" && (
                    <PromptPopover
                      onClick={(e) => e.stopPropagation()}
                      className="min-w-[200px]"
                    >
                      <SimpleDropdown
                        title={copy.popovers.effectType}
                        options={currentEffects}
                        selected={selectedEffect}
                        onSelect={(val) => setSelectedEffect(val)}
                        onClose={() => setDropdownOpen(null)}
                      />
                    </PromptPopover>
                  )}
                </div>
              )}

              {/* Draw button */}
              <button
                type="button"
                className={promptControlClassName()}
                onClick={() => setIsDrawModalOpen(true)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="opacity-40 text-white group-hover:text-[#22d3ee] transition-colors">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                <span className={PROMPT_CONTROL_LABEL_CLASS}>
                  {copy.promptBar.drawButton}
                </span>
              </button>
            </PromptControls>

            {/* Generate button */}
              <PromptAction
              onClick={handleGenerate}
              disabled={!canGenerate}
            >
              {generating ? (
                <>
                  <span className="animate-spin inline-block text-black">◌</span>
                  {copy.promptBar.generating}
                </>
              ) : (
                <>
                  <span>{copy.promptBar.generateButton}</span>
                </>
              )}
            </PromptAction>
          </PromptFooter>
      </PromptComposer>

      {/* ── FULLSCREEN IMAGE MODAL ── */}
      {fullscreenUrl && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-sm animate-fade-in"
          onClick={() => setFullscreenUrl(null)}
        >
          <button
            type="button"
            className="absolute top-6 right-6 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors border border-white/10"
            onClick={(e) => {
              e.stopPropagation();
              setFullscreenUrl(null);
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <img
            src={fullscreenUrl}
            alt={copy.fullscreen.previewAlt}
            className="max-w-[95vw] max-h-[95vh] rounded-2xl shadow-2xl object-contain animate-scale-up" 
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* ── DRAW CANVAS MODAL ── */}
      <DrawModal
        isOpen={isDrawModalOpen}
        onClose={() => setIsDrawModalOpen(false)}
        apiKey={apiKey}
        batchSize={1}
        onAddHistoryItem={addToHistory}
      />
      {/* ── DELETE CONFIRM ── */}
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={copy.gallery.deleteTitle}
        description={copy.gallery.deleteDescription}
        confirmLabel={copy.gallery.deleteAction}
        cancelLabel={copy.gallery.deleteCancel}
        busyLabel={copy.gallery.deleteBusy}
        busy={deleteBusy}
        error={deleteError}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />

      <Toaster position="top-right" containerStyle={{ zIndex: 99999 }} toastOptions={{ duration: 5000, style: { background: '#18181b', color: '#ffffff', border: '1px solid rgba(255,255,255,0.15)', fontSize: '13px', borderRadius: '12px', boxShadow: '0 10px 30px rgba(0,0,0,0.6)', maxWidth: '440px', wordBreak: 'break-word', whiteSpace: 'pre-wrap', padding: '12px 16px' } }} />
    </div>
  );
}
