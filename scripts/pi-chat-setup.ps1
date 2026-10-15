[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('CheckRunning', 'Detect', 'InstallPi')][string]$Action,
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$ResultFile
)

# Inno Setup owns files, shortcuts and uninstall. This helper never downloads
# the application/Node and never upgrades an already detected Pi.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$appRoot = Join-Path $InstallRoot 'app'
$node = Join-Path $InstallRoot 'runtime\node\node.exe'
$staging = $null
$logPath = Join-Path ([IO.Path]::GetTempPath()) 'pi-chat-pi-install.log'
function Report([bool]$Found, [string]$Message, [string]$Entry = '', [string]$Version = '') {
  $Message = $Message.Replace("`r", ' ').Replace("`n", ' ')
  $lines = @('[Pi]', ('Found=' + [int]$Found), ('Message=' + $Message), ('Entry=' + $Entry), ('Version=' + $Version))
  [IO.File]::WriteAllLines($ResultFile, $lines, [Text.Encoding]::Unicode)
}
function DetectPi {
  $envFile = Join-Path $InstallRoot 'config\runtime.env'
  if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
      if ($line -match '^PI_CHAT_MANAGED_INSTALL_ROOT=(.+)$') { $env:PI_CHAT_MANAGED_INSTALL_ROOT = $matches[1] }
    }
  }
  $value = & $node (Join-Path $appRoot 'scripts\detect-pi-entry.mjs') 2>>$logPath
  if ($LASTEXITCODE -ne 0) { throw 'Pi detection failed; check PI_CHAT_PI_ENTRY or connection settings.' }
  if ($value) { return ($value | ConvertFrom-Json) }
  return $null
}
try {
  if ($Action -eq 'CheckRunning') {
    # A different checkout on 30170 cannot lock this installation. Its launcher
    # still refuses a foreign listener; never stop it or force-close processes.
    # GetFullPath is lexical: it does not resolve RUNNER~1, junctions or other
    # aliases. Compare filesystem identities as well as literal launch paths.
    if (-not ('PiChatInstallerPaths' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PiChatInstallerPaths {
  [DllImport("shell32.dll", SetLastError = true)]
  private static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string line, out int count);
  [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ReadProcessMemory(SafeProcessHandle process, IntPtr address, byte[] bytes, int count, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool IsWow64Process(SafeProcessHandle process, out bool wow64);
  [DllImport("ntdll.dll")]
  private static extern int NtQueryInformationProcess(SafeProcessHandle process, int kind, [Out] IntPtr[] data, int size, out int returned);
  private static byte[] Read(SafeProcessHandle process, IntPtr address, int count) {
    var bytes = new byte[count]; IntPtr read;
    if (address == IntPtr.Zero || !ReadProcessMemory(process, address, bytes, count, out read) || read.ToInt64() != count)
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot verify the Pi Chat process working directory");
    return bytes;
  }
  private static IntPtr Pointer(byte[] bytes, int offset, int size) {
    return size == 8 ? new IntPtr(BitConverter.ToInt64(bytes, offset)) : new IntPtr((long)BitConverter.ToUInt32(bytes, offset));
  }
  // Read only the Windows x86/x64 PEB process-parameters pointer and bounded cwd
  // UNICODE_STRING. Fail closed if that layout cannot be verified. Never scan,
  // alter arbitrary process memory, or stop the inspected process.
  private static string WorkingDirectory(int pid) {
    using (var process = OpenProcess(0x0410, false, pid)) {
      if (process.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      bool wow64; int returned;
      if (!IsWow64Process(process, out wow64)) throw new Win32Exception(Marshal.GetLastWin32Error());
      int size = wow64 ? 4 : IntPtr.Size;
      var data = new IntPtr[6];
      int kind = IntPtr.Size == 8 && wow64 ? 26 : 0;
      if (NtQueryInformationProcess(process, kind, data, kind == 26 ? IntPtr.Size : IntPtr.Size * data.Length, out returned) != 0)
        throw new InvalidOperationException("Cannot query Pi Chat process parameters");
      IntPtr peb = data[kind == 26 ? 0 : 1];
      var parameters = Pointer(Read(process, IntPtr.Add(peb, size == 8 ? 0x20 : 0x10), size), 0, size);
      var cwd = Read(process, IntPtr.Add(parameters, size == 8 ? 0x38 : 0x24), size == 8 ? 16 : 8);
      int length = BitConverter.ToUInt16(cwd, 0);
      if (length == 0 || length > 65532 || (length % 2) != 0) throw new InvalidOperationException("Invalid Pi Chat working-directory length");
      return Encoding.Unicode.GetString(Read(process, Pointer(cwd, size == 8 ? 8 : 4, size), length));
    }
  }
  public static bool UsesApp(int pid, string command, string root) {
    if (String.IsNullOrEmpty(command) || String.IsNullOrEmpty(root)) return false;
    // Bound/fail-closed checks apply only to possible Pi Chat owners, not
    // unrelated Node tools with many ordinary command-line arguments.
    if (command.Replace('/', Path.DirectorySeparatorChar).IndexOf(@"dist\server\server\index.js", StringComparison.OrdinalIgnoreCase) < 0) return false;
    int count; var args = CommandLineToArgvW(command, out count);
    if (args == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      if (count > 1024) throw new InvalidOperationException("Too many Pi Chat process arguments");
      for (int i = 1; i < count; i++) {
        string arg = Marshal.PtrToStringUni(Marshal.ReadIntPtr(args, i * IntPtr.Size)).Replace('/', '\\');
        if (!arg.EndsWith("dist\\server\\server\\index.js", StringComparison.OrdinalIgnoreCase)) continue;
        bool absolute = arg.Length > 2 && arg[1] == ':' && arg[2] == '\\';
        if (arg.StartsWith("\\\\", StringComparison.Ordinal)) absolute = true;
        string entry = Resolve(Path.GetFullPath(absolute ? arg : Path.Combine(WorkingDirectory(pid), arg)));
        if (entry != null && entry.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return true;
      }
      return false;
    } finally { LocalFree(args); }
  }
  [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle Open(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint FinalName(SafeFileHandle handle, StringBuilder name, uint size, uint flags);
  public static string Resolve(string path) {
    if (String.IsNullOrEmpty(path)) return null;
    using (var handle = Open(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) return null;
      var text = new StringBuilder(1024);
      uint length = FinalName(handle, text, (uint)text.Capacity, 0);
      if (length >= text.Capacity) {
        text.Capacity = (int)length + 1;
        length = FinalName(handle, text, (uint)text.Capacity, 0);
      }
      return length > 0 && length < text.Capacity ? text.ToString() : null;
    }
  }
}
'@
    }
    $pattern = [regex]::Escape($InstallRoot + '\')
    $canonicalRoot = [PiChatInstallerPaths]::Resolve($InstallRoot)
    if ($canonicalRoot) { $canonicalRoot = $canonicalRoot.TrimEnd('\') + '\' }
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
    foreach ($process in $processes) {
      $executable = [PiChatInstallerPaths]::Resolve([string]$process.ExecutablePath)
      $ownsFiles = $canonicalRoot -and $executable -and $executable.StartsWith($canonicalRoot, [StringComparison]::OrdinalIgnoreCase)
      if (-not $ownsFiles) {
        try { $ownsFiles = [PiChatInstallerPaths]::UsesApp([int]$process.ProcessId, [string]$process.CommandLine, $canonicalRoot) }
        catch {
          # A process can exit while inspected. Ignore only a confirmed exit;
          # an alive but unverifiable Pi Chat owner must block, never be killed.
          if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) { throw }
        }
      }
      if ($ownsFiles -or [string]$process.CommandLine -match $pattern -or [string]$process.ExecutablePath -match $pattern) {
        Report $false 'Pi Chat is running from this installation. Close it safely in Settings before installing or uninstalling.'
        exit 11
      }
    }
    Report $false 'Installation files are not owned by a running Node process.'
    exit 0
  }
  $existing = DetectPi
  if ($existing) {
    Report $true ('Using existing Pi ' + $existing.version + '; no upgrade or configuration copy performed.') ([string]$existing.entry) ([string]$existing.version)
    exit 0
  }
  if ($Action -eq 'Detect') {
    Report $false 'Pi is not installed. Pi Chat and its private Node are ready; install Pi optionally, or configure its entry later.'
    exit 0
  }
  $package = '@earendil-works/pi-coding-agent'
  $metadata = Invoke-RestMethod -Uri ('https://registry.npmjs.org/' + [uri]::EscapeDataString($package)) -TimeoutSec 20 -UseBasicParsing
  $version = [string]$metadata.'dist-tags'.latest
  if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw 'Pi registry version is invalid.' }
  $managed = Join-Path $env:USERPROFILE '.pi\agent\install'
  $release = Join-Path $managed ('releases\' + $version)
  $entry = Join-Path $release 'node_modules\@earendil-works\pi-coding-agent\dist\rpc-entry.js'
  if (-not (Test-Path -LiteralPath $entry)) {
    if (Test-Path -LiteralPath $release) { throw 'An incomplete Pi release directory already exists; use Pi connection settings to repair it.' }
    $staging = Join-Path $managed ('releases\.install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    $npm = Join-Path $InstallRoot 'runtime\node\node_modules\npm\bin\npm-cli.js'
    & $node $npm install --prefix $staging ($package + '@' + $version) --ignore-scripts --no-audit --no-fund --fetch-retries=1 --fetch-timeout=20000 >>$logPath 2>&1
    if ($LASTEXITCODE -ne 0) { throw ('Pi download failed. The application remains installed. Log: ' + $logPath) }
    $preparedEntry = Join-Path $staging 'node_modules\@earendil-works\pi-coding-agent\dist\rpc-entry.js'
    if (-not (Test-Path -LiteralPath $preparedEntry)) { throw 'Downloaded Pi is missing its RPC entry.' }
    Move-Item -LiteralPath $staging -Destination $release
    $staging = $null
  }
  $pointer = Join-Path $managed 'current-version'
  $temporary = $pointer + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($temporary, $version, [Text.Encoding]::ASCII)
  if (Test-Path -LiteralPath $pointer) { [IO.File]::Replace($temporary, $pointer, $null) }
  else { [IO.File]::Move($temporary, $pointer) }
  $config = Join-Path $InstallRoot 'config'
  New-Item -ItemType Directory -Force -Path $config | Out-Null
  $envFile = Join-Path $config 'runtime.env'
  $previous = if (Test-Path -LiteralPath $envFile) { @(Get-Content -LiteralPath $envFile | Where-Object { $_ -notmatch '^PI_CHAT_MANAGED_INSTALL_ROOT=' }) } else { @() }
  [IO.File]::WriteAllLines($envFile, @($previous) + @('PI_CHAT_MANAGED_INSTALL_ROOT=' + $managed), [Text.UTF8Encoding]::new($false))
  Report $true ('Installed Pi ' + $version + '. Existing credentials, Skills and sessions are unchanged.') $entry $version
} catch {
  Report $false ('Pi operation could not finish: ' + $_.Exception.Message + ' The application remains installed; retry from connection settings.')
  exit 1
} finally {
  if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
}
