using System;
using System.Runtime.InteropServices;

[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
public class CodexActivationManager { }

[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICodexActivationManager {
    int ActivateApplication(
        [In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [In, MarshalAs(UnmanagedType.LPWStr)] string arguments,
        [In] uint options,
        [Out] out uint processId);
}

public static class CodexActivator {
    public static int Activate(string aumid, string args, out uint processId) {
        var mgr = (ICodexActivationManager)(new CodexActivationManager());
        return mgr.ActivateApplication(aumid, args, 0, out processId);
    }
}
