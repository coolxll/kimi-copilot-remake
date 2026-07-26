import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import type { AppSettingsV2, OpenAICompatibleConfig } from "../../domain/types";
import { DEFAULT_CHUNK_CHARS, DEFAULT_MAX_SOURCE_CHARS, DEFAULT_PROMPT } from "../../domain/types";
import { AppError, toAppError } from "../../domain/errors";
import { ensureApiHostPermission, normalizeApiRoot, revokeApiHostPermission, validateApiRoot } from "../../platform/chrome/permissions";
import { createAppServices } from "../../application/services";
import "../styles.css";

export function OptionsApp() {
  const services = createAppServices();
  const [settings, setSettings] = useState<AppSettingsV2>();
  const [defaultProvider, setDefaultProvider] = useState<AppSettingsV2["defaultProvider"]>("kimi-web");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [config, setConfig] = useState<OpenAICompatibleConfig>({ apiRoot: "", model: "", chunkChars: DEFAULT_CHUNK_CHARS, maxSourceChars: DEFAULT_MAX_SOURCE_CHARS });
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [hasKimiToken, setHasKimiToken] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string }>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await services.storage.getSettings();
        const secret = await services.storage.getOpenAISecret();
        const kimi = await services.storage.getKimiTokens();
        setSettings(loaded);
        setDefaultProvider(loaded.defaultProvider);
        setPrompt(loaded.promptOverride || DEFAULT_PROMPT);
        setConfig(loaded.openAICompatible || { apiRoot: "", model: "", chunkChars: DEFAULT_CHUNK_CHARS, maxSourceChars: DEFAULT_MAX_SOURCE_CHARS });
        setHasToken(Boolean(secret?.apiToken));
        setHasKimiToken(Boolean(kimi?.refreshToken));
      } catch (error) {
        setNotice({ kind: "error", text: toAppError(error).message });
      }
    })();
    // Services are stable for this options page.
  }, []);

  const save = async () => {
    setSaving(true);
    setNotice(undefined);
    try {
      const oldRoot = settings?.openAICompatible?.apiRoot;
      const nextConfig = config.apiRoot.trim() || config.model.trim() || token.trim() ? normalizeConfig(config) : undefined;
      if (nextConfig) {
        validateApiRoot(nextConfig.apiRoot);
        if (!nextConfig.model.trim()) throw new AppError("provider-not-configured", "请填写兼容 API 的 Model");
        await ensureApiHostPermission(nextConfig.apiRoot);
      }
      const nextSettings: AppSettingsV2 = {
        version: 2,
        defaultProvider,
        promptOverride: prompt.trim() && prompt.trim() !== DEFAULT_PROMPT ? prompt.trim() : undefined,
        openAICompatible: nextConfig,
      };
      await services.storage.saveSettings(nextSettings);
      if (token.trim()) {
        await services.storage.saveOpenAISecret({ apiToken: token.trim() });
        setHasToken(true);
        setToken("");
      }
      if (oldRoot && nextConfig && normalizeApiRoot(oldRoot) !== nextConfig.apiRoot) await revokeApiHostPermission(oldRoot);
      setSettings(nextSettings);
      setNotice({ kind: "success", text: "保存成功" });
    } catch (error) {
      setNotice({ kind: "error", text: toAppError(error).message });
    } finally {
      setSaving(false);
    }
  };

  const clearToken = async () => {
    await services.storage.clearOpenAISecret();
    setHasToken(false);
    setToken("");
    setNotice({ kind: "success", text: "兼容 API Token 已清除" });
  };

  const testConnection = async () => {
    setNotice(undefined);
    try {
      const nextConfig = normalizeConfig(config);
      validateApiRoot(nextConfig.apiRoot);
      await ensureApiHostPermission(nextConfig.apiRoot);
      const secret = token.trim() ? { apiToken: token.trim() } : await services.storage.getOpenAISecret();
      const result = await services.testOpenAIConnection(nextConfig, secret);
      setNotice({ kind: "success", text: result.message });
    } catch (error) {
      setNotice({ kind: "error", text: toAppError(error).message });
    }
  };

  const loginKimi = async () => {
    setNotice(undefined);
    try {
      await services.auth.openLoginAndWait();
      setHasKimiToken(true);
      setNotice({ kind: "success", text: "Kimi 登录态已保存" });
    } catch (error) {
      setNotice({ kind: "error", text: toAppError(error).message });
    }
  };

  const clearKimi = async () => {
    await services.auth.clear();
    setHasKimiToken(false);
    setNotice({ kind: "success", text: "Kimi 登录态已清除" });
  };

  if (!settings) return <main className="page"><div className="panel">加载中…</div></main>;
  return <main className="page"><div className="panel">
    <header className="header"><h1>选项</h1><button className="button" onClick={() => void browser.tabs.create({ url: "chrome://extensions/shortcuts" })}>快捷键</button></header>
    {notice && <div className={notice.kind === "success" ? "success" : "error"}>{notice.text}</div>}
    <section className="card">
      <div className="field"><label className="label" htmlFor="provider">默认总结后端</label><select id="provider" className="select" value={defaultProvider} onChange={(event) => setDefaultProvider(event.target.value as AppSettingsV2["defaultProvider"])}><option value="kimi-web">Kimi Web</option><option value="openai-compatible">OpenAI Compatible</option></select></div>
      <div className="field"><label className="label" htmlFor="prompt">Prompt</label><textarea id="prompt" className="textarea" value={prompt} onChange={(event) => setPrompt(event.target.value)} /><p className="muted">留空或恢复默认将使用：{DEFAULT_PROMPT}</p></div>
    </section>
    <section className="card">
      <h2>Kimi Web</h2><p className="muted">复用当前浏览器中的 Kimi 登录态，文件会通过 Kimi 文件接口处理。</p>
      <div className="actions"><span className={hasKimiToken ? "success" : "warning"}>{hasKimiToken ? "已配置登录态" : "未登录"}</span><button className="button" onClick={() => void loginKimi()}>{hasKimiToken ? "重新登录" : "登录 Kimi"}</button>{hasKimiToken && <button className="button danger" onClick={() => void clearKimi()}>清除登录态</button>}</div>
    </section>
    <section className="card">
      <h2>OpenAI Compatible</h2><p className="warning">这是个人/内部 BYOK 模式。Token 会保存在本机扩展存储中，并随请求发送到你配置的服务。</p>
      <div className="field"><label className="label" htmlFor="apiRoot">API Root</label><input id="apiRoot" className="input" value={config.apiRoot} placeholder="https://api.openai.com/v1" onChange={(event) => setConfig({ ...config, apiRoot: event.target.value })} /><p className="muted">远程地址必须 HTTPS；HTTP 仅允许 localhost、127.0.0.1 和 ::1。</p></div>
      <div className="field"><label className="label" htmlFor="model">Model</label><input id="model" className="input" value={config.model} placeholder="填写服务商提供的模型名" onChange={(event) => setConfig({ ...config, model: event.target.value })} /></div>
      <div className="field"><label className="label" htmlFor="token">API Token</label><input id="token" className="input" type="password" value={token} placeholder={hasToken ? "已配置（留空保持不变）" : "输入 Token；本机服务可留空"} onChange={(event) => setToken(event.target.value)} />{hasToken && <p className="muted">Token 已配置，不会回填明文。</p>}</div>
      <div className="option-grid"><div className="field"><label className="label" htmlFor="chunkChars">单块字符数</label><input id="chunkChars" className="input" type="number" min={4000} max={50000} value={config.chunkChars} onChange={(event) => setConfig({ ...config, chunkChars: Number(event.target.value) })} /></div><div className="field"><label className="label" htmlFor="maxSourceChars">最大源文本</label><input id="maxSourceChars" className="input" type="number" min={20000} max={500000} value={config.maxSourceChars} onChange={(event) => setConfig({ ...config, maxSourceChars: Number(event.target.value) })} /></div></div>
      <div className="actions"><button className="button" onClick={() => void testConnection()}>测试连接</button><button className="button danger" disabled={!hasToken} onClick={() => void clearToken()}>清除 Token</button></div>
    </section>
    <div className="actions"><button className="button primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存全部设置"}</button></div>
  </div></main>;
}

function normalizeConfig(config: OpenAICompatibleConfig): OpenAICompatibleConfig {
  return { ...config, apiRoot: normalizeApiRoot(config.apiRoot), model: config.model.trim(), chunkChars: Number(config.chunkChars), maxSourceChars: Number(config.maxSourceChars) };
}
