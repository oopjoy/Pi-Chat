import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { CheckIcon } from "./Icons";

export interface CompactSelectOption<T extends string> {
  value: T;
  label: string;
}

export function getCompactSelectNavigationIndex(key: string, currentIndex: number, optionCount: number): number | null {
  if (optionCount <= 0) return null;
  switch (key) {
    case "ArrowDown": return Math.min(Math.max(currentIndex, -1) + 1, optionCount - 1);
    case "ArrowUp": return currentIndex <= 0 ? 0 : currentIndex - 1;
    case "Home": return 0;
    case "End": return optionCount - 1;
    default: return null;
  }
}

export function findCompactSelectTypeaheadIndex(labels: string[], currentIndex: number, query: string): number | null {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery || labels.length === 0) return null;

  for (let offset = 1; offset <= labels.length; offset += 1) {
    const index = (Math.max(currentIndex, -1) + offset) % labels.length;
    if (labels[index]?.trim().toLocaleLowerCase().startsWith(normalizedQuery)) return index;
  }
  return null;
}

export function CompactSelect<T extends string>({ value, options, disabled, ariaLabel, title, align = "left", icon, className = "", onChange }: {
  value: T;
  options: Array<CompactSelectOption<T>>;
  disabled?: boolean;
  ariaLabel: string;
  title?: string;
  align?: "left" | "right";
  icon?: ReactNode;
  className?: string;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef({ value: "", time: 0 });
  const id = useId();
  const listboxId = `${id}-listbox`;
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex];
  const activeOptionId = open && options[activeIndex] ? `${id}-option-${activeIndex}` : undefined;

  const focusTrigger = () => requestAnimationFrame(() => triggerRef.current?.focus());
  const closeAndFocusTrigger = () => {
    setOpen(false);
    focusTrigger();
  };
  const chooseOption = (index: number) => {
    const option = options[index];
    if (!option) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
    focusTrigger();
  };
  const openListbox = () => {
    if (disabled || options.length === 0) return;
    setActiveIndex(selectedIndex);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
    typeaheadRef.current = { value: "", time: 0 };
    requestAnimationFrame(() => listboxRef.current?.focus());
  }, [open, selectedIndex, options.length]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", closeOutside);
    return () => window.removeEventListener("mousedown", closeOutside);
  }, [open]);

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      openListbox();
    }
  };

  const handleListboxKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const navigationIndex = getCompactSelectNavigationIndex(event.key, activeIndex, options.length);
    if (navigationIndex !== null) {
      event.preventDefault();
      setActiveIndex(navigationIndex);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseOption(activeIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndFocusTrigger();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;

    const now = Date.now();
    const previous = typeaheadRef.current;
    const nextValue = now - previous.time > 500 ? event.key : previous.value + event.key;
    const repeatedCharacter = [...nextValue].every((character) => character.toLocaleLowerCase() === event.key.toLocaleLowerCase());
    const query = repeatedCharacter ? event.key : nextValue;
    typeaheadRef.current = { value: nextValue, time: now };
    const match = findCompactSelectTypeaheadIndex(options.map((option) => option.label), activeIndex, query);
    if (match !== null) {
      event.preventDefault();
      setActiveIndex(match);
    }
  };

  return <div className={`compact-select ${className}`} ref={rootRef} title={title}>
    <button ref={triggerRef} type="button" className="compact-select-trigger" disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listboxId : undefined} onClick={() => open ? setOpen(false) : openListbox()} onKeyDown={handleTriggerKeyDown}>
      {icon}
      <span>{selected?.label || value}</span>
      <i className="compact-select-chevron" aria-hidden="true" />
    </button>
    {open && <div ref={listboxRef} id={listboxId} className={`compact-select-popover is-${align}`} role="listbox" tabIndex={0} aria-label={ariaLabel} aria-activedescendant={activeOptionId} onKeyDown={handleListboxKeyDown}>
      {options.map((option, index) => {
        const isSelected = option.value === value;
        const isActive = index === activeIndex;
        return <div id={`${id}-option-${index}`} key={option.value} className={`compact-select-option${isSelected ? " is-selected" : ""}${isActive ? " is-active" : ""}`} role="option" aria-selected={isSelected} onMouseMove={() => setActiveIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseOption(index)}>
          <span>{option.label}</span>{isSelected && <CheckIcon />}
        </div>;
      })}
    </div>}
  </div>;
}
