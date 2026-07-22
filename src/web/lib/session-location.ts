const PWA_SESSION_KEY = "pi-chat:pwa-session";

export function isStandaloneApp(): boolean {
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return standaloneNavigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

export function rememberedSessionId(): string {
  const fromUrl = new URL(window.location.href).searchParams.get("session") || "";
  if (!isStandaloneApp()) return fromUrl;
  return window.sessionStorage.getItem(PWA_SESSION_KEY) || fromUrl;
}

export function rememberSessionId(id: string): void {
  if (isStandaloneApp()) {
    if (id) window.sessionStorage.setItem(PWA_SESSION_KEY, id);
    else window.sessionStorage.removeItem(PWA_SESSION_KEY);
    return;
  }
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("session", id);
  else url.searchParams.delete("session");
  window.history.replaceState(null, "", url);
}
