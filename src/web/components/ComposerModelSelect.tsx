import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ModelInfo } from "../../shared/types";
import { CheckIcon, ChipIcon } from "./Icons";

export interface ComposerModelGroup {
  provider: string;
  models: ModelInfo[];
}

function modelKey(model: Pick<ModelInfo, "provider" | "id">): string {
  return `${model.provider}\u0000${model.id}`;
}

export function groupComposerModels(models: ModelInfo[]): ComposerModelGroup[] {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const group = groups.get(model.provider);
    if (group) group.push(model);
    else groups.set(model.provider, [model]);
  }
  return [...groups].map(([provider, groupedModels]) => ({ provider, models: groupedModels }));
}

export function ComposerModelSelect({ value, models, disabled, onChange }: {
  value: ModelInfo | null;
  models: ModelInfo[];
  disabled?: boolean;
  onChange: (provider: string, id: string) => void;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const currentKey = value ? modelKey(value) : "";
  const groups = useMemo(() => groupComposerModels(models), [models]);
  const options = useMemo(() => groups.flatMap((group) => group.models), [groups]);
  const optionIndexes = useMemo(
    () => new Map(options.map((model, index) => [modelKey(model), index])),
    [options],
  );
  const displayLabel = value?.name || value?.id || "未选择模型";

  const focusTrigger = () => requestAnimationFrame(() => triggerRef.current?.focus());
  const closeAndFocusTrigger = () => {
    setOpen(false);
    focusTrigger();
  };
  const choose = (model: ModelInfo | undefined) => {
    if (!model) return;
    setOpen(false);
    if (modelKey(model) !== currentKey) onChange(model.provider, model.id);
    focusTrigger();
  };
  const openMenu = () => {
    if (disabled || models.length === 0) return;
    setActiveIndex(Math.max(0, options.findIndex((model) => modelKey(model) === currentKey)));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", closeOutside);
    return () => window.removeEventListener("mousedown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex((index) => Math.min(index, Math.max(0, options.length - 1)));
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open]);

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
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
    if (options.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(options[activeIndex]);
    }
  };

  return <div className="compact-select composer-model-select" ref={rootRef} title="模型">
    <button
      ref={triggerRef}
      type="button"
      className="compact-select-trigger"
      disabled={disabled || models.length === 0}
      aria-label={`模型：${displayLabel}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? `${id}-listbox` : undefined}
      onClick={() => open ? setOpen(false) : openMenu()}
      onKeyDown={(event) => {
        if (!open && ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
          event.preventDefault();
          openMenu();
        }
      }}
    >
      <ChipIcon className="model-icon" />
      <span>{displayLabel}</span>
      <i className="compact-select-chevron" aria-hidden="true" />
    </button>
    {open && <div className="compact-select-popover composer-model-popover is-left">
      <div
        ref={listRef}
        id={`${id}-listbox`}
        className="composer-model-list"
        role="listbox"
        tabIndex={0}
        aria-label="模型"
        aria-activedescendant={options[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
        onKeyDown={handleListKeyDown}
      >
        {groups.map((group) => <div key={group.provider} className="composer-model-group" role="group" aria-label={group.provider}>
          <div className="composer-model-provider" data-provider={group.provider} aria-hidden="true">
            <span>{group.provider}</span>
            <b>{group.models.length}</b>
          </div>
          {group.models.map((model) => {
            const key = modelKey(model);
            const index = optionIndexes.get(key)!;
            const isSelected = key === currentKey;
            const isActive = index === activeIndex;
            return <div
              id={`${id}-option-${index}`}
              key={key}
              ref={(element) => { optionRefs.current[index] = element; }}
              data-compact-select-option-index={index}
              className={`compact-select-option composer-model-option${isSelected ? " is-selected" : ""}${isActive ? " is-active" : ""}`}
              role="option"
              aria-selected={isSelected}
              title={model.id}
              onMouseMove={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(model)}
            >
              <span className="composer-model-option-name">{model.name || model.id}</span>
              <span className="compact-select-check" aria-hidden="true">{isSelected && <CheckIcon />}</span>
            </div>;
          })}
        </div>)}
      </div>
    </div>}
  </div>;
}
