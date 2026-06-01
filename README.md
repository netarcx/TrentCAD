<div align="center">

<img src="build/icon.png" width="128" alt="FrameCAD" />

# FrameCAD

**Google Drive-backed CAD collaboration that hides the plumbing behind a button.**

Built for FRC Team 2129 (Ultraviolet). SolidWorks-friendly. No CLI required.

[![Latest release](https://img.shields.io/github/v/release/netarcx/FrameCAD?style=flat-square)](https://github.com/netarcx/FrameCAD/releases/latest)
[![Build](https://img.shields.io/github/actions/workflow/status/netarcx/FrameCAD/build-installer.yml?branch=main&style=flat-square)](https://github.com/netarcx/FrameCAD/actions/workflows/build-installer.yml)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square)
![Language](https://img.shields.io/github/languages/top/netarcx/FrameCAD?style=flat-square)

[Download](#download) · [Features](#what-it-does) · [Why FrameCAD](#why-not-just-use-git) · [Developer docs](docs/DEVELOPMENT.md)

</div>

---

## What it does

FrameCAD is a desktop app that lets a robotics team collaborate on SolidWorks assemblies the same way developers collaborate on code — except your students never deal with version-control plumbing. Files live in your team's **Google Shared Drive**; on the surface it's **Sync**, **Publish**, **Check Out**, and **Check In**.

- 🔒 **Check-out / check-in locks** on every CAD file so two students can't accidentally edit the same part at the same time. Locks are coordinated by the team server, not the file store.
- 📁 **Auto part numbering** in your team's format (`YY-2129-XX-YYY`). New parts and assemblies are created pre-named — SolidWorks references never break from renames.
- 🔧 **SolidWorks task pane add-in** with the same buttons (Check Out / Check In / Sync / Publish) inside SolidWorks itself.
- 📊 **Build-season documents** generated from your CAD: Bill of Materials (CSV + PDF), Manufacturing Queue cut list (CSV + PDF), Project Summary with FRC 125 lb weight headroom (Markdown + PDF).
- 🛒 **Manufacturing queue** that groups released parts by method (3D Print / CNC / Manual / Other) and material — shop floor walks the queue in one direction.
- 🗂️ **COTS library support** — share a separate folder of off-the-shelf parts across all your team's robot projects.
- 🚦 **Pre-publish guards** catch oversized or disallowed files *before* you waste time uploading them.
- 🔑 **Role-gated settings** — admins and mentors see full team/project configuration; students see only their profile. Powered by the self-hosted team server's member roster (see [server/](server/README.md)).
- ☁️ **Your storage, your bytes** — CAD files live in your team's own Google Shared Drive (free 100 TB on Workspace for Nonprofits), so you're not metered by GitHub or anyone else.
- 🚀 **Auto-update** from GitHub Releases on Windows and Linux.

## Why not just use a shared folder?

Because a raw shared drive has no locks, no part numbering, no release workflow, and no way to stop two students from saving over each other the night before competition.

FrameCAD keeps the files in Google Drive — where your team already has storage and access control — and adds the FRC-specific structure on top: check-out/check-in locks, weight limits, manufacturing methods, part numbers, the shop's cut list, and the fact that some students design at home on their personal laptop while the rest of the team works on a school machine.

## Download

Latest installers are auto-built from `main`:

| Platform | Installer |
|---|---|
| **Windows** | [`.exe` from GitHub Releases](https://github.com/netarcx/FrameCAD/releases/latest) — auto-registers the SolidWorks add-in |
| **macOS** | [`.dmg` from GitHub Releases](https://github.com/netarcx/FrameCAD/releases/latest) — Apple Silicon + Intel. Right-click → Open the first time (unsigned). Admin-only build, no SolidWorks add-in |
| **Linux** | [`.AppImage` from GitHub Releases](https://github.com/netarcx/FrameCAD/releases/latest) — `chmod +x` and run. Admin-only build, no SolidWorks add-in |

> **SolidWorks add-in** is auto-registered by the Windows installer. The Mac and Linux builds are intended for mentors and admin work — SolidWorks itself only runs on Windows.

## Quick start

1. **Install** FrameCAD for your platform. No Git, Git LFS, or GitHub CLI required.
2. **(If your team uses a server)** open the team's enrollment PIN link, or paste the server URL + 6-character PIN into the "Enroll with Team" screen. This establishes your team identity for locks and publish history.
3. **Sign in with Google** on the welcome screen — this grants FrameCAD access to your team's Google Shared Drive.
4. Click **Join from Google Drive**: pick the team's Shared Drive, pick the project folder, choose a local save location, and FrameCAD downloads the project.
5. Open a CAD file in SolidWorks. **Check Out** before you edit it. **Check In** when you're done. **Publish** to upload your changes to Drive for the rest of the team — they'll see it the next time they **Sync**.

Setting this up for your team? See the one-time [Google Workspace setup guide](docs/google-workspace-setup.md) (create the Cloud project, OAuth credentials, and Shared Drive).

For a student-friendly walkthrough, see [docs/STUDENT_SETUP.md](docs/STUDENT_SETUP.md).

## Built for FRC teams

- **125 lb weight tracking** with live headroom callout on the status bar and in the auto-generated project summary
- **Per-part release workflow** (draft → in-review → released → manufactured) so mentors can sign off on parts before the shop cuts them
- **Cascade in-review** — marking an `.sldasm` as in-review automatically sweeps every part under that folder into the same state in one commit
- **Per-part thumbnails** rendered from the OS shell preview, plus a 200px preview in the details panel
- **Where Used** view shows every assembly a part belongs to, with one-click navigation to the parent
- **Bulk metadata editing** — multi-select parts in the Parts Manager and apply release / method / material to all of them at once
- **Mass + cost rollups** by subsystem and by manufacturing method, refreshed every five seconds while you work
- **Comments** thread per part — note your manufacturing tolerances, gotchas, or "do not edit until we settle the gear ratio"
- **Folder dirty badge** — collapsed folders show a count of unpublished files inside so changes can't hide
- **Weekly progress tags** for snapshotting CAD state at design-review milestones
- **`framecad://` deep links** so new teammates one-click into the Join-from-Drive flow
- **Accessibility**: OpenDyslexic UI font toggle (`Ctrl+Shift+D`), responsive layout that adapts down to 960×600, dark and light themes

## Documentation

- **[Developer docs (`docs/DEVELOPMENT.md`)](docs/DEVELOPMENT.md)** — architecture, dev setup, REST API reference, SolidWorks add-in build
- **[Student setup guide (`docs/STUDENT_SETUP.md`)](docs/STUDENT_SETUP.md)** — getting students onto the team's CAD projects
- **[Google Workspace setup (`docs/google-workspace-setup.md`)](docs/google-workspace-setup.md)** — one-time admin setup: Google Cloud project, OAuth credentials, and the team Shared Drive
- **[Team server (`server/README.md`)](server/README.md)** — self-host the coordination server (enrollment, locks, publish history)
- **Built-in onboarding tour** runs the first time you open the app

## Contributing

This is a small project built for one FRC team, but PRs and issues are welcome — especially if you're running FrameCAD for your own team and have hit a wall.

## License

Source-available for FRC team use. No license file is currently included — if you're a mentor on another team interested in using FrameCAD, open an issue and we'll talk.
