# This launcher is intentionally used only by scripts/run-tests.mjs on Windows.
# It starts the Node test harness suspended, places it in a constrained Job, and
# only then resumes it. Descendants inherit that Job automatically, while the
# caller's production Pi Chat service is never a member of it.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$NodePath,

  [Parameter(Mandatory = $true)]
  [string]$WorkingDirectory,

  [Parameter(Mandatory = $true)]
  [string]$NodeArgumentsBase64,

  [Parameter(Mandatory = $true)]
  [ValidateRange(512, 16384)]
  [int]$MemoryLimitMiB
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

try {
  $argumentsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($NodeArgumentsBase64))
  $NodeArguments = [string[]](ConvertFrom-Json -InputObject $argumentsJson)
  if ($NodeArguments.Count -eq 0) {
    throw "Node arguments must be a non-empty JSON string array"
  }
} catch {
  [Console]::Error.WriteLine("PI_CHAT_TEST_JOB_SETUP_FAILED: invalid test-runner arguments: $($_.Exception.Message)")
  exit 70
}

$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace PiChat.Testing
{
    public static class WindowsTestJob
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const int JobObjectAssociateCompletionPortInformation = 7;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO = 4;
        private const uint JOB_OBJECT_MSG_JOB_MEMORY_LIMIT = 10;
        private const uint ERROR_NOT_ENOUGH_MEMORY = 8;
        private const uint INFINITE = 0xffffffff;
        private const uint WAIT_OBJECT_0 = 0;
        private const uint WAIT_FAILED = 0xffffffff;
        private const uint INVALID_THREAD_RESULT = 0xffffffff;
        private const int STD_INPUT_HANDLE = -10;
        private const int STD_OUTPUT_HANDLE = -11;
        private const int STD_ERROR_HANDLE = -12;

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimitInformation
        {
            // Windows declares JOBOBJECT_BASIC_LIMIT_INFORMATION before
            // IO_COUNTERS. This layout is ABI-significant: reversing the two
            // makes the operating system read LimitFlags as zero.
            public BasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct AssociateCompletionPort
        {
            public IntPtr CompletionKey;
            public IntPtr CompletionPort;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength,
            IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateIoCompletionPort(
            IntPtr fileHandle,
            IntPtr existingCompletionPort,
            UIntPtr completionKey,
            uint numberOfConcurrentThreads);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetQueuedCompletionStatus(
            IntPtr completionPort,
            out uint numberOfBytes,
            out UIntPtr completionKey,
            out IntPtr overlapped,
            uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref StartupInfo startupInfo,
            out ProcessInformation processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetStdHandle(int standardHandle);

        private static void ThrowLastError(string operation)
        {
            int error = Marshal.GetLastWin32Error();
            throw new InvalidOperationException(
                operation + " failed (Win32 " + error + "): " + new Win32Exception(error).Message);
        }

        private static string QuoteArgument(string value)
        {
            if (value.Length == 0) return "\"\"";
            bool quote = false;
            for (int index = 0; index < value.Length; index += 1)
            {
                if (char.IsWhiteSpace(value[index]) || value[index] == '\"') { quote = true; break; }
            }
            if (!quote) return value;

            var quoted = new StringBuilder();
            quoted.Append('\"');
            int backslashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { backslashes += 1; continue; }
                if (character == '\"')
                {
                    quoted.Append('\\', backslashes * 2 + 1);
                    quoted.Append(character);
                    backslashes = 0;
                    continue;
                }
                quoted.Append('\\', backslashes);
                backslashes = 0;
                quoted.Append(character);
            }
            quoted.Append('\\', backslashes * 2);
            quoted.Append('\"');
            return quoted.ToString();
        }

        public static int Run(
            string nodePath,
            string workingDirectory,
            string[] nodeArguments,
            long memoryLimitBytes,
            string label)
        {
            IntPtr job = IntPtr.Zero;
            IntPtr completionPort = IntPtr.Zero;
            ProcessInformation processInformation = new ProcessInformation();
            Thread monitor = null;
            ManualResetEvent terminalNotification = null;
            int memoryLimitExceeded = 0;
            bool processCreated = false;
            bool processResumed = false;
            try
            {
                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) ThrowLastError("CreateJobObject");

                var limits = new ExtendedLimitInformation();
                limits.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                limits.JobMemoryLimit = new UIntPtr((ulong)memoryLimitBytes);
                IntPtr limitsBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ExtendedLimitInformation)));
                try
                {
                    Marshal.StructureToPtr(limits, limitsBuffer, false);
                    uint extendedLimitSize = (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation));
                    if (!SetInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        limitsBuffer,
                        extendedLimitSize))
                        ThrowLastError("SetInformationJobObject(JobMemoryLimit)");
                    // Read back the kernel's view before a test process exists.
                    // This turns accidental P/Invoke layout drift into a clear
                    // setup failure instead of silently running without a cap.
                    if (!QueryInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        limitsBuffer,
                        extendedLimitSize,
                        IntPtr.Zero))
                        ThrowLastError("QueryInformationJobObject(JobMemoryLimit)");
                    var applied = (ExtendedLimitInformation)Marshal.PtrToStructure(
                        limitsBuffer,
                        typeof(ExtendedLimitInformation));
                    uint requiredLimits = JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    if ((applied.BasicLimitInformation.LimitFlags & requiredLimits) != requiredLimits ||
                        applied.JobMemoryLimit.ToUInt64() != (ulong)memoryLimitBytes)
                        throw new InvalidOperationException("Windows Job memory limits did not round-trip");
                }
                finally
                {
                    Marshal.FreeHGlobal(limitsBuffer);
                }

                var commandLine = new StringBuilder(QuoteArgument(nodePath));
                foreach (string argument in nodeArguments)
                {
                    commandLine.Append(' ');
                    commandLine.Append(QuoteArgument(argument));
                }
                var startup = new StartupInfo
                {
                    cb = Marshal.SizeOf(typeof(StartupInfo)),
                    dwFlags = STARTF_USESTDHANDLES,
                    hStdInput = GetStdHandle(STD_INPUT_HANDLE),
                    hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE),
                    hStdError = GetStdHandle(STD_ERROR_HANDLE),
                };
                if (!CreateProcess(
                    nodePath,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CREATE_SUSPENDED,
                    IntPtr.Zero,
                    workingDirectory,
                    ref startup,
                    out processInformation))
                    ThrowLastError("CreateProcess(test runner suspended)");
                processCreated = true;

                if (!AssignProcessToJobObject(job, processInformation.hProcess))
                    ThrowLastError("AssignProcessToJobObject(test runner)");

                // Associate only after the suspended process is a Job member.
                // That avoids accepting the Job's initial empty notification as
                // the terminal state before the test runner can be resumed.
                completionPort = CreateIoCompletionPort(
                    new IntPtr(-1),
                    IntPtr.Zero,
                    new UIntPtr(1),
                    1);
                if (completionPort == IntPtr.Zero) ThrowLastError("CreateIoCompletionPort");

                var completionAssociation = new AssociateCompletionPort
                {
                    CompletionKey = new IntPtr(1),
                    CompletionPort = completionPort,
                };
                IntPtr associationBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(AssociateCompletionPort)));
                try
                {
                    Marshal.StructureToPtr(completionAssociation, associationBuffer, false);
                    if (!SetInformationJobObject(
                        job,
                        JobObjectAssociateCompletionPortInformation,
                        associationBuffer,
                        (uint)Marshal.SizeOf(typeof(AssociateCompletionPort))))
                        ThrowLastError("SetInformationJobObject(CompletionPort)");
                }
                finally
                {
                    Marshal.FreeHGlobal(associationBuffer);
                }
                terminalNotification = new ManualResetEvent(false);

                monitor = new Thread(delegate()
                {
                    while (true)
                    {
                        uint message;
                        UIntPtr key;
                        IntPtr overlapped;
                        if (!GetQueuedCompletionStatus(
                            completionPort,
                            out message,
                            out key,
                            out overlapped,
                            INFINITE))
                            return;
                        if (message == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT)
                        {
                            Interlocked.Exchange(ref memoryLimitExceeded, 1);
                            terminalNotification.Set();
                            TerminateJobObject(job, ERROR_NOT_ENOUGH_MEMORY);
                            return;
                        }
                        if (message == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO)
                        {
                            terminalNotification.Set();
                            return;
                        }
                    }
                });
                monitor.IsBackground = true;
                monitor.Start();

                if (ResumeThread(processInformation.hThread) == INVALID_THREAD_RESULT)
                    ThrowLastError("ResumeThread(test runner)");
                processResumed = true;
                uint waitResult = WaitForSingleObject(processInformation.hProcess, INFINITE);
                if (waitResult == WAIT_FAILED)
                    ThrowLastError("WaitForSingleObject(test runner)");
                if (waitResult != WAIT_OBJECT_0)
                    throw new InvalidOperationException("Test runner wait ended without process completion");
                // Do not classify a clean child exit until the Job itself has
                // reported either an empty process tree or a memory-limit event.
                // This fences a late completion-port notification from turning a
                // constrained OOM into a false success.
                if (!terminalNotification.WaitOne(5000))
                    throw new InvalidOperationException("Windows Job completion was not confirmed after test runner exit");

                uint exitCode;
                if (!GetExitCodeProcess(processInformation.hProcess, out exitCode))
                    ThrowLastError("GetExitCodeProcess(test runner)");
                if (Interlocked.CompareExchange(ref memoryLimitExceeded, 0, 0) != 0)
                {
                    Console.Error.WriteLine(
                        "PI_CHAT_TEST_MEMORY_LIMIT_EXCEEDED: Job memory limit " +
                        memoryLimitBytes + " bytes reached while running " + label + ".");
                    return 8;
                }
                return unchecked((int)exitCode);
            }
            finally
            {
                if (completionPort != IntPtr.Zero) CloseHandle(completionPort);
                if (monitor != null) monitor.Join(1000);
                if (terminalNotification != null) terminalNotification.Dispose();
                // Assignment occurs before resume. If assignment itself fails, a
                // suspended process is outside the Job, so terminate it directly
                // rather than leaking an unreachable frozen Node process.
                if (processCreated && !processResumed && processInformation.hProcess != IntPtr.Zero)
                    TerminateProcess(processInformation.hProcess, 1);
                if (processInformation.hThread != IntPtr.Zero) CloseHandle(processInformation.hThread);
                if (processInformation.hProcess != IntPtr.Zero) CloseHandle(processInformation.hProcess);
                if (job != IntPtr.Zero) CloseHandle(job);
            }
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
  $memoryLimitBytes = [int64]$MemoryLimitMiB * 1MB
  $exitCode = [PiChat.Testing.WindowsTestJob]::Run(
    $NodePath,
    $WorkingDirectory,
    [string[]]$NodeArguments,
    $memoryLimitBytes,
    "Node test runner"
  )
  exit $exitCode
} catch {
  [Console]::Error.WriteLine("PI_CHAT_TEST_JOB_SETUP_FAILED: $($_.Exception.Message)")
  exit 70
}
