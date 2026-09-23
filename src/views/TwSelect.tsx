import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface TwSelectOption { value: string; label: string }

export interface TwSelectProps {
  label: string;
  value: string;
  options: TwSelectOption[];
  onChange: (value: string) => void;
  /** 选中首项时仅显示字段名，与设计图筛选 chips 一致。 */
  hideDefaultValue?: boolean;
  ariaLabel?: string;
  /** 选中后是否使用蓝色高亮底纹；排序等中性控件传 false。 */
  accent?: boolean;
}

/* 设计图筛选 chip：字段名 + 当前值 + 折叠箭头；键盘可达并在关闭时把焦点还给触发器。 */
export function TwSelect({ label, value, options, onChange, hideDefaultValue = true, ariaLabel, accent = true }: TwSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];
  const showValue = selected && !(hideDefaultValue && selected.value === options[0]?.value);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, [open]);

  function commit(option: TwSelectOption) {
    onChange(option.value);
    setOpen(false);
  }

  return (
    <div className="tw-select" ref={wrapRef}>
      <button
        className={`tw-chip tw-select-trigger${showValue && accent ? " has-value" : ""}`}
        type="button"
        onClick={() => { setOpen((current) => !current); setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value))); }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel ?? `${label}筛选`}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); return; }
          if (!open) return;
          if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => Math.min(options.length - 1, index + 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(0, index - 1)); }
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); const option = options[activeIndex]; if (option) commit(option); }
        }}
      >
        {label && <span className="tw-chip-label">{label}</span>}
        {showValue && <span className="tw-chip-value">{selected.label}</span>}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="tw-select-list" role="listbox" id={listId} aria-label={label}>
          {options.map((option, index) => (
            <button
              className={`tw-select-option${option.value === value ? " active" : ""}${index === activeIndex ? " is-active" : ""}`}
              type="button"
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => commit(option)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
