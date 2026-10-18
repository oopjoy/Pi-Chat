; App + private Node + a fallback Pi snapshot are embedded. Existing Pi is reused.
#ifndef SetupAppId
  #define SetupAppId "PiChat.Desktop"
#endif
[Setup]
AppId={#SetupAppId}
AppName=Pi Chat
AppVersion={#AppVersion}
AppPublisher=oopjoy
AppPublisherURL=https://github.com/oopjoy/Pi-Chat
DefaultDirName={localappdata}\PiChat
DefaultGroupName=Pi Chat
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
DisableDirPage=no
DisableProgramGroupPage=yes
LicenseFile={#PayloadRoot}\app\LICENSE
SetupIconFile={#PayloadRoot}\app\resources\icons\pi-chat.ico
UninstallDisplayIcon={app}\app\resources\icons\pi-chat.ico
OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
Compression=lzma2/fast
SolidCompression=no
DiskSpanning=no
CloseApplications=no
RestartApplications=no
RestartIfNeededByRun=no
SetupLogging=yes

[Tasks]
Name: desktopicon; Description: "Create a desktop Web shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#PayloadRoot}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\runtime\node\*"; DestDir: "{app}\runtime\node"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\runtime\pi\*"; DestDir: "{app}\runtime\pi"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\app\scripts\pi-chat-setup.ps1"; Flags: dontcopy

[InstallDelete]
; Retire only known legacy entry points, never an arbitrary application tree.
Type: files; Name: "{app}\app\pi-chat-setup.cmd"
Type: files; Name: "{app}\app\scripts\pi-chat-uninstall.ps1"

[Icons]
Name: "{group}\Pi Chat"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\app\start-pi-chat-ui.ps1"" web"; WorkingDir: "{app}\app"; IconFilename: "{app}\app\resources\icons\pi-chat.ico"
Name: "{group}\Pi Chat Web"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\app\start-pi-chat-ui.ps1"" web"; WorkingDir: "{app}\app"; IconFilename: "{app}\app\resources\icons\pi-chat.ico"
Name: "{group}\Pi Chat PWA"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\app\start-pi-chat-ui.ps1"" pwa"; WorkingDir: "{app}\app"; IconFilename: "{app}\app\resources\icons\pi-chat.ico"
Name: "{app}\Pi Chat Web"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\app\start-pi-chat-ui.ps1"" web"; WorkingDir: "{app}\app"; IconFilename: "{app}\app\resources\icons\pi-chat.ico"
Name: "{autodesktop}\Pi Chat Web"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\app\start-pi-chat-ui.ps1"" web"; WorkingDir: "{app}\app"; IconFilename: "{app}\app\resources\icons\pi-chat.ico"; Tasks: desktopicon

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\app\start-pi-chat-ui.ps1"" web"; WorkingDir: "{app}\app"; Description: "Open Pi Chat in the default browser"; Flags: postinstall skipifsilent nowait

[UninstallDelete]
Type: files; Name: "{app}\config\runtime.env"
Type: dirifempty; Name: "{app}\config"

[Code]
var
  PiFound: Boolean;
  PiMessage: String;

function RunHelper(const ScriptPath, Action, ResultPath: String): Integer;
var Code: Integer;
begin
  DeleteFile(ResultPath);
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ScriptPath +
    '" -Action ' + Action + ' -InstallRoot "' + ExpandConstant('{app}') +
    '" -ResultFile "' + ResultPath + '"', '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Code := 12;
  Result := Code;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var IniPath: String;
begin
  ExtractTemporaryFile('pi-chat-setup.ps1');
  IniPath := ExpandConstant('{tmp}\pi-running.ini');
  if RunHelper(ExpandConstant('{tmp}\pi-chat-setup.ps1'), 'CheckRunning', IniPath) <> 0 then
    Result := GetIniString('Pi', 'Message', 'Cannot verify running processes. Close this installation before continuing.', IniPath)
  else Result := '';
end;

function ShortcutLooksLikeLegacySetupPiChat(const LinkPath: String): Boolean;
var
  Shell, Shortcut: Variant;
  Target, Args, WorkDir, ExpectedScript, ExpectedDir: String;
begin
  Result := False;
  if not FileExists(LinkPath) then Exit;
  try
    Shell := CreateOleObject('WScript.Shell');
    Shortcut := Shell.CreateShortcut(LinkPath);
    // A Variant property is not implicitly a String for LowerCase here.
    Target := LowerCase(String(Shortcut.TargetPath));
    Args := LowerCase(String(Shortcut.Arguments));
    WorkDir := LowerCase(String(Shortcut.WorkingDirectory));
    ExpectedScript := LowerCase(ExpandConstant('{app}\app\start-pi-chat-ui.ps1'));
    ExpectedDir := LowerCase(ExpandConstant('{app}\app'));
    // Shortcuts may write either separator, so normalise before matching.
    // StringChangeEx edits in place; StringReplace is unavailable in this script engine.
    StringChangeEx(Args, '/', '\', False);
    StringChangeEx(ExpectedScript, '/', '\', False);
    StringChangeEx(ExpectedDir, '/', '\', False);
    StringChangeEx(WorkDir, '/', '\', False);
    Result := (Pos('powershell.exe', Target) > 0)
      and (Pos(ExpectedScript, Args) > 0)
      and (WorkDir = ExpectedDir)
      and (Pos(' pwa', ' ' + Args) = 0);
  except
    Result := False;
  end;
end;

procedure DeleteLegacyDesktopPiChatShortcut;
var
  LinkPath: String;
begin
  LinkPath := ExpandConstant('{autodesktop}\Pi Chat.lnk');
  if ShortcutLooksLikeLegacySetupPiChat(LinkPath) then
    DeleteFile(LinkPath);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var DetectPath, InstallPath, LegacyPath: String;
begin
  if CurStep = ssPostInstall then begin
    DeleteLegacyDesktopPiChatShortcut;
    DetectPath := ExpandConstant('{tmp}\pi-detect.ini');
    RunHelper(ExpandConstant('{app}\app\scripts\pi-chat-setup.ps1'), 'Detect', DetectPath);
    PiFound := GetIniString('Pi', 'Found', '0', DetectPath) = '1';
    PiMessage := GetIniString('Pi', 'Message', 'Pi not ready. The application is installed; configure Pi connection later.', DetectPath);
    if not PiFound then begin
      InstallPath := ExpandConstant('{tmp}\pi-install.ini');
      RunHelper(ExpandConstant('{app}\app\scripts\pi-chat-setup.ps1'), 'InstallPi', InstallPath);
      PiFound := GetIniString('Pi', 'Found', '0', InstallPath) = '1';
      PiMessage := GetIniString('Pi', 'Message', PiMessage, InstallPath);
    end;
    Log(PiMessage);
    if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Pi Chat', 'InstallLocation', LegacyPath) and
      (CompareText(RemoveBackslashUnlessRoot(LegacyPath), RemoveBackslashUnlessRoot(ExpandConstant('{app}'))) = 0) then
      RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Pi Chat');
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
    WizardForm.FinishedLabel.Caption := 'Pi Chat is installed with a bundled Node.js 24.22.0 LTS runtime (used when the machine has no Node 22.19+).' + #13#10 + #13#10 + PiMessage + #13#10 + #13#10 +
      'No credentials, Skills or Session files were copied or deleted. Another running Pi Chat build must be closed before this one can use port 30170.';
end;

function InitializeUninstall: Boolean;
var IniPath, ScriptPath: String;
begin
  ScriptPath := ExpandConstant('{app}\app\scripts\pi-chat-setup.ps1');
  IniPath := ExpandConstant('{tmp}\pi-uninstall-check.ini');
  if FileExists(ScriptPath) then begin
    Result := RunHelper(ScriptPath, 'CheckRunning', IniPath) = 0;
    if not Result then SuppressibleMsgBox(GetIniString('Pi', 'Message', 'Cannot safely uninstall while this installation is running.', IniPath), mbError, MB_OK, IDOK);
  end else Result := not FileExists(ExpandConstant('{app}\runtime\node\node.exe'));
end;
