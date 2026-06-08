"use client";

import { EnterOutlined, InfoCircleOutlined } from "@ant-design/icons";
import type { KeyboardEvent } from "react";
import { useEffect, useRef } from "react";

export function ChoiceSubmitPanel({
  title,
  options,
  selectedIndex,
  onSelectedIndexChange,
  customValue,
  onCustomValueChange,
  onSubmit,
  onDismiss,
  submitLabel = "提交",
  disabled = false,
}: {
  title: string;
  options: string[];
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  customValue: string;
  onCustomValueChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onDismiss: () => void;
  submitLabel?: string;
  disabled?: boolean;
}) {
  const visibleOptions = options.slice(0, 3);
  const customIndex = visibleOptions.length;
  const normalizedIndex = Math.min(Math.max(selectedIndex, 0), customIndex);
  const selectedValue = normalizedIndex === customIndex ? customValue : (visibleOptions[normalizedIndex] ?? "");
  const canSubmit = Boolean(selectedValue.trim()) && !disabled;
  const customInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (normalizedIndex === customIndex) customInputRef.current?.focus();
  }, [customIndex, normalizedIndex]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled || visibleOptions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const rowCount = visibleOptions.length + 1;
      const nextIndex = (normalizedIndex + direction + rowCount) % rowCount;
      onSelectedIndexChange(nextIndex);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (canSubmit) onSubmit(selectedValue.trim());
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
    }
  }

  function selectCustomInput() {
    onSelectedIndexChange(customIndex);
    window.requestAnimationFrame(() => customInputRef.current?.focus());
  }

  return (
    <section
      className="choiceSubmitPanel"
      aria-label={title}
      onKeyDown={handleKeyDown}
    >
      <header className="choiceSubmitHeader">
        <strong>{title}</strong>
      </header>
      <div className="choiceOptionList" role="radiogroup" aria-label={title}>
        {visibleOptions.map((option, index) => {
          const selected = index === normalizedIndex;
          return (
            <button
              key={`${index}-${option}`}
              className={`choiceOptionRow ${selected ? "selected" : ""}`}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onSelectedIndexChange(index)}
            >
              <span className="choiceOptionIndex">{index + 1}.</span>
              <span className="choiceOptionText">{option}</span>
              <InfoCircleOutlined className="choiceOptionInfo" aria-hidden />
            </button>
          );
        })}
        <div
          className={`choiceOptionRow choiceCustomRow ${normalizedIndex === customIndex ? "selected" : ""}`}
          role="radio"
          aria-checked={normalizedIndex === customIndex}
          onClick={selectCustomInput}
        >
          <span className="choiceOptionIndex">{customIndex + 1}.</span>
          <input
            ref={customInputRef}
            value={customValue}
            disabled={disabled}
            placeholder="输入自定义内容"
            onFocus={() => onSelectedIndexChange(customIndex)}
            onChange={(event) => onCustomValueChange(event.target.value)}
          />
          <InfoCircleOutlined className="choiceOptionInfo" aria-hidden />
        </div>
      </div>
      <footer className="choiceSubmitFooter">
        <button className="choiceDismissButton" type="button" disabled={disabled} onClick={onDismiss}>
          <span>忽略</span>
          <kbd>ESC</kbd>
        </button>
        <button
          className="choiceSubmitButton"
          type="button"
          disabled={!canSubmit}
          onClick={() => onSubmit(selectedValue.trim())}
        >
          <span>{submitLabel}</span>
          <EnterOutlined aria-hidden />
        </button>
      </footer>
    </section>
  );
}
