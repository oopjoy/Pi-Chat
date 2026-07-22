import { useEffect, useMemo, useRef, useState } from "react";
import type { BootstrapData, CustomModelInput, ExtensionResource, ModelInfo, PackageResource, PiState, SkillResource } from "../../shared/types";
import { api } from "../api";
import { DEFAULT_APPEARANCE, snapToStep, type AppearancePreferences, type FontPreference, type ThemePreference } from "../lib/preferences";
import { CompactSelect, type CompactSelectOption } from "./CompactSelect";
import { CloseIcon, MinusIcon, PlusIcon } from "./Icons";

export type ManagementSection = "settings" | "models";
type SettingsTab = "appearance" | "models" | "skills" | "extensions" | "packages";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "appearance", label: "外观" },
  { id: "models", label: "Models" },
  { id: "skills", label: "Skills" },
  { id: "extensions", label: "Extensions" },
  { id: "packages", label: "Packages" },
];

const THEME_OPTIONS: Array<CompactSelectOption<ThemePreference>> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const FONT_OPTIONS: Array<CompactSelectOption<FontPreference>> = [
  { value: "system", label: "系统字体" },
  { value: "serif", label: "衬线阅读字体" },
  { value: "mono", label: "等宽字体" },
];

export function ManagementPanel({ section, appearance, models, state, busy, onClose, onAppearance, onModel, onReloaded, onShutdown }: {
  section: ManagementSection | null;
  appearance: AppearancePreferences;
  models: ModelInfo[];
  state: PiState;
  busy: boolean;
  onClose: () => void;
  onAppearance: (value: AppearancePreferences) => void;
  onModel: (provider: string, id: string) => void;
  onReloaded: (data?: BootstrapData) => void;
  onShutdown: () => void;
}) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  const [filter, setFilter] = useState("");
  const [skills, setSkills] = useState<SkillResource[]>([]);
  const [extensions, setExtensions] = useState<ExtensionResource[]>([]);
  const [packages, setPackages] = useState<PackageResource[]>([]);
  const [resourceBusy, setResourceBusy] = useState(false);
  const [resourceError, setResourceError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSettingsTab(section === "models" ? "models" : "appearance");
    setFilter("");
    setResourceError("");
  }, [section]);

  useEffect(() => {
    if (!section) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [section, onClose]);

  useEffect(() => {
    setResourceError("");
    if (!section || !["skills", "extensions", "packages"].includes(settingsTab)) return;
    setLoading(true);
    const load = settingsTab === "skills" ? api.skills() : settingsTab === "extensions" ? api.extensions() : api.packages();
    load.then((result) => {
      if (settingsTab === "skills") setSkills(result.resources as SkillResource[]);
      else if (settingsTab === "extensions") setExtensions(result.resources as ExtensionResource[]);
      else setPackages(result.resources as PackageResource[]);
    }).catch((error) => setResourceError(error instanceof Error ? error.message : String(error))).finally(() => setLoading(false));
  }, [section, settingsTab]);
  if (!section) return null;

  const runResource = async <T extends SkillResource | ExtensionResource | PackageResource>(operation: () => Promise<{ resources: T[] }>, apply: (items: T[]) => void) => {
    setResourceBusy(true);
    setResourceError("");
    try {
      const result = await operation();
      apply(result.resources);
      onReloaded();
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setResourceBusy(false);
    }
  };

  const applySkills = (items: SkillResource[]) => setSkills(items);
  const applyExtensions = (items: ExtensionResource[]) => setExtensions(items);
  const applyPackages = (items: PackageResource[]) => setPackages(items);

  return (
    <div className="panel-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="management-panel panel-settings" role="dialog" aria-modal="true" aria-labelledby="management-title">
        <header className="management-head">
          <div>
            <span className="management-kicker">Pi Chat</span>
            <h2 id="management-title">设置</h2>
          </div>
          <button type="button" className="panel-close" onClick={onClose} aria-label="关闭"><CloseIcon /></button>
        </header>

        {(
          <div className="settings-workspace">
            <nav className="settings-nav" aria-label="设置分类">
              <div className="settings-nav-tabs">
                {SETTINGS_TABS.map((tab) => (
                  <button type="button" key={tab.id} className={settingsTab === tab.id ? "is-active" : ""} onClick={() => setSettingsTab(tab.id)}>
                    {tab.label}
                  </button>
                ))}
              </div>
              <button type="button" className="settings-shutdown" disabled={busy} onClick={onShutdown} title="检查全部对话后，关闭所有 Pi Chat 窗口、服务和会话进程">关闭 Pi Chat</button>
            </nav>
            <div className="settings-content">
              {settingsTab === "appearance" && <AppearancePanel value={appearance} onChange={onAppearance} />}
              {settingsTab === "models" && <ModelsPanel models={models} state={state} busy={busy} filter={filter} onFilter={setFilter} onModel={onModel} onReloaded={onReloaded} />}
              {settingsTab === "skills" && <SettingsResourceList
                title="Skills" description="面向模型的 Markdown 工作流与说明。包内 Skill 在这里按资源显示一次。" loading={loading} error={resourceError} resources={skills} busy={resourceBusy}
                pathFor={(item) => item.packageSource ? `${item.pathLabel} · 来自 ${item.packageSource}` : item.pathLabel}
                onToggle={(item) => void runResource(() => api.toggleSkill(item.id, !item.enabled), applySkills)}
              />}
              {settingsTab === "extensions" && <SettingsResourceList
                title="Extensions" description="可执行的 Pi 工具、命令与事件扩展。包内扩展由所属 Package 统一管理。" loading={loading} error={resourceError} resources={extensions} busy={resourceBusy}
                pathFor={(item) => item.packageSource ? `${item.source} · 由 Package 管理` : item.installedPath || item.source}
                onToggle={(item) => void runResource(() => api.toggleExtension(item.id, !item.enabled), applyExtensions)}
                toggleDisabled={(item) => Boolean(item.packageSource)}
              />}
              {settingsTab === "packages" && <SettingsResourceList
                title="Packages" description="安装来源与资源集合。启停 Package 会同时影响其中的 Skills、Extensions、Prompts 和 Themes。" loading={loading} error={resourceError} resources={packages} busy={resourceBusy}
                pathFor={(item) => packageSummary(item)}
                onToggle={(item) => void runResource(() => api.togglePackage(item.id, !item.enabled), applyPackages)}
              />}
            </div>
          </div>
        )}

      </section>
    </div>
  );
}

const EMPTY_CUSTOM_MODEL: CustomModelInput = {
  provider: "",
  id: "",
  name: "",
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
  reasoning: false,
  imageInput: false,
  contextWindow: 128000,
  maxTokens: 16384,
};

function ModelsPanel({ models, state, busy, filter, onFilter, onModel, onReloaded }: {
  models: ModelInfo[];
  state: PiState;
  busy: boolean;
  filter: string;
  onFilter: (value: string) => void;
  onModel: (provider: string, id: string) => void;
  onReloaded: (data?: BootstrapData) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ provider: string; id: string } | null>(null);
  const [form, setForm] = useState<CustomModelInput>(EMPTY_CUSTOM_MODEL);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState("");
  const visible = useMemo(() => filterList(models, filter, (model) => `${model.provider} ${model.id} ${model.name}`), [filter, models]);
  const update = <K extends keyof CustomModelInput>(key: K, value: CustomModelInput[K]) => setForm((current) => ({ ...current, [key]: value }));
  const closeForm = () => {
    setAdding(false);
    setEditing(null);
    setForm(EMPTY_CUSTOM_MODEL);
    setModelError("");
  };
  const run = async (operation: () => Promise<BootstrapData>) => {
    setModelBusy(true);
    setModelError("");
    try {
      const data = await operation();
      onReloaded(data);
      return true;
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setModelBusy(false);
    }
  };
  const save = async () => {
    if (!form.provider.trim() || !form.id.trim()) return;
    // Editing renames via the original key; the server reloads Pi and returns
    // fresh bootstrap data, so the list and TopBar refresh automatically.
    const operation = editing ? () => api.updateModel(editing.provider, editing.id, form) : () => api.addModel(form);
    if (await run(operation)) closeForm();
  };
  const edit = async (model: ModelInfo) => {
    if (editing?.provider === model.provider && editing?.id === model.id) {
      closeForm();
      return;
    }
    setModelBusy(true);
    setModelError("");
    setAdding(false);
    try {
      const result = await api.customModel(model.provider, model.id);
      setForm(result.model);
      setEditing({ provider: model.provider, id: model.id });
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelBusy(false);
    }
  };
  const remove = async (model: ModelInfo) => {
    if (!window.confirm(`确定从 models.json 删除 “${model.provider}/${model.id}” 吗？`)) return;
    await run(() => api.removeModel(model.provider, model.id));
  };

  const renderForm = (isEditing: boolean, inline: boolean) => <div className={`model-form ${inline ? "model-form-inline" : ""}`}>
    {modelError && <div className="resource-error">{modelError}</div>}
    <div className="model-form-grid">
      <label><span>Provider *</span><input value={form.provider} onChange={(event) => update("provider", event.target.value)} placeholder="例如 ollama" /></label>
      <label><span>Model ID *</span><input value={form.id} onChange={(event) => update("id", event.target.value)} placeholder="例如 qwen2.5-coder:7b" /></label>
      <label><span>显示名称</span><input value={form.name || ""} onChange={(event) => update("name", event.target.value)} placeholder="可选" /></label>
      <label><span>API 类型</span><select value={form.api} onChange={(event) => update("api", event.target.value as CustomModelInput["api"])}><option value="openai-completions">OpenAI Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option></select></label>
      <label className="model-form-wide"><span>Base URL（新 Provider 必填）</span><input value={form.baseUrl || ""} onChange={(event) => update("baseUrl", event.target.value)} placeholder="http://localhost:11434/v1" /></label>
      <label className="model-form-wide"><span>API Key 或引用</span><input type="password" autoComplete="new-password" value={form.apiKey || ""} onChange={(event) => update("apiKey", event.target.value)} placeholder="密钥、$ENV_VAR 或本地服务占位值" /></label>
      <label><span>Context Window</span><input type="number" min="1" value={form.contextWindow || ""} onChange={(event) => update("contextWindow", event.target.value ? Number(event.target.value) : undefined)} /></label>
      <label><span>Max Tokens</span><input type="number" min="1" value={form.maxTokens || ""} onChange={(event) => update("maxTokens", event.target.value ? Number(event.target.value) : undefined)} /></label>
    </div>
    <div className="model-form-options"><label><input type="checkbox" checked={form.reasoning} onChange={(event) => update("reasoning", event.target.checked)} /> Reasoning</label><label><input type="checkbox" checked={form.imageInput} onChange={(event) => update("imageInput", event.target.checked)} /> 图片输入</label><span>API Key 不会读取或回显；留空会保留已有值。</span></div>
    {isEditing && <p className="model-form-hint">Provider 和 Model ID 都可以修改，相当于重命名；保存后模型列表和顶栏会自动刷新。</p>}
    <button type="button" className="model-save-button" disabled={busy || modelBusy || !form.provider.trim() || !form.id.trim()} onClick={() => void save()}>{modelBusy ? "保存中…" : isEditing ? "保存更改" : "保存模型"}</button>
  </div>;

  return <div className="panel-body models-panel">
    <div className="models-toolbar"><PanelIntro title="可用模型" description="切换模型，或管理 ~/.pi/agent/models.json 中的自定义模型。" count={models.length} /><button type="button" className="model-add-button" disabled={busy || modelBusy} onClick={() => { if (adding) closeForm(); else { closeForm(); setAdding(true); } }}>{adding ? "取消" : <><PlusIcon />Add</>}</button></div>
    {modelError && !adding && !editing && <div className="resource-error">{modelError}</div>}
    {adding && renderForm(false, false)}
    <Search value={filter} onChange={onFilter} placeholder="搜索 Provider 或模型" />
    <div className="model-grid">{visible.map((model) => {
      const active = state.model?.provider === model.provider && state.model?.id === model.id;
      const isEditing = editing?.provider === model.provider && editing?.id === model.id;
      return <article className={`model-card ${active ? "is-active" : ""} ${isEditing ? "is-editing" : ""}`} key={`${model.provider}/${model.id}`}>
        <div className="model-card-main">
          <button type="button" className="model-card-select" disabled={busy || modelBusy || active} onClick={() => onModel(model.provider, model.id)}>
            <strong>{model.name || model.id}</strong><small><span className="model-id-label">Model ID</span>{model.id}</small>{model.contextWindow && <span className="model-capabilities">{Math.round(model.contextWindow / 1000)}k</span>}
          </button>
          {model.custom && <div className="model-card-actions">
            <button type="button" disabled={busy || modelBusy} title="编辑 models.json 中的模型配置" onClick={() => void edit(model)}>{isEditing ? "收起" : "编辑"}</button>
            <button type="button" className="is-danger" disabled={busy || modelBusy || active} title={active ? "请先切换到其他模型" : "从 models.json 删除"} onClick={() => void remove(model)}>移除</button>
          </div>}
        </div>
        {isEditing && renderForm(true, true)}
      </article>;
    })}</div>
  </div>;
}

function filterList<T>(items: T[], filter: string, text: (item: T) => string): T[] {
  const needle = filter.trim().toLowerCase();
  return needle ? items.filter((item) => text(item).toLowerCase().includes(needle)) : items;
}

function Search({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <input className="panel-search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />;
}

function PanelIntro({ title, description, count }: { title: string; description?: string; count?: number }) {
  return <div className="panel-intro"><div><h3>{title}</h3>{description && <p>{description}</p>}</div>{typeof count === "number" && <span className="count-badge">{count}</span>}</div>;
}

function packageSummary(item: PackageResource): string {
  const counts = item.resources.reduce<Record<string, number>>((result, resource) => ({ ...result, [resource.kind]: (result[resource.kind] || 0) + 1 }), {});
  const labels = (["extension", "skill", "prompt", "theme"] as const).flatMap((kind) => counts[kind] ? [`${counts[kind]} ${kind === "extension" ? "Extensions" : kind === "skill" ? "Skills" : kind === "prompt" ? "Prompts" : "Themes"}`] : []);
  return `${item.source}${item.version ? ` · v${item.version}` : ""}${labels.length ? ` · 含 ${labels.join(" · ")}` : ""}`;
}

function SettingsResourceList<T extends { id: string; name: string; enabled: boolean }>({ title, description, loading, error, resources, busy, pathFor, onToggle, toggleDisabled }: {
  title: string;
  description: string;
  loading: boolean;
  error: string;
  resources: T[];
  busy: boolean;
  pathFor: (item: T) => string;
  onToggle: (item: T) => void;
  toggleDisabled?: (item: T) => boolean;
}) {
  return <div className="settings-resource-panel">
    <PanelIntro title={title} description={description} count={resources.length} />
    {error && <div className="resource-error">{error}</div>}
    <div className="settings-resource-list">
      {loading ? <p className="resource-loading">正在扫描…</p> : resources.map((item) => <article key={item.id} className="settings-resource-row">
        <div><strong>{item.name}</strong><code title={pathFor(item)}>{pathFor(item)}</code></div>
        <Toggle enabled={item.enabled} busy={busy || toggleDisabled?.(item) === true} onClick={() => onToggle(item)} />
      </article>)}
      {!loading && !resources.length && <p className="resource-loading">未发现 {title}</p>}
    </div>
  </div>;
}

function Toggle({ enabled, busy, onClick }: { enabled: boolean; busy: boolean; onClick: () => void }) {
  const label = enabled ? "已启用，点击停用" : "已停用，点击启用";
  return <button type="button" className={`resource-toggle ${enabled ? "is-enabled" : ""}`} disabled={busy} onClick={onClick} role="switch" aria-checked={enabled} aria-label={label} title={label}><span className="resource-toggle-knob" /></button>;
}

function AppearancePanel({ value, onChange }: { value: AppearancePreferences; onChange: (value: AppearancePreferences) => void }) {
  const update = <K extends keyof AppearancePreferences>(key: K, next: AppearancePreferences[K]) => onChange({ ...value, [key]: next });
  const isDefault = Object.keys(DEFAULT_APPEARANCE).every((key) => value[key as keyof AppearancePreferences] === DEFAULT_APPEARANCE[key as keyof AppearancePreferences]);
  return <div className="panel-body appearance-panel">
    <div className="appearance-panel-heading">
      <PanelIntro title="外观与阅读" />
      <button type="button" className="appearance-reset" disabled={isDefault} onClick={() => onChange({ ...DEFAULT_APPEARANCE })}>重置外观</button>
    </div>
    <SettingRow title="主题"><CompactSelect value={value.theme} options={THEME_OPTIONS} ariaLabel="主题" title="主题" align="right" className="appearance-select" onChange={(next) => update("theme", next)} /></SettingRow>
    <SettingRow title="聊天字体"><CompactSelect value={value.font} options={FONT_OPTIONS} ariaLabel="聊天字体" title="聊天字体" align="right" className="appearance-select" onChange={(next) => update("font", next)} /></SettingRow>
    <StepperSetting title="字号" hint="10 ~ 30 px" value={value.fontSize} minimum={10} maximum={30} step={1} onChange={(next) => update("fontSize", next)} />
    <StepperSetting title="行间距" hint="1.0 ~ 3.0" value={value.lineHeight} minimum={1.0} maximum={3.0} step={0.1} decimals={1} onChange={(next) => update("lineHeight", next)} />
    <StepperSetting title="对话宽度" hint="600 ~ 1500 px" value={value.chatWidth} minimum={600} maximum={1500} step={50} onChange={(next) => update("chatWidth", next)} />
    <details className="markdown-css-settings">
      <summary>更多外观设置 · Markdown CSS</summary>
      <p>仅用于调整聊天 Markdown 的显示。请使用 <code>.markdown-body</code> 作为每条规则的选择器前缀，避免影响其他界面。</p>
      <textarea value={value.markdownCss} onChange={(event) => update("markdownCss", event.target.value)} spellCheck={false} placeholder={".markdown-body h1 {\n  color: #2368d8;\n}\n\n.markdown-body blockquote {\n  border-left-width: 5px;\n}"} aria-label="Markdown 自定义 CSS" />
      <button type="button" className="markdown-css-clear" disabled={!value.markdownCss} onClick={() => update("markdownCss", "")}>清空自定义 CSS</button>
    </details>
  </div>;
}

function SettingRow({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  // Custom controls contain buttons/listboxes, so a label wrapper would create invalid nested interactive content.
  return <div className="setting-row"><span><strong>{title}</strong>{description && <small>{description}</small>}</span>{children}</div>;
}

function StepperSetting({ title, hint, value, minimum, maximum, step, suffix, decimals = 0, onChange }: {
  title: string;
  hint?: string;
  value: number;
  minimum: number;
  maximum: number;
  step: number;
  suffix?: string;
  decimals?: number;
  onChange: (value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const valueRef = useRef(value);
  valueRef.current = value;
  const repeatRef = useRef<{ timeout?: number; interval?: number }>({});
  const pointerActiveRef = useRef(false);

  const stopRepeat = () => {
    window.clearTimeout(repeatRef.current.timeout);
    window.clearInterval(repeatRef.current.interval);
    repeatRef.current = {};
  };
  useEffect(() => stopRepeat, []);

  const applyStep = (direction: 1 | -1) => {
    const next = snapToStep(valueRef.current + direction * step, minimum, maximum, step);
    if (next === valueRef.current) {
      stopRepeat();
      return;
    }
    onChange(next);
  };
  const beginRepeat = (direction: 1 | -1) => {
    stopRepeat();
    applyStep(direction);
    repeatRef.current.timeout = window.setTimeout(() => {
      repeatRef.current.interval = window.setInterval(() => applyStep(direction), 90);
    }, 420);
  };

  const commitDraft = () => {
    const parsed = Number(draft.trim().replace(/px$/i, ""));
    if (draft.trim() && Number.isFinite(parsed)) onChange(snapToStep(parsed, minimum, maximum, step));
    setEditing(false);
  };

  return <div className="stepper-setting">
    <span className="stepper-setting-label"><strong>{title}</strong>{hint && <small>{hint}</small>}</span>
    <div className="stepper" role="group" aria-label={title}>
      <button type="button" className="stepper-button" disabled={value <= minimum} aria-label={`减小${title}`}
        onPointerDown={() => { pointerActiveRef.current = true; beginRepeat(-1); }}
        onPointerUp={stopRepeat} onPointerLeave={stopRepeat} onPointerCancel={stopRepeat}
        onClick={() => { if (pointerActiveRef.current) { pointerActiveRef.current = false; return; } applyStep(-1); }}
      ><MinusIcon /></button>
      {editing
        ? <input className="stepper-input" value={draft} autoFocus inputMode="decimal" aria-label={`${title}数值`}
            onChange={(event) => setDraft(event.target.value)} onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); commitDraft(); }
              if (event.key === "Escape") { event.preventDefault(); setEditing(false); }
            }} />
        : <button type="button" className="stepper-value" title="点击输入精确数值（自动纠正到档位）" aria-label={`${title}当前值 ${value.toFixed(decimals)}${suffix}`}
            onClick={() => { setDraft(String(Number(value.toFixed(decimals)))); setEditing(true); }}
          >{value.toFixed(decimals)}{suffix}</button>}
      <button type="button" className="stepper-button" disabled={value >= maximum} aria-label={`增大${title}`}
        onPointerDown={() => { pointerActiveRef.current = true; beginRepeat(1); }}
        onPointerUp={stopRepeat} onPointerLeave={stopRepeat} onPointerCancel={stopRepeat}
        onClick={() => { if (pointerActiveRef.current) { pointerActiveRef.current = false; return; } applyStep(1); }}
      ><PlusIcon /></button>
    </div>
  </div>;
}
