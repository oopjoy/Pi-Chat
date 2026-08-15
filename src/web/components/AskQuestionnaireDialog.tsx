import { useEffect, useMemo, useRef, useState } from "react";
import type { ExtensionUiRequest } from "../../shared/types";
import {
  askAnswerComplete,
  askSubmissionStep,
  type AskQuestionAnswer,
  type AskQuestionnairePlan,
  type AskSubmissionCursor,
} from "../lib/ask-questionnaire";
import { ExtensionDialogFrame } from "./ExtensionDialog";

export function AskQuestionnaireDialog({
  plan,
  request,
  visible = true,
  disabled = false,
  onRespond,
  onFallback,
}: {
  plan: AskQuestionnairePlan;
  request: ExtensionUiRequest | null;
  visible?: boolean;
  disabled?: boolean;
  onRespond: (body: {
    id?: string;
    cancelled?: boolean;
    confirmed?: boolean;
    value?: string;
  }) => boolean | void | Promise<boolean | void>;
  onFallback: () => void;
}) {
  const [answers, setAnswers] = useState<Array<AskQuestionAnswer | null>>(
    () => plan.questions.map(() => null),
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [hoveredOption, setHoveredOption] = useState<number | "custom" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cursor, setCursor] = useState<AskSubmissionCursor | null>(null);
  const [submitError, setSubmitError] = useState("");
  const submittedRequestIdsRef = useRef(new Set<string>());
  const progressRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setAnswers(plan.questions.map(() => null));
    setActiveIndex(0);
    setHoveredOption(null);
    setSubmitting(false);
    setCursor(null);
    setSubmitError("");
    submittedRequestIdsRef.current.clear();
  }, [plan.toolCallId]);

  useEffect(() => {
    if (!submitting || !cursor || !request) return;
    if (submittedRequestIdsRef.current.has(request.id)) return;
    const step = askSubmissionStep(plan, answers, cursor, request);
    if (!step) {
      setSubmitting(false);
      setSubmitError("问卷格式已变化，正在切换到 Pi 的标准输入对话框。");
      onFallback();
      return;
    }
    const previousCursor = cursor;
    submittedRequestIdsRef.current.add(request.id);
    setCursor(step.next);
    void Promise.resolve(onRespond(step.body)).then((accepted) => {
      if (accepted !== false) return;
      submittedRequestIdsRef.current.delete(request.id);
      setSubmitting(false);
      setCursor(previousCursor);
      setActiveIndex(previousCursor.questionIndex);
      setSubmitError("回答未成功提交，请检查当前问题后重试。");
    }).catch(() => {
      submittedRequestIdsRef.current.delete(request.id);
      setSubmitting(false);
      setCursor(previousCursor);
      setActiveIndex(previousCursor.questionIndex);
      setSubmitError("回答未成功提交，请检查当前问题后重试。");
    });
  }, [answers, cursor, onFallback, onRespond, plan, request, submitting]);


  useEffect(() => {
    if (visible && !submitting) progressRef.current?.focus();
  }, [activeIndex, submitting, visible]);

  const question = plan.questions[activeIndex];
  const answer = answers[activeIndex];
  const lastQuestion = activeIndex === plan.questions.length - 1;
  const currentComplete = askAnswerComplete(answer);
  const allComplete = answers.every(askAnswerComplete);
  const customOptionNumber = question.options.length + 1;
  const selectedPreview = useMemo(() => {
    if (hoveredOption === "custom") return null;
    if (typeof hoveredOption === "number")
      return question.options[hoveredOption]?.preview || null;
    if (answer?.kind === "options")
      return question.options[answer.selected[0]]?.preview || null;
    return null;
  }, [answer, hoveredOption, question.options]);

  const updateAnswer = (next: AskQuestionAnswer) => {
    setSubmitError("");
    setAnswers((current) => current.map((item, index) =>
      index === activeIndex ? next : item,
    ));
  };
  const selectSingle = (index: number) => {
    updateAnswer({ kind: "options", selected: [index] });
    if (!lastQuestion) setActiveIndex(activeIndex + 1);
  };
  const toggleMulti = (index: number) => {
    const selected = answer?.kind === "options" ? answer.selected : [];
    updateAnswer({
      kind: "options",
      selected: selected.includes(index)
        ? selected.filter((item) => item !== index)
        : [...selected, index].sort((a, b) => a - b),
    });
  };
  const chooseCustom = () => updateAnswer({
    kind: "custom",
    value: answer?.kind === "custom" ? answer.value : "",
  });
  const advanceCustom = () => {
    if (answer?.kind !== "custom" || !askAnswerComplete(answer)) return;
    if (!lastQuestion) setActiveIndex(activeIndex + 1);
  };
  const cancel = () => {
    if (disabled || submitting || !request) return;
    setSubmitting(true);
    setSubmitError("");
    void Promise.resolve(onRespond({ id: request.id, cancelled: true }))
      .then((accepted) => {
        if (accepted !== false) return;
        setSubmitting(false);
        setSubmitError("取消未成功发送，请重试。");
      })
      .catch(() => {
        setSubmitting(false);
        setSubmitError("取消未成功发送，请重试。");
      });
  };
  const submit = () => {
    if (disabled || submitting || !allComplete) return;
    setSubmitError("");
    setSubmitting(true);
    setCursor({ questionIndex: 0, phase: "question" });
  };

  useEffect(() => {
    if (!visible || disabled || submitting || !request) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled, onRespond, request, submitting, visible]);

  if (!visible) return null;

  return (
    <ExtensionDialogFrame
      gate={false}
      title={submitting ? "正在提交问卷" : question.question}
      actions={submitting
        ? <span className="extension-dialog-continuation-status" role="status">正在提交全部回答…</span>
        : (
          <>
            <button type="button" disabled={disabled || !request} onClick={cancel}>取消</button>
            <button
              type="button"
              disabled={disabled || activeIndex === 0}
              onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}
            >上一个</button>
            {!lastQuestion ? (
              <button
                type="button"
                className="primary"
                disabled={disabled || !currentComplete}
                onClick={() => setActiveIndex((index) => Math.min(plan.questions.length - 1, index + 1))}
              >下一个</button>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={disabled || !allComplete}
                onClick={submit}
              >提交</button>
            )}
          </>
        )}
    >
      {submitting ? (
        <div className="extension-dialog-continuation" aria-live="polite">
          <span aria-hidden="true" />
          <p>Pi Chat 正在通过现有 RPC 请求提交你的完整问卷回答。</p>
        </div>
      ) : (
        <div className="ask-questionnaire">
          <div ref={progressRef} className="ask-questionnaire-progress" tabIndex={-1} aria-live="polite">
            <span>{question.header}</span>
            <strong>问题 {activeIndex + 1} / {plan.questions.length}</strong>
          </div>
          <div className="ask-questionnaire-options" role="group" aria-labelledby="extension-dialog-title">
            {question.options.map((option, index) => {
              const selected = answer?.kind === "options" && answer.selected.includes(index);
              return (
                <button
                  type="button"
                  key={`${index}:${option.label}`}
                  className={`ask-questionnaire-option${selected ? " is-selected" : ""}`}
                  aria-pressed={selected}
                  disabled={disabled}
                  onMouseEnter={() => setHoveredOption(index)}
                  onMouseLeave={() => setHoveredOption(null)}
                  onFocus={() => setHoveredOption(index)}
                  onBlur={() => setHoveredOption(null)}
                  onClick={() => question.multiSelect ? toggleMulti(index) : selectSingle(index)}
                >
                  <span className="ask-questionnaire-option-marker">{question.multiSelect ? (selected ? "✓" : "") : index + 1}</span>
                  <span className="ask-questionnaire-option-copy">
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </button>
              );
            })}
            <div
              className={`ask-questionnaire-custom${answer?.kind === "custom" ? " is-selected" : ""}`}
              onMouseEnter={() => setHoveredOption("custom")}
              onMouseLeave={() => setHoveredOption(null)}
            >
              {answer?.kind === "custom" ? (
                <>
                  <span className="ask-questionnaire-option-marker">{customOptionNumber}</span>
                  <input
                    autoFocus
                    aria-label={`${customOptionNumber}. ${question.header} 自由输入`}
                    value={answer.value}
                    disabled={disabled}
                    onFocus={() => setHoveredOption("custom")}
                    onBlur={() => setHoveredOption(null)}
                    onChange={(event) => updateAnswer({ kind: "custom", value: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      advanceCustom();
                    }}
                  />
                </>
              ) : (
                <button
                  type="button"
                  className="ask-questionnaire-custom-trigger"
                  aria-pressed="false"
                  disabled={disabled}
                  onFocus={() => setHoveredOption("custom")}
                  onBlur={() => setHoveredOption(null)}
                  onClick={chooseCustom}
                >
                  <span className="ask-questionnaire-option-marker">{customOptionNumber}</span>
                  <span>输入你的答案</span>
                </button>
              )}
            </div>
          </div>
          {selectedPreview && <pre className="ask-questionnaire-preview">{selectedPreview}</pre>}
          {submitError && <p className="ask-questionnaire-error" role="alert">{submitError}</p>}
        </div>
      )}
    </ExtensionDialogFrame>
  );
}
