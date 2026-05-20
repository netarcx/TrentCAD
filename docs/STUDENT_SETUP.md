# FrameCAD — Student Setup Guide

Welcome to FRC Team 2129's CAD workflow. FrameCAD is the desktop app the team uses to share SolidWorks files. You won't need to know Git, but you'll need to install three small tools once, then everything is one-click after that.

Total setup time: about 10 minutes.

---

## 1. What you'll install

You need **two** things on your PC, in this order:

1. **Git for Windows** — handles file history
2. **FrameCAD** — the team's actual app, which also auto-installs **GitHub CLI** in the background

Make sure you have admin rights on the computer, or ask whoever does to run the installers.

---

## 2. Install Git for Windows (includes Git LFS)

1. Go to <https://git-scm.com/download/win>
2. The download starts automatically. Run the installer when it finishes.
3. On every screen, just click **Next** — the defaults are correct.
4. ⚠️ When you see the screen **"Select Components"**, make sure **Git LFS (Large File Support)** is checked. It should be on by default. **Do not uncheck it** — SolidWorks files are huge and require LFS.
5. Finish the installer.

To verify, open the **Start menu**, type `cmd`, and press Enter. In the black window that pops up, type:

```
git --version
git lfs version
```

Both commands should print a version number. If either says "not recognized," reinstall and make sure LFS was checked.

---

## 3. Install FrameCAD

The FrameCAD installer auto-installs the GitHub CLI for you (it runs `winget install GitHub.cli` in the background, which works on Windows 10 1809 and newer / all Windows 11). If your computer doesn't have winget, FrameCAD will show a dialog with a link to install GitHub CLI manually from <https://cli.github.com>.

1. Go to <https://github.com/netarcx/FrameCAD/releases>
2. Find the **latest release** at the top of the page.
3. Under **Assets**, click `framecad-X.Y.Z-setup.exe` to download it.
4. Run the installer. Accept any **User Account Control (UAC)** prompts.
5. **Important:** if you have SolidWorks open, close it before installing. The installer needs to update the SolidWorks add-in and won't be able to if SolidWorks is running.
6. The installer will:
   - Install FrameCAD itself
   - Install the FrameCAD SolidWorks add-in
   - Register the add-in so SolidWorks shows it on next launch
   - Auto-install GitHub CLI in the background (if not already present)

---

## 4. First launch: profile and sign-in

Open FrameCAD from the Start menu. The first time you run it, three things happen:

### a) The "Required software missing" check

FrameCAD verifies Git and Git LFS are installed. If you missed either, a modal will tell you exactly what's missing with a Download button. Install whatever it asks for, then click **Check again**.

### b) Your profile

You'll see a "Profile" screen asking for your **name** and **email**. Use:
- **Name:** your real first and last name (this is what shows up next to every change you make)
- **Email:** your school email or any email you use for GitHub

Click **Save**.

### c) Sign in to GitHub

On the welcome screen (where you can Create / Join / Open a project), there's a row at the top with a **"Sign in with GitHub"** button. Click it.

- A black `cmd` window will pop up showing a short code (something like `WXYZ-1234`).
- Your browser will open to <https://github.com/login/device>.
- Type the code from the cmd window into the browser page.
- Sign in to your GitHub account, then click **Authorize github**.
- The cmd window will say "Logged in as ..." — close it.
- Back in FrameCAD, click **Check sign-in**. The row should turn green and say **"Signed in to GitHub as <your-username>"**.

This is a one-time step. After this, every Download/Upload works without prompting.

---

## 5. Join your team's project

Ask whoever set up the project (your team's CAD lead or admin) for the **GitHub URL**. It looks like:

```
https://github.com/netarcx/2026-robot.git
```

In FrameCAD:

1. Click **Join Project**.
2. Paste the GitHub URL.
3. Pick a folder to save the project to. `Documents` is a good default.
4. Click **Join**.

FrameCAD will download the project. If your team has a shared COTS (Commercial Off-The-Shelf) parts library configured, it downloads that too automatically into a `COTS/` subfolder.

When it's done, you're in the project view.

---

## 6. Daily workflow

This is the loop you'll use every time you work on CAD:

### Before you start working

1. Click **Download** (top-left of the toolbar). This pulls the latest team files.

### To edit a part

1. Click the file in the file browser.
2. Click **Check Out** (or right-click the file → Check Out).
3. Open the file in SolidWorks and edit it.
4. Save your changes in SolidWorks (Ctrl+S).
5. Back in FrameCAD, click **Check In** to release the lock.

While a file is checked out by you, the file shows a blue dot. Nobody else on the team can edit it until you check it in. This prevents two people editing the same file and overwriting each other's work.

### To create a new part

1. Click **+ Part** (or **+ Assembly**) in the toolbar.
2. Optionally type a description.
3. Click **Create Part**.

FrameCAD reserves a unique part number like `26-2129-001`, then the SolidWorks add-in automatically creates a new part document with that filename. You'll see the new part open in SolidWorks ready to design.

### To upload your work

1. Click **Upload** (the up-arrow button in the toolbar).
2. Optionally type a short note about what changed. Leave blank for a random label.
3. Click **Upload**.

A progress window shows the file list and percentage. When it says "Upload complete," your work is on GitHub. Teammates will see it the next time they Download.

---

## 7. The SolidWorks add-in

When you open SolidWorks after installing FrameCAD, you'll see a "FrameCAD" task pane on the right side. It shows:

- The current connection status (green = connected, yellow = no project open, red = FrameCAD desktop closed)
- The part number and lock status of whatever file you have open
- Buttons for Check Out / Check In / Download / Upload / + Part — so you don't have to Alt-Tab back to the desktop app

If the task pane shows **"FrameCAD desktop app is not open"**, just open FrameCAD on the side. The add-in will detect it within 5 seconds.

If the task pane doesn't appear at all in SolidWorks:
1. In SolidWorks, go to **Tools → Add-Ins**
2. Find **FrameCAD** in the list and check both boxes (Active Add-ins + Start Up)
3. Click OK

---

## 8. Common problems

### "FrameCAD desktop app is not open"

Open FrameCAD. The add-in checks every 5 seconds. If you just opened FrameCAD but the add-in still says this, wait a moment and check the icon at the top-left — it should turn green.

### My upload is stuck at 0%

The progress modal will show you what's happening. Most likely:
- Your file is very large (over 100 MB) — FrameCAD will warn you in the modal
- Your network is slow — give it time
- Your GitHub login expired — click **Sign in with GitHub** again from the welcome screen

### "The file 26-2129-001.sldprt is corrupt"

This used to happen on older FrameCAD versions (pre-0.4.7). If you see it on a file you created recently, delete the file from File Explorer, then create a new part with the same number from the add-in's **+ Part** button — that uses SolidWorks's own template instead of an empty file.

### Auto-updates

FrameCAD checks for updates every time you launch it. When a new version is available, you'll see a small banner at the top with a **Restart Now** button. Click it and FrameCAD will install the update and reopen. This also updates the SolidWorks add-in — make sure SolidWorks is closed when you restart.

---

## 9. Quick reference

| Action | Button |
|--------|--------|
| Get latest team files | Download |
| Share your changes | Upload |
| Reserve a new part number | + Part |
| Reserve a new assembly | + Assembly |
| Make a new folder | + Folder |
| Lock a file for editing | Check Out |
| Release a file | Check In |
| Go back to project picker | ← Project name in header |
| Switch dark/light | Light/Dark in top-right |

That's it. If anything's broken, ask the CAD lead — they have a Settings page (Ctrl+Shift+A, or the gear icon in the sidebar) for fixing team-wide stuff.
