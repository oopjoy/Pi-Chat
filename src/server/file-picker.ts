import { existsSync, statSync } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, extname } from "node:path";

/** Hidden TopMost owner so a background PowerShell dialog cannot sit behind the browser. */
const DIALOG_OWNER_PREAMBLE = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function New-PiChatDialogOwner {
  $owner = New-Object System.Windows.Forms.Form
  $owner.Text = 'Pi Chat'
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $owner.Location = New-Object System.Drawing.Point(-32000, -32000)
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  [void]$owner.Show()
  [void]$owner.Activate()
  return $owner
}
`;

const PICKER_SCRIPT = String.raw`
` + DIALOG_OWNER_PREAMBLE + String.raw`
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Pi Chat - Local file picker'
$dialog.Multiselect = $true
$dialog.CheckFileExists = $true
$dialog.RestoreDirectory = $true
$dialog.Filter = '所有文件 (*.*)|*.*'
$owner = New-PiChatDialogOwner
try {
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    ConvertTo-Json -InputObject @($dialog.FileNames) -Compress
  } else {
    '[]'
  }
} finally {
  $owner.Close()
  $owner.Dispose()
}
`;

const CLIPBOARD_FILES_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  ConvertTo-Json -InputObject @([System.Windows.Forms.Clipboard]::GetFileDropList()) -Compress
} else {
  '[]'
}
`;

const FOLDER_PICKER_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;

[ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
public class FileOpenDialogClass { }

[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileOpenDialog {
  [PreserveSig] int Show(IntPtr parent);
  void SetFileTypes(uint count, IntPtr specs);
  void SetFileTypeIndex(uint index);
  void GetFileTypeIndex(out uint index);
  void Advise(IntPtr events, out uint cookie);
  void Unadvise(uint cookie);
  void SetOptions(uint options);
  void GetOptions(out uint options);
  void SetDefaultFolder(IShellItem item);
  void SetFolder(IShellItem item);
  void GetFolder(out IShellItem item);
  void GetCurrentSelection(out IShellItem item);
  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
  void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
  void GetResult(out IShellItem item);
}

[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItem {
  void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
  void GetParent(out IShellItem parent);
  void GetDisplayName(uint nameType, out IntPtr name);
  void GetAttributes(uint mask, out uint attributes);
  void Compare(IShellItem other, uint hint, out int order);
}

public static class PiChatFolderPicker {
  private const uint FOS_PICKFOLDERS = 0x00000020;
  private const uint FOS_FORCEFILESYSTEM = 0x00000040;
  private const uint FOS_PATHMUSTEXIST = 0x00000800;
  private const uint SIGDN_FILESYSPATH = 0x80058000;

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName(string path, IntPtr binding, ref Guid iid, out IShellItem item);

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  public static string Pick(string initialPath, IntPtr parent) {
    IFileOpenDialog dialog = null;
    IShellItem initial = null;
    IShellItem selected = null;
    try {
      dialog = (IFileOpenDialog)new FileOpenDialogClass();
      uint options;
      dialog.GetOptions(out options);
      dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
      dialog.SetTitle("Pi Chat - 浏览并选择工作目录");
      dialog.SetOkButtonLabel("选择此文件夹");
      if (!String.IsNullOrWhiteSpace(initialPath) && Directory.Exists(initialPath)) {
        var shellItemId = typeof(IShellItem).GUID;
        SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref shellItemId, out initial);
        dialog.SetFolder(initial);
      }
      if (parent == IntPtr.Zero) parent = GetForegroundWindow();
      if (dialog.Show(parent) < 0) return null;
      dialog.GetResult(out selected);
      IntPtr value;
      selected.GetDisplayName(SIGDN_FILESYSPATH, out value);
      try { return Marshal.PtrToStringUni(value); }
      finally { Marshal.FreeCoTaskMem(value); }
    } finally {
      if (selected != null) Marshal.FinalReleaseComObject(selected);
      if (initial != null) Marshal.FinalReleaseComObject(initial);
      if (dialog != null) Marshal.FinalReleaseComObject(dialog);
    }
  }
}
'@
` + DIALOG_OWNER_PREAMBLE + String.raw`
$owner = New-PiChatDialogOwner
try {
  $result = [PiChatFolderPicker]::Pick($env:PI_CHAT_PICKER_INITIAL, $owner.Handle)
} finally {
  $owner.Close()
  $owner.Dispose()
}
if ($null -eq $result) { 'null' } else { ConvertTo-Json -InputObject $result -Compress }
`;

/**
 * Workspace selection may use a canonical Windows UNC path, including WSL's
 * `\\\\wsl.localhost\\Distro\\…` shares. The workspace route normalizes equivalent
 * spellings and still proves the returned path with `stat()`.
 */
export function isWindowsWorkspacePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.charCodeAt(0) !== 92 || value.charCodeAt(1) !== 92) return false;
  if (value.includes("/")) return false;
  const [host, share] = value.slice(2).split(String.fromCharCode(92), 3);
  return Boolean(host && share)
    && !/[\\/:*?"<>|\u0000-\u001f]/.test(host)
    && !/[\\/:*?"<>|\u0000-\u001f]/.test(share);
}

function isSafeWindowsFilePath(value: string): boolean {
  return /^[A-Za-z]:[\\/][^<>:"|?*\u0000-\u001f]*$/.test(value)
    && value.length > 3;
}

export function parsePickerOutput(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  // Local-file and clipboard attachment behavior intentionally stays drive-only.
  return values.filter((value): value is string => typeof value === "string" && isSafeWindowsFilePath(value));
}

async function runPicker(
  script: string,
  timeoutMessage: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = 10 * 60_000,
): Promise<string> {
  if (process.platform !== "win32") throw new Error("本地选择器目前仅支持 Windows");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(timeoutMessage));
    }, Math.max(1, timeoutMs));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 1_000_000) child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `Windows 文件选择器退出，代码 ${code}`));
      resolve(stdout);
    });
  });
}

export async function readClipboardFiles(expected: Array<{ name: string; size: number }> = []): Promise<string[]> {
  try {
    const paths = parsePickerOutput(await runPicker(CLIPBOARD_FILES_SCRIPT, "读取 Windows 剪贴板超时"));
    // Never return the mutable process clipboard without browser file metadata
    // that binds this native snapshot to the paste event.
    if (!expected.length) return [];
    const remaining = [...expected];
    const matched: string[] = [];
    for (const path of paths) {
      const index = remaining.findIndex((item) => item.name === basename(path) && item.size === statSyncSize(path));
      if (index < 0) continue;
      matched.push(path);
      remaining.splice(index, 1);
    }
    return remaining.length === 0 && matched.length === paths.length ? matched : [];
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("无法读取 Windows 剪贴板文件路径");
    throw error;
  }
}

function statSyncSize(path: string): number {
  try {
    const info = statSync(path);
    // Explorer/Chromium expose folders as size-0 File objects.
    return info.isDirectory() ? 0 : info.size;
  } catch {
    return -1;
  }
}

export async function localPathKinds(paths: string[]): Promise<Array<{ path: string; kind: "file" | "directory" }>> {
  const unique = [...new Set(paths.filter((path) => parsePickerOutput(JSON.stringify([path]))[0] === path))].slice(0, 32);
  const kinds: Array<{ path: string; kind: "file" | "directory" }> = [];
  for (const path of unique) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) kinds.push({ path, kind: "directory" });
      else if (info.isFile()) kinds.push({ path, kind: "file" });
    } catch { /* missing paths stay unclassified */ }
  }
  return kinds;
}

export async function pickLocalFiles(): Promise<string[]> {
  try {
    return parsePickerOutput(await runPicker(PICKER_SCRIPT, "文件选择窗口等待超时"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("无法读取 Windows 文件选择器结果");
    throw error;
  }
}

export async function pickPiRuntimeEntry(): Promise<string | null> {
  const script = PICKER_SCRIPT
    .replace("$dialog.Multiselect = $true", "$dialog.Multiselect = $false")
    .replace("Pi Chat - Local file picker", "Pi Chat - Select trusted Pi dist/rpc-entry.js")
    .replace("所有文件 (*.*)|*.*", "Pi RPC entry (rpc-entry.js)|rpc-entry.js");
  const paths = parsePickerOutput(await runPicker(script, "Pi 入口选择窗口等待超时"));
  return paths.length === 1 ? paths[0] : null;
}

export async function pickWorkspaceFolder(initialPath?: string): Promise<string | null> {
  try {
    const output = (await runPicker(FOLDER_PICKER_SCRIPT, "文件夹选择窗口等待超时", initialPath ? { PI_CHAT_PICKER_INITIAL: initialPath } : {})).trim();
    if (!output) return null;
    const jsonLine = output.split(/\r?\n/).filter(Boolean).at(-1) || "null";
    const value: unknown = JSON.parse(jsonLine);
    return isWindowsWorkspacePath(value) ? value : null;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("无法读取 Windows 文件夹选择器结果");
    throw error;
  }
}

const BLOCKED_DEFAULT_OPEN_EXTENSIONS = new Set([
  ".ade", ".adp", ".app", ".application", ".appref-ms", ".bat", ".cmd", ".com", ".cpl",
  ".diagcab", ".dll", ".exe", ".gadget", ".hta", ".inf", ".ins", ".isp", ".jar", ".js",
  ".jse", ".lnk", ".msc", ".msi", ".msp", ".mst", ".pif", ".pl", ".ps1", ".ps1xml",
  ".ps2", ".ps2xml", ".psc1", ".psc2", ".psd1", ".psm1", ".py", ".pyw", ".rb", ".reg",
  ".scf", ".scr", ".sct", ".sh", ".shb", ".shs", ".url", ".vb", ".vbe", ".vbs", ".ws",
  ".wsc", ".wsf", ".wsh", ".xll", ".chm", ".settingcontent-ms", ".website", ".internetshortcut",
  ".appx", ".msix", ".msixbundle", ".theme", ".themepack",
]);
const WINDOWS_SHELL_TIMEOUT_MS = 10_000;
const MAX_WINDOWS_SHELL_STDERR_CHARS = 16 * 1024;

type WindowsShellProcess = {
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): unknown;
};

export function isSafeDefaultApplicationFile(targetPath: string): boolean {
  return !BLOCKED_DEFAULT_OPEN_EXTENSIONS.has(extname(targetPath).toLowerCase());
}

/** Bound a shell launcher so an OS-association failure cannot pin an API request forever. */
export function waitForWindowsShellProcess(
  child: WindowsShellProcess,
  failureMessage: string,
  timeoutMessage: string,
  timeoutMs = WINDOWS_SHELL_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stderr.on("data", (chunk) => {
      const remaining = MAX_WINDOWS_SHELL_STDERR_CHARS - stderr.length;
      if (remaining <= 0) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      stderr += text.slice(0, remaining);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(code === 0 ? undefined : new Error(stderr.trim() || failureMessage)));
    timer = setTimeout(() => {
      finish(new Error(timeoutMessage));
      try { child.kill(); } catch { /* process may already have exited */ }
    }, Math.max(1, timeoutMs));
  });
}

/** Open a composer attachment: files with the default app, directories in Explorer. */
export async function openLocalAttachment(targetPath: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("打开本地文件目前仅支持 Windows");
  if (!isWindowsWorkspacePath(targetPath)) throw new Error("路径无效");
  if (!isSafeDefaultApplicationFile(targetPath)) throw new Error("为安全起见，此文件类型不能直接打开");
  let targetStat;
  try { targetStat = await lstat(targetPath); }
  catch { throw new Error("文件不存在"); }
  if (targetStat.isSymbolicLink()) throw new Error("文件不存在");
  if (targetStat.isDirectory()) {
    await openWorkspaceDirectory(targetPath);
    return;
  }
  if (!targetStat.isFile()) throw new Error("文件不存在");
  await openWithDefaultApplication(targetPath);
}

/** Open one server-validated, non-executable file with its Windows default application. */
export async function openWithDefaultApplication(
  targetPath: string,
  verifyTarget?: () => Promise<string>,
): Promise<void> {
  if (process.platform !== "win32") throw new Error("打开本地文件目前仅支持 Windows");
  if (!isWindowsWorkspacePath(targetPath)) throw new Error("路径无效");
  if (!isSafeDefaultApplicationFile(targetPath)) throw new Error("为安全起见，此文件类型不能直接打开");
  if (verifyTarget && await verifyTarget() !== targetPath) throw new Error("文件路径在打开前发生变化");
  let targetStat;
  try { targetStat = await lstat(targetPath); }
  catch { throw new Error("文件不存在"); }
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw new Error("文件不存在");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:PI_CHAT_OPEN_PATH"],
    {
      windowsHide: true,
      env: { ...process.env, PI_CHAT_OPEN_PATH: targetPath },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  await waitForWindowsShellProcess(
    child as unknown as WindowsShellProcess,
    "无法打开本地文件",
    "打开本地文件超时",
  );
}

/**
 * Open one server-validated workspace directory in Explorer. Mirrors the file
 * opener's verify-then-launch contract so a swapped path cannot redirect the
 * shell to an unrelated location.
 */
export async function openWorkspaceDirectory(
  targetPath: string,
  verifyTarget?: () => Promise<string>,
): Promise<void> {
  if (process.platform !== "win32") throw new Error("打开本地目录目前仅支持 Windows");
  if (!isWindowsWorkspacePath(targetPath)) throw new Error("路径无效");
  if (!isSafeDefaultApplicationFile(targetPath)) throw new Error("为安全起见，此目录不能直接打开");
  if (verifyTarget && await verifyTarget() !== targetPath) throw new Error("目录路径在打开前发生变化");
  const targetStat = await lstat(targetPath).catch(() => null);
  if (!targetStat || targetStat.isSymbolicLink() || !targetStat.isDirectory()) throw new Error("目录不存在");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:PI_CHAT_OPEN_PATH"],
    {
      windowsHide: true,
      env: { ...process.env, PI_CHAT_OPEN_PATH: targetPath },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  await waitForWindowsShellProcess(
    child as unknown as WindowsShellProcess,
    "无法打开本地目录",
    "打开本地目录超时",
  );
}

/** Open a local file or folder through the Windows shell. Loopback-only helper for settings. */
export async function revealInExplorer(targetPath: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("打开本地目录目前仅支持 Windows");
  if (!targetPath || !/^[A-Za-z]:[\\/]/.test(targetPath)) throw new Error("路径无效");
  if (!existsSync(targetPath)) throw new Error("路径不存在");
  const isDir = (await stat(targetPath)).isDirectory();
  // ShellExecute via PowerShell is more reliable than spawning explorer.exe
  // directly from a detached/background Node process. It also preserves paths
  // containing spaces, CJK characters, and shell metacharacters.
  const script = isDir
    ? "Start-Process -FilePath $env:PI_CHAT_REVEAL_PATH"
    : "Start-Process -FilePath explorer.exe -ArgumentList ('/select,\"{0}\"' -f $env:PI_CHAT_REVEAL_PATH)";
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    env: { ...process.env, PI_CHAT_REVEAL_PATH: targetPath },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await waitForWindowsShellProcess(
    child as unknown as WindowsShellProcess,
    "无法启动 Windows 资源管理器",
    "启动 Windows 资源管理器超时",
  );
}
