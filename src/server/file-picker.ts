import { spawn } from "node:child_process";

const PICKER_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Pi Chat - Local file picker'
$dialog.Multiselect = $true
$dialog.CheckFileExists = $true
$dialog.RestoreDirectory = $true
$dialog.Filter = '所有文件 (*.*)|*.*'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  ConvertTo-Json -InputObject @($dialog.FileNames) -Compress
} else {
  '[]'
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

  public static string Pick(string initialPath) {
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
      if (dialog.Show(GetForegroundWindow()) < 0) return null;
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
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$result = [PiChatFolderPicker]::Pick($env:PI_CHAT_PICKER_INITIAL)
if ($null -eq $result) { 'null' } else { ConvertTo-Json -InputObject $result -Compress }
`;

export function parsePickerOutput(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.filter((value): value is string => typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value));
}

async function runPicker(script: string, timeoutMessage: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
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
    }, 10 * 60_000);
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

export async function pickLocalFiles(): Promise<string[]> {
  try {
    return parsePickerOutput(await runPicker(PICKER_SCRIPT, "文件选择窗口等待超时"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("无法读取 Windows 文件选择器结果");
    throw error;
  }
}

export async function readClipboardFiles(): Promise<string[]> {
  try {
    return parsePickerOutput(await runPicker(CLIPBOARD_FILES_SCRIPT, "读取 Windows 剪贴板超时"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("无法读取 Windows 剪贴板文件路径");
    throw error;
  }
}

export async function pickWorkspaceFolder(initialPath?: string): Promise<string | null> {
  try {
    const output = (await runPicker(FOLDER_PICKER_SCRIPT, "文件夹选择窗口等待超时", initialPath ? { PI_CHAT_PICKER_INITIAL: initialPath } : {})).trim();
    if (!output) return null;
    const jsonLine = output.split(/\r?\n/).filter(Boolean).at(-1) || "null";
    const value: unknown = JSON.parse(jsonLine);
    return typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value) ? value : null;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("无法读取 Windows 文件夹选择器结果");
    throw error;
  }
}
