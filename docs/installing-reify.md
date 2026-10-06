# Installing and updating Reify Desktop

Reify Desktop currently targets Windows 11 x64 with WSL 2 Ubuntu, Ubuntu 22.04/24.04 x64, and macOS 14+ on Apple silicon. Other Linux distributions and Intel macOS builds are not declared supported until exercised on those systems.

Projects live wherever the user chooses. Application preferences and credentials live in the operating system user-data directory, and the engineering runtime lives under the user's local data directory. Removing or replacing the application does not remove projects. Data deletion is a separate manual action.

## Windows

Use the signed NSIS installer for a normal installation or the Portable build only when an organization explicitly permits it. Reify detects the configured WSL distribution by exact name. Existing initialized Ubuntu environments are reused; missing WSL, missing distribution, and uninitialized distribution are separate recoverable states. WSL enables the isolated Linux CAD and authority runtime. Enabling WSL can require administrator approval and a Windows restart; Reify persists setup choices and checks again after restart.

Finish or stop an active Agent task before installing a newer version. Run the new installer through the same channel. The uninstaller preserves user data and projects. Keep the previous signed installer for manual rollback when the release notes declare the project schema compatible.

## Ubuntu deb

Install `Reify-Linux-amd64.deb` with the system package manager. The package supplies the Reify icon and desktop entry. The base CAD runtime is prepared separately from optional ParaView, Blender, and simulation components. Retry dependency setup from Settings after resolving network or package-manager permission errors.

Upgrade with a newer deb through the package manager. Do not switch an existing installation automatically to AppImage. For rollback, reinstall the previous deb only when its release manifest declares the existing project schema readable.

## Ubuntu AppImage

Mark `Reify-Linux-x86_64.AppImage` executable and run it. If FUSE is unavailable, use the AppImage extract-and-run option documented by the target system. Desktop integration is an explicit user choice. The AppImage file is separate from user data and project files, so moving or deleting it does not remove either.

Update by downloading a newer AppImage after stopping active tasks, verifying its published SHA-256, and replacing the application file. Keep the previous verified file for rollback. Do not mix AppImage and deb update instructions.

## macOS

The public DMG must be Developer ID signed and Apple notarized. Copy Reify to Applications, then start it normally. The release pipeline treats missing certificate, Apple ID, app-specific password, or team ID as a release blocker; disabling Gatekeeper is not an installation method. Native author and reviewer processes retain separate authority boundaries.

Quit active Agent work before replacing the app from a newer signed and notarized DMG. Keep the prior notarized DMG for compatible rollback. Removing the app preserves projects and user data.

## Optional FreeCAD part backend

The `cad.part` Python API builds parametric parts in FreeCAD (Part Design). It is optional. The build123d path (`cad.model.build`) works without it.

Install it with one command from the repository root:

```bash
npm run setup:freecad            # add -- --force to reinstall
```

The script supports Linux x86_64 (including WSL) and macOS arm64. It needs no sudo. It does not change shell configuration files. It downloads a pinned micromamba from conda-forge (SHA-256 checked), creates a private conda environment from the lock file in `python/runtimes/freecad/`, runs a smoke test (Pad, Pocket, Fillet, STEP export), and writes `runtime.json`.

| Item | Location |
|---|---|
| Linux / WSL | `${XDG_DATA_HOME:-~/.local/share}/pi-cad/runtimes/freecad` |
| macOS | `~/Library/Application Support/pi-cad/runtimes/freecad` |
| Override | `PI_CAD_FREECAD_HOME` (install) and `PI_CAD_FREECAD_PYTHON` (use another FreeCAD Python at run time) |

Check the result with `python -m cadctl doctor --json`. The `freecad` entry shows `ready`, `unavailable`, or `error`. Without the backend, `cad.part` calls fail with `FREECAD_NOT_INSTALLED` and the message `run: npm run setup:freecad`. The API never downloads FreeCAD by itself.

Disk use: about 4.2 GB (measured with FreeCAD 1.1.0 on Linux x86_64, after the download cache is cleaned). To uninstall, delete the `freecad` directory from the table above.

The osx-arm64 lock file was solved on Linux (`CONDA_OVERRIDE_OSX=11.0`) and has not been install-tested on a Mac. If it fails, the script prints the error. Delete the lock file to make the script solve `environment.yml` instead.
