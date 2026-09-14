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
