# Windows release checks

These checks deliberately separate the installer shell from the WSL runtime.

## Current Windows host

```powershell
./Test-PiCadInstaller.ps1
```

This verifies the PE, signature state, silent installation, installed files,
shortcuts, launch, and uninstall metadata. It does not alter an existing
installation unless `-Install` is supplied.

## Windows Sandbox

Run from an elevated PowerShell prompt:

```powershell
./Open-PiCadSandbox.ps1
```

The installer directory is mounted read-only. Results are written to
`release/sandbox-results`. The Sandbox checks install, first launch, shortcuts,
uninstall metadata, and the setup screen at 100%, 125%, and 150% scale-sized
windows. Closing Sandbox discards its installed state.

## Clean Windows VM

Create a Windows 11 Hyper-V VM with nested virtualization, then copy the setup
file and `Invoke-PiCadCleanMachine.ps1` into it. Run:

```powershell
./Invoke-PiCadCleanMachine.ps1 -InstallWsl
```

The script records every machine-readable checkpoint. UAC, restart, Ubuntu's
first initialization, ChatGPT sign-in, and the final flowerpot task remain
visible human checkpoints because hiding them would not test the user path.

The acceptance run is complete only when `clean-machine-result.json` contains:

- installer and app launch passed;
- Ubuntu and WSL 2 ready after restart;
- bundled runtime ready;
- ChatGPT signed in;
- a project was created from the app;
- streamed model state and tool cards appeared;
- a flowerpot STEP opened in the 3D viewer;
- reopening the app restored the task;
- uninstall preserved the project.
