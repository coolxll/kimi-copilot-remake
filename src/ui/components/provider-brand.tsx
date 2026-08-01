import { useEffect, useRef, useState } from "react";
import { PROVIDER_LABELS, type ProviderId } from "../../domain/types";

const PROVIDER_IDS = Object.keys(PROVIDER_LABELS) as ProviderId[];

export function ProviderIcon({ providerId }: { providerId: ProviderId }) {
  return <span className={`provider-icon provider-icon-${providerId}`} aria-hidden="true">
    <svg viewBox="0 0 24 24" focusable="false">
      {providerId === "kimi-web" && <>
        <path d="M12 1.8 20.6 6.7v10.6L12 22.2l-8.6-4.9V6.7L12 1.8Z" fill="currentColor" />
        <path d="m8 7.4 3.2 4.6L8 16.6h2.8l2.1-3.1 2.2 3.1H18l-3.6-5 3.4-4.2h-2.8l-1.9 2.6-1.8-2.6H8Z" fill="white" />
      </>}
      {providerId === "chatgpt-web" && <>
        <path d="M12 3.2a3.1 3.1 0 0 1 2.7 1.6l.5.9 1-.1a3.1 3.1 0 0 1 3.1 1.8 3.1 3.1 0 0 1-.2 3.1l-.6.9.5.9a3.1 3.1 0 0 1-.1 3.6 3.1 3.1 0 0 1-3.2 1.3l-1-.2-.5.9a3.1 3.1 0 0 1-2.8 1.6 3.1 3.1 0 0 1-2.7-1.6l-.5-.9-1 .1a3.1 3.1 0 0 1-3.1-1.8 3.1 3.1 0 0 1 .2-3.1l.6-.9-.5-.9a3.1 3.1 0 0 1 .1-3.6 3.1 3.1 0 0 1 3.2-1.3l1 .2.5-.9A3.1 3.1 0 0 1 12 3.2Z" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path d="m8.2 8.2 7.6 4.4m0-4.4-7.6 4.4m3.8-7v8.8" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </>}
      {providerId === "gemini-web" && <path d="M12 1.8 14.5 9.5 22.2 12l-7.7 2.5L12 22.2l-2.5-7.7L1.8 12l7.7-2.5L12 1.8Z" fill="currentColor" />}
      {providerId === "deepseek-web" && <>
        <path d="M4.2 5.2h7.2c5.1 0 8.4 2.4 8.4 6.8s-3.3 6.8-8.4 6.8H4.2V5.2Z" fill="currentColor" />
        <path d="M8 8.4v7.2h3.1c2.8 0 4.4-1.1 4.4-3.6s-1.6-3.6-4.4-3.6H8Z" fill="white" />
      </>}
      {providerId === "openai-compatible" && <>
        <rect x="3.1" y="3.1" width="17.8" height="17.8" rx="5" fill="currentColor" />
        <path d="M8 9.1h8M8 12h5.5M8 14.9h8" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
      </>}
    </svg>
  </span>;
}

export function ProviderBadge({ providerId }: { providerId: ProviderId }) {
  return <span className="provider-badge">
    <ProviderIcon providerId={providerId} />
    <span>{PROVIDER_LABELS[providerId]}</span>
  </span>;
}

export function ProviderPicker({ id, value, onChange, ariaLabel }: {
  id?: string;
  value: ProviderId;
  onChange: (providerId: ProviderId) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const selectProvider = (providerId: ProviderId) => {
    onChange(providerId);
    setOpen(false);
  };

  return <div className="provider-picker" ref={rootRef}>
    <button
      id={id}
      className="provider-picker-trigger"
      type="button"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
    >
      <ProviderIcon providerId={value} />
      <span>{PROVIDER_LABELS[value]}</span>
      <span className="provider-picker-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div className="provider-picker-menu" role="listbox" aria-label={ariaLabel}>
      {PROVIDER_IDS.map((providerId) => <button
        className="provider-picker-option"
        type="button"
        role="option"
        aria-selected={providerId === value}
        key={providerId}
        onClick={() => selectProvider(providerId)}
      >
        <ProviderIcon providerId={providerId} />
        <span>{PROVIDER_LABELS[providerId]}</span>
        {providerId === value && <span className="provider-picker-check" aria-hidden="true">✓</span>}
      </button>)}
    </div>}
  </div>;
}
