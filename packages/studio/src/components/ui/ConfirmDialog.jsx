"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Shared in-app confirmation primitive for the studio package.
//
// Why this exists: `window.confirm()` renders browser chrome ("127.0.0.1:3000
// says", OK/Cancel in the *browser* locale), ignores the app's dark glass
// styling, blocks the main thread, and gives no way to show an in-flight or
// failed state. Every studio used it, so every studio looked broken.
//
// Contract:
// - `open` drives presence; the panel stays mounted for one exit transition,
//   so callers just toggle a boolean.
// - `busy` locks the dialog while the async action runs (no Esc, no backdrop
//   click, no double submit) and swaps both labels for their busy variants.
// - `error` renders inline, so a failed action can be retried without losing
//   the context the native dialog would have thrown away.
// - Focus moves to Cancel on open (safe default for a destructive action) and
//   is restored to the trigger element on close.
// - Respects `prefers-reduced-motion`: all motion collapses to zero duration.

// Motion budget. Enter is slower than exit on purpose — the panel should feel
// like it settles into place, then leave promptly when dismissed.
const BACKDROP_ENTER_MS = 200;
const BACKDROP_EXIT_MS = 150;
const PANEL_ENTER_MS = 260;
const PANEL_EXIT_MS = 180;
const EXIT_MS = PANEL_EXIT_MS;

// ease-out-expo: fast start, very soft landing — the tail is what stops a
// scale/translate transition from looking mechanical.
const EASE_ENTER = "cubic-bezier(0.16, 1, 0.3, 1)";
const EASE_EXIT = "cubic-bezier(0.4, 0, 1, 1)";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (event) => setReduced(event.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  return reduced;
}

function DangerIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4.5A1.5 1.5 0 019.5 3h5A1.5 1.5 0 0116 4.5V6" />
      <path d="M19 6l-1 13.2A1.8 1.8 0 0116.2 21H7.8A1.8 1.8 0 016 19.2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className="animate-spin"
      aria-hidden="true"
    >
      <path d="M12 3a9 9 0 019 9" />
    </svg>
  );
}

export default function ConfirmDialog({
  open = false,
  title,
  description,
  confirmLabel,
  cancelLabel,
  busyLabel,
  cancelBusyLabel,
  busy = false,
  error = null,
  tone = "danger",
  onConfirm,
  onCancel,
  closeOnBackdrop = true,
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef(null);
  const cancelRef = useRef(null);
  const restoreRef = useRef(null);
  const [host, setHost] = useState(null);
  const [present, setPresent] = useState(Boolean(open));
  const [entered, setEntered] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  const isDanger = tone === "danger";
  const active = present && open;

  // Portals need a document; resolve it after mount so the component stays
  // safe to import from a server-rendered tree.
  useEffect(() => {
    setHost(document.body);
  }, []);

  // Mount one frame before entering (so the transition has a start value),
  // and keep the panel mounted for one exit transition before unmounting.
  //
  // Double rAF on purpose: a single rAF can run in the same paint pass as the
  // mount, which means the browser never draws the closed state and the
  // dialog "pops" in with no transition at all. The first rAF guarantees a
  // painted closed frame, the second flips to the open state.
  useEffect(() => {
    if (open) {
      setPresent(true);
      let innerFrame = 0;
      const outerFrame = requestAnimationFrame(() => {
        innerFrame = requestAnimationFrame(() => setEntered(true));
      });
      return () => {
        cancelAnimationFrame(outerFrame);
        cancelAnimationFrame(innerFrame);
      };
    }
    setEntered(false);
    const timer = setTimeout(() => setPresent(false), reducedMotion ? 0 : EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, reducedMotion]);

  // Scroll lock (with scrollbar compensation so the page behind doesn't jump)
  // + focus handoff while the dialog is actually open.
  useEffect(() => {
    if (!active) return undefined;

    restoreRef.current = document.activeElement;

    const { body } = document;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      const basePadding = parseFloat(window.getComputedStyle(body).paddingRight) || 0;
      body.style.paddingRight = `${basePadding + scrollbarWidth}px`;
    }

    const focusTimer = setTimeout(() => {
      const target = cancelRef.current || panelRef.current;
      target?.focus?.();
    }, 0);

    return () => {
      clearTimeout(focusTimer);
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
      const previous = restoreRef.current;
      if (previous && typeof previous.focus === "function") previous.focus();
    };
  }, [active]);

  useEffect(() => {
    if (!active) return undefined;

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!busy) onCancel?.();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusables = Array.from(
        panel.querySelectorAll(FOCUSABLE_SELECTOR),
      ).filter((node) => node.getClientRects().length > 0);

      if (focusables.length === 0) {
        // busy disables both buttons; keep Tab from leaking into the page.
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      const outside = !panel.contains(current);

      if (event.shiftKey && (current === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [active, busy, onCancel]);

  if (!present || !host) return null;

  const requestCancel = () => {
    if (busy) return;
    onCancel?.();
  };

  // Staggered reveal: the panel lands first, then its content eases up. Only
  // on enter — on exit everything leaves together, otherwise closing feels
  // hesitant.
  const step = (delayMs) => ({
    opacity: entered ? 1 : 0,
    transform: entered ? "translate3d(0, 0, 0)" : "translate3d(0, 6px, 0)",
    transitionProperty: "opacity, transform",
    transitionDuration: reducedMotion ? "0ms" : entered ? "220ms" : "120ms",
    transitionTimingFunction: entered ? EASE_ENTER : EASE_EXIT,
    transitionDelay: reducedMotion || !entered ? "0ms" : `${delayMs}ms`,
  });

  return createPortal(
    <div className="fixed inset-0 z-[1000]">
      <div
        aria-hidden="true"
        onClick={closeOnBackdrop ? requestCancel : undefined}
        className="absolute inset-0 bg-black/70 backdrop-blur-[3px]"
        style={{
          opacity: entered ? 1 : 0,
          transitionProperty: "opacity",
          transitionDuration: reducedMotion
            ? "0ms"
            : entered
              ? `${BACKDROP_ENTER_MS}ms`
              : `${BACKDROP_EXIT_MS}ms`,
          transitionTimingFunction: entered ? "cubic-bezier(0.2, 0, 0, 1)" : EASE_EXIT,
          // Hold the scrim a touch longer than the panel on the way out so the
          // page behind doesn't flash between the two mid-animations.
          transitionDelay: reducedMotion || entered ? "0ms" : "30ms",
        }}
      />

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
        <div
          ref={panelRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          aria-busy={busy || undefined}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          className="pointer-events-auto w-full max-w-[420px] rounded-2xl border border-white/10 bg-[#0a0a0a] p-5 shadow-[0_28px_90px_-20px_rgba(0,0,0,0.95)] outline-none"
          style={{
            opacity: entered ? 1 : 0,
            transform: entered
              ? "translate3d(0, 0, 0) scale(1)"
              : "translate3d(0, 12px, 0) scale(0.96)",
            transformOrigin: "center",
            transitionProperty: "opacity, transform",
            transitionDuration: reducedMotion
              ? "0ms"
              : entered
                ? `${PANEL_ENTER_MS}ms`
                : `${PANEL_EXIT_MS}ms`,
            transitionTimingFunction: entered ? EASE_ENTER : EASE_EXIT,
            willChange: "opacity, transform",
          }}
        >
          <div className="flex items-start gap-3" style={step(40)}>
            <span
              className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${
                isDanger
                  ? "border-red-500/25 bg-red-500/10 text-red-400"
                  : "border-white/10 bg-white/[0.06] text-white/80"
              }`}
            >
              <DangerIcon />
            </span>
            <div className="min-w-0 flex-1">
              <h2
                id={titleId}
                className="text-[15px] font-semibold leading-6 text-white"
              >
                {title}
              </h2>
              {description ? (
                <p
                  id={descriptionId}
                  className="mt-1.5 text-[13px] leading-relaxed text-white/55"
                >
                  {description}
                </p>
              ) : null}
            </div>
          </div>

          {error ? (
            <div
              role="alert"
              className="mt-4 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12.5px] leading-relaxed text-red-200"
              style={{
                opacity: entered ? 1 : 0,
                transitionProperty: "opacity",
                transitionDuration: reducedMotion ? "0ms" : "160ms",
              }}
            >
              {error}
            </div>
          ) : null}

          <div
            className="mt-6 flex items-center justify-end gap-2"
            style={step(90)}
          >
            <button
              ref={cancelRef}
              type="button"
              onClick={requestCancel}
              disabled={busy}
              className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-[13px] font-semibold text-white/80 transition-colors hover:bg-white/[0.09] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 disabled:cursor-not-allowed disabled:opacity-40 md:text-[12.5px]"
            >
              {busy ? (cancelBusyLabel || cancelLabel) : cancelLabel}
            </button>
            <button
              type="button"
              onClick={() => {
                if (busy) return;
                onConfirm?.();
              }}
              disabled={busy}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-[13px] font-semibold text-white transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-70 md:text-[12.5px] ${
                isDanger
                  ? "bg-red-500 hover:bg-red-400 focus-visible:ring-red-300/60"
                  : "bg-[#22d3ee] text-black hover:bg-[#22d3ee]/85 focus-visible:ring-[#22d3ee]/50"
              }`}
            >
              {busy ? <Spinner /> : null}
              {busy ? busyLabel : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    host,
  );
}
