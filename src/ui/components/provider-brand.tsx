import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { PROVIDER_LABELS, type ProviderId } from "../../domain/types";

const PROVIDER_IDS = Object.keys(PROVIDER_LABELS) as ProviderId[];
const KIMI_ICON_URL = browser.runtime.getURL("/icon-128.png");
const CHATGPT_ICON_PATH = "M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z";
const DEEPSEEK_ICON_PATH = "M27.501 8.46875c-.252-.123-.36.111-.508.23-.05.04-.092.09-.135.135-.368.395-.798.653-1.358.622-.821-.045-1.521.212-2.141.842-.132-.776-.57-1.239-1.235-1.535-.349-.154-.702-.309-.944-.645-.171-.239-.217-.505-.303-.767-.054-.158-.108-.32-.29-.348-.198-.031-.275.135-.352.273-.31.566-.43 1.191-.419 1.824.027 1.422.628 2.555 1.819 3.362.136.091.171.185.128.32-.081.277-.178.547-.264.824-.054.178-.135.217-.324.139-.655-.274-1.221-.678-1.72-1.168-.848-.821-1.615-1.727-2.571-2.436a15.9 15.9 0 0 0-.681-.467c-.976-.949.128-1.728.383-1.819.267-.096.093-.428-.77-.424-.862.004-1.652.293-2.658.678-.147.058-.302.1-.461.135-.913-.172-1.862-.211-2.853-.1-1.865.209-3.355 1.092-4.45 2.6-1.316 1.81-1.625 3.869-1.246 6.017.399 2.262 1.552 4.137 3.325 5.602 1.84 1.516 3.957 2.26 6.372 2.118 1.467-.084 3.101-.281 4.943-1.842.465.231.952.322 1.762.393.623.057 1.222-.032 1.687-.128.727-.154.677-.827.414-.953-2.133-.994-1.666-.59-2.092-.916 1.083-1.285 2.717-2.618 3.356-6.938.05-.344.008-.559 0-.839-.004-.168.034-.234.227-.254.534-.06 1.053-.207 1.529-.47 1.383-.756 1.94-1.996 2.068-3.484.019-.226-.005-.463-.244-.582ZM15.46 21.861c-2.068-1.627-3.07-2.162-3.484-2.139-.388.022-.318.465-.232.754.089.285.205.482.368.732.112.166.19.414-.112.598-.666.413-1.823-.139-1.878-.166-.794-.299-1.92-1.348-2.714-2.781-.766-1.381-1.211-2.862-1.285-4.441-.02-.383.093-.518.472-.586.499-.092 1.014-.112 1.513-.04 2.11.309 3.905 1.254 5.41 2.748.86.854 1.51 1.872 2.18 2.866.712 1.056 1.38 2.062 2.355 2.886.344.289.62.51.882.672-.793.087-2.117.107-3.475-.103Zm.99-6.381c0-.17.136-.305.307-.305.038 0 .073.008.104.02.042.015.081.039.111.074.055.052.086.13.086.21 0 .17-.136.305-.306.305-.171 0-.302-.135-.302-.305Zm3.077 1.582c-.197.08-.395.15-.584.158-.294.014-.615-.105-.79-.252-.271-.227-.464-.354-.546-.752-.035-.17-.015-.432.015-.583.07-.324-.008-.531-.235-.721-.187-.155-.423-.196-.683-.196-.097 0-.186-.043-.252-.078-.109-.055-.198-.189-.113-.355.028-.053.16-.184.191-.207.351-.201.758-.135 1.134.015.348.142.611.404.99.773.387.447.456.572.677.906.173.264.333.533.441.842.065.191-.02.349-.248.447Z";

export function ProviderIcon({ providerId }: { providerId: ProviderId }) {
  return <span className={`provider-icon provider-icon-${providerId}`} aria-hidden="true">
    {providerId === "kimi-web" ? <img className="provider-kimi-mark" src={KIMI_ICON_URL} alt="" /> : <svg viewBox={providerId === "chatgpt-web" ? "130 200 318 318" : "0 0 24 24"} focusable="false">
      {providerId === "chatgpt-web" && <>
        <path d={CHATGPT_ICON_PATH} fill="currentColor" fillRule="nonzero" />
      </>}
      {providerId === "gemini-web" && <path d="M12 1.8 14.5 9.5 22.2 12l-7.7 2.5L12 22.2l-2.5-7.7L1.8 12l7.7-2.5L12 1.8Z" fill="currentColor" />}
      {providerId === "deepseek-web" && <path d={DEEPSEEK_ICON_PATH} transform="scale(0.8)" fill="currentColor" fillRule="nonzero" />}
      {providerId === "openai-compatible" && <>
        <rect x="3.1" y="3.1" width="17.8" height="17.8" rx="5" fill="currentColor" />
        <path d="M8 9.1h8M8 12h5.5M8 14.9h8" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
      </>}
    </svg>}
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
