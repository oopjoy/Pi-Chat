const WINDOWS_PLATFORM = "win32";

/**
 * Python on Simplified-Chinese Windows defaults redirected stdout to GBK.
 * Pi Runtimes and their subagents inherit this environment, so printing a
 * Unicode path or OCR replacement character can otherwise terminate an
 * otherwise valid tool call with UnicodeEncodeError.
 *
 * Respect explicit operator overrides and only supply safe UTF-8 defaults.
 */
export function ensureUtf8ChildProcessEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== WINDOWS_PLATFORM) return;
  environment.PYTHONUTF8 ??= "1";
  environment.PYTHONIOENCODING ??= "utf-8";
}
