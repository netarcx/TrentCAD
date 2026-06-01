# FrameCAD — Student Setup Guide

Welcome to FRC Team 2129's CAD workflow. FrameCAD is the desktop app the team uses to share SolidWorks files. You won't need to know any version-control commands, and you don't need to install Git or anything else first — just FrameCAD itself.

Total setup time: about 5 minutes.

---

## 1. What you'll need

- The FrameCAD installer (one download).
- A **Google account on your team's Workspace domain** (your `@yourschool.org` account). This is what gives you access to the team's CAD files in Google Drive.
- The **enrollment PIN or link** your CAD lead / mentor gives you (a 6-character code like `K7M2QX`). This is optional for just opening files, but you need it for Check Out / Check In and to show up correctly in publish history.

Make sure you have admin rights on the computer, or ask whoever does to run the installer.

---

## 2. Install FrameCAD

1. Go to <https://github.com/netarcx/FrameCAD/releases>
2. Find the **latest release** at the top of the page.
3. Under **Assets**, click `framecad-X.Y.Z-setup.exe` to download it.
4. Run the installer. Accept any **User Account Control (UAC)** prompts.
5. **Important:** if you have SolidWorks open, close it before installing. The installer needs to update the SolidWorks add-in and won't be able to if SolidWorks is running.
6. The installer will:
   - Install FrameCAD itself
   - Install the FrameCAD SolidWorks add-in
   - Register the add-in so SolidWorks shows it on next launch

That's the only thing you install. No Git, no GitHub CLI, nothing else.

---

## 3. First launch: profile

Open FrameCAD from the Start menu. The first time you run it, you'll see a "Profile" screen asking for your **name** and **email**. Use:
- **Name:** your real first and last name (this is what shows up next to every change you make)
- **Email:** your school email

Click **Save**.

---

## 4. Enroll with your team

Your CAD lead / mentor will give you either a **PIN link** or a **server URL + 6-character PIN**.

- If you got a link, click it — FrameCAD opens straight to the enrollment screen with the details filled in.
- Otherwise, on the welcome screen open **Enroll with Team**, paste the **server URL** (e.g. `https://framecad.yourteam.org`) and your **PIN**, then click **Enroll**.

This registers you with the team so that locks (Check Out / Check In) and publish history know who you are. It's a one-time step.

---

## 5. Sign in with Google

On the welcome screen, click **Sign in with Google**.

- Your browser opens to Google's sign-in page.
- Sign in with your **team Workspace account** (`@yourschool.org`). Personal Gmail accounts won't work — the team's Shared Drive is restricted to the school domain.
- Approve the access request. The browser will say you can close the tab.
- Back in FrameCAD, the welcome screen shows **"Signed in as you@yourschool.org"**.

This is a one-time step. After this, Sync and Publish work without prompting.

---

## 6. Join your team's project

In FrameCAD:

1. Click **Join from Google Drive**.
2. Pick your team's **Shared Drive** from the list (e.g. `FRC 2129 CAD`).
3. Pick the **project folder** inside it — that folder *is* the project.
4. Pick a folder on your PC to save it to. `Documents` is a good default.
5. Click to download.

FrameCAD downloads the project from Google Drive. If your team has a shared COTS (Commercial Off-The-Shelf) parts library configured, it comes down too.

When it's done, you're in the project view.

---

## 7. Daily workflow

This is the loop you'll use every time you work on CAD:

### Before you start working

1. Click **Sync** (top-left of the toolbar). This pulls the latest team files from Google Drive.

### To edit a part

1. Click the file in the file browser.
2. Click **Check Out** (or right-click the file → Check Out).
3. Open the file in SolidWorks and edit it.
4. Save your changes in SolidWorks (Ctrl+S).
5. Back in FrameCAD, click **Check In** to release the lock.

While a file is checked out by you, the file shows a blue dot. Nobody else on the team can edit it until you check it in. This prevents two people editing the same file and overwriting each other's work. (Locks are coordinated by the team server, which is why enrolling in step 4 matters.)

### To create a new part

1. Click **+ Part** (or **+ Assembly**) in the toolbar.
2. Optionally type a description.
3. Click **Create Part**.

FrameCAD reserves a unique part number like `26-2129-001`, then the SolidWorks add-in automatically creates a new part document with that filename. You'll see the new part open in SolidWorks ready to design.

### To publish your work

1. Click **Publish** (the up-arrow button in the toolbar).
2. Optionally type a short note about what changed. Leave blank for a random label.
3. Click **Upload**.

A progress window shows the file list and percentage. When it's done, your changes are in Google Drive and recorded in the team's publish history. Teammates will see them the next time they Sync.

---

## 8. The SolidWorks add-in

When you open SolidWorks after installing FrameCAD, you'll see a "FrameCAD" task pane on the right side. It shows:

- The current connection status (green = connected, yellow = no project open, red = FrameCAD desktop closed)
- The part number and lock status of whatever file you have open
- Buttons for Check Out / Check In / Sync / Publish / + Part — so you don't have to Alt-Tab back to the desktop app

If the task pane shows **"FrameCAD desktop app is not open"**, just open FrameCAD on the side. The add-in will detect it within 5 seconds.

If the task pane doesn't appear at all in SolidWorks:
1. In SolidWorks, go to **Tools → Add-Ins**
2. Find **FrameCAD** in the list and check both boxes (Active Add-ins + Start Up)
3. Click OK

---

## 9. Common problems

### "FrameCAD desktop app is not open"

Open FrameCAD. The add-in checks every 5 seconds. If you just opened FrameCAD but the add-in still says this, wait a moment and check the icon at the top-left — it should turn green.

### My publish is stuck at 0%

The progress modal will show you what's happening. Most likely:
- Your file is very large — FrameCAD will warn you in the modal
- Your network is slow — give it time
- Your Google sign-in expired — click **Sign in with Google** again from the welcome screen

### "The file 26-2129-001.sldprt is corrupt"

This used to happen on older FrameCAD versions. If you see it on a file you created recently, delete the file from File Explorer, then create a new part with the same number from the add-in's **+ Part** button — that uses SolidWorks's own template instead of an empty file.

### Auto-updates

FrameCAD checks for updates every time you launch it. When a new version is available, you'll see a small banner at the top with a **Restart Now** button. Click it and FrameCAD will install the update and reopen. This also updates the SolidWorks add-in — make sure SolidWorks is closed when you restart.

---

## 10. Quick reference

| Action | Button |
|--------|--------|
| Get latest team files | Sync |
| Share your changes | Publish |
| Reserve a new part number | + Part |
| Reserve a new assembly | + Assembly |
| Make a new folder | + Folder |
| Lock a file for editing | Check Out |
| Release a file | Check In |
| Go back to project picker | ← Project name in header |
| Switch dark/light | Light/Dark in top-right |

That's it. If anything's broken, ask the CAD lead — they have a Settings page (Ctrl+Shift+A, or the gear icon in the sidebar) for fixing team-wide stuff.
