using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using FrameCAD.SolidWorksAddin.Models;

namespace FrameCAD.SolidWorksAddin
{
    public class TaskPaneControl : UserControl
    {
        private readonly FrameCadApiClient _api = new FrameCadApiClient();
        private Timer _healthTimer;
        private Timer _messageClearTimer;
        private string _currentFilePath;
        private bool _busy;
        private bool _disposed;

        // Most-recently-fetched coordination-repo role for the current user.
        // Default { Configured = false } makes IsMentor/IsAdmin true — so a
        // standalone install (no coord repo) doesn't accidentally gate anyone
        // out, and we open at most-permissive until we know better.
        private CoordStateDto _coordState = new CoordStateDto { Configured = false };

        // Shop-floor operator initials, prompted once per session when the
        // user first marks a part manufactured. Mirrors the desktop kiosk's
        // operator bar so attribution is consistent across surfaces.
        private string _operatorInitials = "";

        // Latest fetched metadata for the active file — kept so the
        // "View all" comments link can show the full thread without a
        // re-fetch round-trip.
        private PartMetaDto _currentMeta;

        // ToolTip provider for the action buttons. Owns its own
        // lifetime tied to the control's Dispose.
        private readonly ToolTip _toolTip = new ToolTip { AutoPopDelay = 8000, InitialDelay = 350, ReshowDelay = 200 };

        private const int Pad = 12;
        private const int BtnHeight = 44;
        private const int BtnGap = 6;
        private const int SectionGap = 20;
        private const int HeaderHeight = 48;
        private const int LogoSize = 32;

        // Slate Grey + Purple
        static readonly Color CBase = Color.FromArgb(28, 31, 38);
        static readonly Color CMantle = Color.FromArgb(22, 25, 32);
        static readonly Color CSurface0 = Color.FromArgb(40, 44, 52);
        static readonly Color CSurface1 = Color.FromArgb(53, 58, 69);
        static readonly Color COverlay0 = Color.FromArgb(107, 112, 128);
        static readonly Color CSubtext = Color.FromArgb(160, 165, 180);
        static readonly Color CText = Color.FromArgb(220, 223, 230);
        static readonly Color CBlue = Color.FromArgb(167, 139, 250);
        static readonly Color CGreen = Color.FromArgb(134, 239, 172);
        static readonly Color CRed = Color.FromArgb(251, 113, 133);
        static readonly Color CYellow = Color.FromArgb(252, 211, 77);

        private StatusDot _dot;
        private Label _lblConnection;
        private Panel _pnlConnection;
        private PictureBox _logo;
        private Label _title;

        private Panel _pnlFileCard;
        private Label _lblFileName;
        private Label _lblPartNumber;
        private Label _lblDescription;
        private Label _lblStatus;
        private Label _lblLockedBy;
        // Warning shown when the active file's name doesn't include its
        // FrameCAD part number — likely the user did a Save As and broke
        // the parts.json link to this file
        private Label _lblRenameWarning;

        private Button _btnCheckOut, _btnCheckIn;
        private Button _btnSync, _btnPublish;
        private Button _btnNewPart;
        private Button _btnOpenApp;
        private Label _lblMessage;

        // Per-part metadata panel (release state + comments + material)
        private Panel _pnlMeta;
        private Label _lblReleaseLabel;
        private ComboBox _cmbReleaseState;
        private Label _lblMaterialLabel;
        private Label _lblMaterialValue;
        private Button _btnUseSwMaterial;
        private Label _lblMethodLabel;
        private ComboBox _cmbMfgMethod;
        private Label _lblCommentsLabel;
        private ListBox _lstComments;
        private TextBox _txtComment;
        private Button _btnAddComment;
        // Single-line manufacturing-notes summary inside the meta panel.
        // Hidden when no notes are set; ToolTip on hover shows the full text.
        private Label _lblMfgNotes;
        // Two meta-panel heights captured at construction so showing /
        // hiding the notes line only changes the panel size, not the
        // y-position of every control inside.
        private int _metaBaseHeight;
        private int _metaHeightWithNotes;
        // True while we're programmatically setting the combo from
        // freshly-loaded metadata — suppresses the SelectedIndexChanged
        // handler from re-saving the state right back to the server.
        private bool _suppressReleaseChange;
        private bool _suppressMethodChange;

        // "Newer version available" banner shown when origin has a commit
        // ahead of HEAD that touched the active document
        private Panel _pnlNewerVersion;
        private Label _lblNewerVersion;
        private Button _btnDownloadNewer;

        // "Fill title block" button — only meaningful for drawings, hidden otherwise
        private Button _btnFillTitleBlock;

        /// <summary>
        /// Read the SolidWorks-assigned material name for the active document.
        /// Wired by SwAddin so TaskPaneControl can ask without holding a SW
        /// API reference. Returns empty string on any failure.
        /// </summary>
        public Func<string> OnGetActiveDocMaterial;

        /// <summary>
        /// Write a set of values to the active drawing's custom properties.
        /// Returns the count successfully written. Wired by SwAddin.
        /// </summary>
        public Func<System.Collections.Generic.IDictionary<string, string>, int> OnFillTitleBlock;

        /// <summary>
        /// Called by SwAddin's FileSavePostNotify hook with the part's
        /// new mass (in pounds). Pushes to FrameCAD's REST API in the
        /// background — fire-and-forget so SW's save event isn't blocked.
        /// Failures are silently ignored; the user can still set mass
        /// manually if the auto-push misses.
        /// </summary>
        public async void NotifyPartMassFromSwAsync(string absolutePath, double massPounds)
        {
            if (string.IsNullOrEmpty(absolutePath) || massPounds <= 0) return;
            try { await _api.SetPartMassAutoAsync(absolutePath, massPounds); }
            catch { /* silent — SW save must not be blocked by network issues */ }
        }

        public TaskPaneControl()
        {
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96F, 96F);
            SetStyle(ControlStyles.OptimizedDoubleBuffer, true);
            BackColor = CBase;
            AutoScroll = true;
            BuildUI();
            Resize += (s, e) => LayoutAll();
        }

        private void BuildUI()
        {
            SuspendLayout();
            // --- Header ---
            var version = System.Reflection.Assembly.GetExecutingAssembly().GetName().Version;

            try
            {
                var dllDir = System.IO.Path.GetDirectoryName(
                    System.Reflection.Assembly.GetExecutingAssembly().Location);
                var logoPath = System.IO.Path.Combine(dllDir ?? "", "logo.png");
                if (System.IO.File.Exists(logoPath))
                {
                    var ms = new System.IO.MemoryStream();
                    using (var fs = System.IO.File.OpenRead(logoPath))
                        fs.CopyTo(ms);
                    ms.Position = 0;
                    _logo = new PictureBox
                    {
                        Image = Image.FromStream(ms),
                        SizeMode = PictureBoxSizeMode.Zoom,
                        Size = new Size(LogoSize, LogoSize),
                        Location = new Point(Pad, 8),
                        BackColor = Color.Transparent
                    };
                    Controls.Add(_logo);
                }
            }
            catch { /* missing logo is non-fatal */ }

            _title = new Label
            {
                Text = $"FrameCAD v{version.Major}.{version.Minor}.{version.Build}",
                Font = new Font("Segoe UI Semibold", 11f),
                ForeColor = CText,
                Location = new Point(Pad + LogoSize + 8, 16),
                AutoSize = false,
                AutoEllipsis = true,
                TextAlign = ContentAlignment.MiddleLeft,
                Size = new Size(160, 22)
            };
            Controls.Add(_title);

            // --- Connection ---
            _pnlConnection = new Panel { Size = new Size(200, 20) };
            _dot = new StatusDot { Location = new Point(0, 5), BackColor = Color.Transparent };
            _dot.DotColor = COverlay0;
            _pnlConnection.Controls.Add(_dot);
            _lblConnection = new Label
            {
                Text = "Checking...",
                ForeColor = CSubtext,
                Font = new Font("Segoe UI", 8.25f),
                Location = new Point(14, 2),
                AutoSize = false,
                AutoEllipsis = true,
                TextAlign = ContentAlignment.MiddleLeft,
                Size = new Size(180, 16)
            };
            _pnlConnection.Controls.Add(_lblConnection);
            Controls.Add(_pnlConnection);

            // --- File info card ---
            _pnlFileCard = new BufferedPanel
            {
                BackColor = CSurface0,
                Visible = false
            };

            var cardY = 10;
            _lblFileName = MakeLabel(_pnlFileCard, ref cardY, new Font("Segoe UI Semibold", 9.75f), CText);
            _lblPartNumber = MakeLabel(_pnlFileCard, ref cardY, new Font("Consolas", 9.5f), CBlue);
            _lblDescription = MakeLabel(_pnlFileCard, ref cardY, new Font("Segoe UI", 8.25f), CSubtext);
            cardY += 4;
            _lblStatus = MakeLabel(_pnlFileCard, ref cardY, new Font("Segoe UI", 8.25f), CSubtext);
            _lblLockedBy = MakeLabel(_pnlFileCard, ref cardY, new Font("Segoe UI", 8.25f), CSubtext);
            _lblRenameWarning = MakeLabel(_pnlFileCard, ref cardY, new Font("Segoe UI Semibold", 8.25f), CYellow);
            _lblRenameWarning.AutoEllipsis = false;
            _lblRenameWarning.Height = 32;
            _lblRenameWarning.Visible = false;
            Controls.Add(_pnlFileCard);

            // --- Buttons ---
            _btnCheckOut = MakeButton("Check Out");
            _btnCheckOut.Click += async (s, e) => await DoCheckOut();
            _toolTip.SetToolTip(_btnCheckOut,
                "Reserve this file for editing. Until you check it back in, " +
                "no one else on the team can edit it. (Assemblies also reserve " +
                "their child parts.)");
            Controls.Add(_btnCheckOut);

            _btnCheckIn = MakeButton("Check In");
            _btnCheckIn.Click += async (s, e) => await DoCheckIn();
            _toolTip.SetToolTip(_btnCheckIn,
                "Release your hold on this file so others can edit it. " +
                "Doesn't publish your edits — use Upload for that.");
            Controls.Add(_btnCheckIn);

            _btnSync = MakeButton("Download");
            _btnSync.Click += async (s, e) => await DoSync();
            _toolTip.SetToolTip(_btnSync,
                "Pull the latest team changes from GitHub. Run this before " +
                "starting work so you're not editing a stale version.");
            Controls.Add(_btnSync);

            _btnPublish = MakeButton("Upload");
            _btnPublish.Click += async (s, e) => await DoPublish();
            _toolTip.SetToolTip(_btnPublish,
                "Push your changes to GitHub so the team sees them. Asks " +
                "you for a short note describing what changed.");
            Controls.Add(_btnPublish);

            _btnNewPart = MakeButton("New Part / Assembly");
            _btnNewPart.Click += async (s, e) => await DoNewPart();
            _toolTip.SetToolTip(_btnNewPart,
                "Create a new part or assembly already named with the next " +
                "team part number, dropped into the right subsystem folder.");
            Controls.Add(_btnNewPart);

            _btnFillTitleBlock = MakeButton("Fill Title Block");
            _btnFillTitleBlock.Click += async (s, e) => await DoFillTitleBlock();
            _btnFillTitleBlock.Visible = false;  // only for .slddrw documents
            _toolTip.SetToolTip(_btnFillTitleBlock,
                "Populate this drawing's title block with the linked part's " +
                "number, description, material, and mass from FrameCAD.");
            Controls.Add(_btnFillTitleBlock);

            _btnOpenApp = MakeButton("Open FrameCAD");
            _btnOpenApp.BackColor = CBlue;
            _btnOpenApp.ForeColor = CMantle;
            _btnOpenApp.Font = new Font("Segoe UI Semibold", 11f);
            _btnOpenApp.FlatAppearance.BorderSize = 0;
            _btnOpenApp.FlatAppearance.MouseOverBackColor = Color.FromArgb(196, 181, 253);
            _btnOpenApp.Enabled = true;
            _btnOpenApp.Click += (s, e) => DoOpenApp();
            Controls.Add(_btnOpenApp);

            _lblMessage = new Label
            {
                Text = "",
                ForeColor = CSubtext,
                Font = new Font("Segoe UI", 8f),
                AutoSize = false,
                AutoEllipsis = true,
                Size = new Size(200, 48)
            };
            Controls.Add(_lblMessage);

            BuildMetaPanel();

            SetButtonStates(false, false);
            ResumeLayout(true);
            LayoutAll();
        }

        private void BuildMetaPanel()
        {
            _pnlMeta = new BufferedPanel { BackColor = CSurface0, Visible = false };

            var y = 10;

            _lblReleaseLabel = new Label
            {
                Text = "Release state",
                ForeColor = CSubtext,
                Font = new Font("Segoe UI", 8.25f),
                Location = new Point(10, y),
                AutoSize = false,
                Size = new Size(180, 16)
            };
            _pnlMeta.Controls.Add(_lblReleaseLabel);
            y += 18;

            _cmbReleaseState = new ComboBox
            {
                DropDownStyle = ComboBoxStyle.DropDownList,
                FlatStyle = FlatStyle.Flat,
                BackColor = CSurface1,
                ForeColor = CText,
                Font = new Font("Segoe UI", 9.5f),
                Location = new Point(10, y),
                Size = new Size(180, 24),
                DrawMode = DrawMode.OwnerDrawFixed
            };
            _cmbReleaseState.DrawItem += ComboDrawItem;
            _cmbReleaseState.Items.AddRange(new object[] { "draft", "in-review", "released", "manufactured" });
            _cmbReleaseState.SelectedIndexChanged += async (s, e) =>
            {
                if (_suppressReleaseChange) return;
                await DoSetReleaseState();
            };
            _pnlMeta.Controls.Add(_cmbReleaseState);
            y += 30;

            _lblMaterialLabel = new Label
            {
                Text = "Material",
                ForeColor = CSubtext,
                Font = new Font("Segoe UI", 8.25f),
                Location = new Point(10, y),
                AutoSize = false,
                Size = new Size(180, 16)
            };
            _pnlMeta.Controls.Add(_lblMaterialLabel);
            y += 18;

            _lblMaterialValue = new Label
            {
                Text = "(not set)",
                ForeColor = CText,
                Font = new Font("Segoe UI", 9f),
                Location = new Point(10, y),
                AutoSize = false,
                AutoEllipsis = true,
                TextAlign = ContentAlignment.MiddleLeft,
                Size = new Size(116, 22)
            };
            _pnlMeta.Controls.Add(_lblMaterialValue);

            _btnUseSwMaterial = new Button
            {
                Text = "Use SW",
                FlatStyle = FlatStyle.Flat,
                BackColor = CSurface1,
                ForeColor = CText,
                Font = new Font("Segoe UI", 9f),
                Location = new Point(130, y),
                Size = new Size(60, 22),
                Cursor = Cursors.Hand,
                FlatAppearance = { BorderSize = 0 }
            };
            _btnUseSwMaterial.Click += async (s, e) => await DoUseSwMaterial();
            _pnlMeta.Controls.Add(_btnUseSwMaterial);
            y += 28;

            // Manufacturing method — required for released parts to land
            // on the right tab of FrameCAD's shop-floor queue. Mirrors
            // the desktop DetailsPanel's method picker.
            _lblMethodLabel = new Label
            {
                Text = "Method",
                ForeColor = CSubtext,
                Font = new Font("Segoe UI", 8.25f),
                Location = new Point(10, y),
                AutoSize = false,
                Size = new Size(180, 16)
            };
            _pnlMeta.Controls.Add(_lblMethodLabel);
            y += 18;

            _cmbMfgMethod = new ComboBox
            {
                DropDownStyle = ComboBoxStyle.DropDownList,
                FlatStyle = FlatStyle.Flat,
                BackColor = CSurface1,
                ForeColor = CText,
                Font = new Font("Segoe UI", 9.5f),
                Location = new Point(10, y),
                Size = new Size(180, 24),
                DrawMode = DrawMode.OwnerDrawFixed
            };
            _cmbMfgMethod.DrawItem += ComboDrawItem;
            // "(not set)" sentinel maps to a null write so the user can
            // clear the field from the add-in too.
            _cmbMfgMethod.Items.AddRange(new object[] { "(not set)", "print", "cnc", "manual", "other" });
            _cmbMfgMethod.SelectedIndexChanged += async (s, e) =>
            {
                if (_suppressMethodChange) return;
                await DoSetMfgMethod();
            };
            _pnlMeta.Controls.Add(_cmbMfgMethod);
            y += 30;

            _lblCommentsLabel = new Label
            {
                Text = "Comments",
                ForeColor = CSubtext,
                Font = new Font("Segoe UI", 8.25f),
                Location = new Point(10, y),
                AutoSize = false,
                Size = new Size(180, 16)
            };
            _pnlMeta.Controls.Add(_lblCommentsLabel);
            y += 18;

            _lstComments = new ListBox
            {
                BackColor = CMantle,
                ForeColor = CText,
                Font = new Font("Segoe UI", 8.5f),
                BorderStyle = BorderStyle.None,
                Location = new Point(10, y),
                Size = new Size(180, 80),
                IntegralHeight = false
            };
            // Double-click on the "View all N comments…" footer row
            // opens a modal with the full thread.
            _lstComments.DoubleClick += (s, e) => OnCommentsItemActivated();
            _pnlMeta.Controls.Add(_lstComments);
            y += 86;

            _txtComment = new TextBox
            {
                BackColor = Color.FromArgb(60, 65, 77),
                ForeColor = CText,
                Font = new Font("Segoe UI", 9f),
                BorderStyle = BorderStyle.FixedSingle,
                Location = new Point(10, y),
                Size = new Size(120, 22)
            };
            _pnlMeta.Controls.Add(_txtComment);

            _btnAddComment = new Button
            {
                Text = "Add",
                FlatStyle = FlatStyle.Flat,
                BackColor = CBlue,
                ForeColor = CMantle,
                Font = new Font("Segoe UI Semibold", 9f),
                Location = new Point(134, y),
                Size = new Size(56, 22),
                Cursor = Cursors.Hand,
                FlatAppearance = { BorderSize = 0 }
            };
            _btnAddComment.Click += async (s, e) => await DoAddComment();
            _pnlMeta.Controls.Add(_btnAddComment);
            y += 28;

            // Manufacturing-notes summary at the bottom of the meta
            // panel. Placed last so showing/hiding it doesn't shove the
            // other controls around — the parent ScrollableControl will
            // grow/shrink as the panel height changes in UpdateMetaDisplay.
            _lblMfgNotes = new Label
            {
                Text = "",
                ForeColor = CSubtext,
                Font = new Font("Segoe UI Italic", 8.25f),
                AutoSize = false,
                AutoEllipsis = true,
                Location = new Point(10, y),
                Size = new Size(180, 18),
                Visible = false
            };
            _pnlMeta.Controls.Add(_lblMfgNotes);
            // _metaBaseHeight = panel height without notes; the +22 form
            // (height with notes visible) is applied dynamically in
            // UpdateMetaDisplay so the panel doesn't reserve empty space
            // for the common no-notes case.
            _metaBaseHeight = y;
            _metaHeightWithNotes = y + 22;
            _pnlMeta.Height = _metaBaseHeight;
            Controls.Add(_pnlMeta);

            // "Newer version available" banner — separate panel so it can
            // appear without the meta panel (or vice versa)
            _pnlNewerVersion = new BufferedPanel
            {
                BackColor = CYellow,
                Visible = false,
                Height = 62
            };
            _lblNewerVersion = new Label
            {
                Text = "A teammate uploaded a newer version of this file",
                ForeColor = CMantle,
                Font = new Font("Segoe UI Semibold", 9f),
                Location = new Point(10, 6),
                AutoSize = false,
                Size = new Size(180, 32)
            };
            _pnlNewerVersion.Controls.Add(_lblNewerVersion);
            _btnDownloadNewer = new Button
            {
                Text = "Download",
                FlatStyle = FlatStyle.Flat,
                BackColor = CMantle,
                ForeColor = CYellow,
                Font = new Font("Segoe UI Semibold", 9f),
                Location = new Point(10, 36),
                Size = new Size(110, 22),
                Cursor = Cursors.Hand,
                FlatAppearance = { BorderSize = 0 }
            };
            _btnDownloadNewer.Click += async (s, e) => { await DoSync(); };
            _pnlNewerVersion.Controls.Add(_btnDownloadNewer);
            Controls.Add(_pnlNewerVersion);
        }

        private void LayoutAll()
        {
            var w = ClientSize.Width - Pad * 2;
            if (w < 40) return;
            SuspendLayout();
            _pnlFileCard?.SuspendLayout();
            _pnlMeta?.SuspendLayout();
            _pnlNewerVersion?.SuspendLayout();
            try
            {

            // Header (logo + title) — reposition every layout pass so a
            // resized pane keeps things aligned
            if (_logo != null) _logo.Location = new Point(Pad, 8);
            if (_title != null)
            {
                _title.Location = new Point(Pad + LogoSize + 8, 16);
                _title.Width = Math.Max(40, w - LogoSize - 8);
            }
            var y = HeaderHeight + 8;

            _pnlConnection.Location = new Point(Pad, y);
            _pnlConnection.Width = w;
            _lblConnection.Width = Math.Max(40, w - 18);
            y += 28;

            if (_pnlFileCard.Visible)
            {
                _pnlFileCard.Location = new Point(Pad, y);
                _pnlFileCard.Width = w;

                var labelW = Math.Max(40, w - 20);
                foreach (Control c in _pnlFileCard.Controls)
                {
                    if (c is Label lbl) lbl.Width = labelW;
                }

                var cardH = 10;
                foreach (Control c in _pnlFileCard.Controls)
                {
                    if (c is Label lbl && lbl.Visible && !string.IsNullOrEmpty(lbl.Text))
                        cardH = Math.Max(cardH, c.Bottom + 8);
                }
                _pnlFileCard.Height = cardH;
                y += cardH + SectionGap;
            }

            // Newer-version banner sits at the top of per-file content —
            // it's the most urgent thing to see, before action buttons
            if (_pnlNewerVersion != null && _pnlNewerVersion.Visible)
            {
                _pnlNewerVersion.Location = new Point(Pad, y);
                _pnlNewerVersion.Width = w;
                _lblNewerVersion.Width = Math.Max(40, w - 20);
                _btnDownloadNewer.Width = Math.Max(60, w - 20);
                y += _pnlNewerVersion.Height + BtnGap;
            }

            // Meta panel sits between the file card and the action buttons —
            // it's per-file context (release state, material, comments) so
            // it belongs close to the file info, not at the bottom of the pane.
            if (_pnlMeta != null && _pnlMeta.Visible)
            {
                _pnlMeta.Location = new Point(Pad, y);
                _pnlMeta.Width = w;
                var inner = Math.Max(40, w - 20);
                _lblReleaseLabel.Width = inner;
                _cmbReleaseState.Width = inner;
                _lblMaterialLabel.Width = inner;
                _lblMethodLabel.Width = inner;
                _cmbMfgMethod.Width = inner;
                _lblCommentsLabel.Width = inner;
                _lstComments.Width = inner;
                _txtComment.Width = Math.Max(40, inner - 64);
                _btnAddComment.Location = new Point(10 + _txtComment.Width + 4, _txtComment.Location.Y);
                // Material value + Use-SW button share a row; let value
                // take whatever's left after the 60-px button
                _lblMaterialValue.Width = Math.Max(40, inner - 64);
                _btnUseSwMaterial.Location = new Point(10 + _lblMaterialValue.Width + 4, _lblMaterialValue.Location.Y);
                y += _pnlMeta.Height + SectionGap;
            }

            PlaceButton(_btnCheckOut, ref y, w);
            PlaceButton(_btnCheckIn, ref y, w);
            y += SectionGap - BtnGap;

            PlaceButton(_btnSync, ref y, w);
            PlaceButton(_btnPublish, ref y, w);
            y += SectionGap - BtnGap;

            PlaceButton(_btnNewPart, ref y, w);
            if (_btnFillTitleBlock != null && _btnFillTitleBlock.Visible)
            {
                PlaceButton(_btnFillTitleBlock, ref y, w);
            }
            y += SectionGap - BtnGap;

            PlaceButton(_btnOpenApp, ref y, w);
            y += 8;

            _lblMessage.Location = new Point(Pad, y);
            _lblMessage.Width = w;
            }
            finally
            {
                _pnlNewerVersion?.ResumeLayout(true);
                _pnlMeta?.ResumeLayout(true);
                _pnlFileCard?.ResumeLayout(true);
                ResumeLayout(true);
            }
        }

        private void PlaceButton(Button btn, ref int y, int w)
        {
            btn.Location = new Point(Pad, y);
            btn.Width = w;
            y += BtnHeight + BtnGap;
        }

        private Label MakeLabel(Control parent, ref int y, Font font, Color color)
        {
            var rowH = (int)(font.GetHeight() + 4);
            var lbl = new Label
            {
                ForeColor = color,
                Font = font,
                Location = new Point(10, y),
                AutoSize = false,
                AutoEllipsis = true,
                TextAlign = ContentAlignment.MiddleLeft,
                Size = new Size(180, rowH)
            };
            parent.Controls.Add(lbl);
            y += rowH + 4;
            return lbl;
        }

        private void ComboDrawItem(object sender, DrawItemEventArgs e)
        {
            if (e.Index < 0) return;
            var combo = (ComboBox)sender;
            var bg = (e.State & DrawItemState.Selected) != 0 ? CSurface0 : CSurface1;
            using (var bgBrush = new SolidBrush(bg))
                e.Graphics.FillRectangle(bgBrush, e.Bounds);
            using (var textBrush = new SolidBrush(CText))
                e.Graphics.DrawString(combo.Items[e.Index].ToString(), e.Font, textBrush, e.Bounds);
        }

        private Button MakeButton(string text)
        {
            var btn = new Button
            {
                Text = text,
                FlatStyle = FlatStyle.Flat,
                BackColor = CSurface0,
                ForeColor = CText,
                Font = new Font("Segoe UI", 11f),
                Size = new Size(200, BtnHeight),
                Cursor = Cursors.Hand,
                FlatAppearance =
                {
                    BorderColor = CSurface1,
                    MouseOverBackColor = CSurface1
                },
                Enabled = false
            };
            return btn;
        }

        private void SafeInvoke(Action action)
        {
            if (_disposed || IsDisposed || !IsHandleCreated) return;
            try { BeginInvoke(action); } catch (ObjectDisposedException) { }
        }

        private bool _connected;
        private string _currentProjectPath;
        private bool _processingPending;
        private bool _processingExports;

        public Action<string> OnProjectPathChanged { get; set; }
        public Func<string, bool, string> OnCreateSolidWorksFile { get; set; }
        /// <summary>(sourceAbsPath, targetAbsPath, "step"|"stl") -> null on success or error string.</summary>
        public Func<string, string, string, string> OnExportSolidWorksFile { get; set; }
        public Func<string, System.Threading.Tasks.Task> OnStageFile { get; set; }
        public Func<string, System.Collections.Generic.List<string>> OnGetAssemblyChildren { get; set; }

        // Cached last-known file-state-derived button availability. We
        // remember these so the 5-second health tick can refresh the
        // connection-dependent buttons (Sync / Upload / + Part) without
        // clobbering Check Out / Check In, which is driven by the active
        // doc's lock state — UpdateFileDisplay is the only place that
        // should change those.
        private bool _lastCanCheckOut;
        private bool _lastCanCheckIn;

        private void SetButtonStates(bool canCheckOut, bool canCheckIn)
        {
            _lastCanCheckOut = canCheckOut;
            _lastCanCheckIn = canCheckIn;
            ApplyButtonStates();
        }

        private void ApplyButtonStates()
        {
            _btnCheckOut.Enabled = _connected && _lastCanCheckOut && !_busy;
            _btnCheckIn.Enabled = _connected && _lastCanCheckIn && !_busy;
            _btnSync.Enabled = _connected && !_busy;
            _btnPublish.Enabled = _connected && !_busy;
            _btnNewPart.Enabled = _connected && !_busy;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _disposed = true;
                _healthTimer?.Stop();
                _healthTimer?.Dispose();
                _messageClearTimer?.Stop();
                _messageClearTimer?.Dispose();
                // ToolTip is a Component, not a Control — it doesn't get
                // disposed automatically with our parent chain. Dispose
                // it explicitly so its native tooltip window is freed
                // when SW unloads the add-in.
                _toolTip?.Dispose();
            }
            base.Dispose(disposing);
        }

        // 5s when connected and responsive; backed off to 30s while
        // the desktop app is unreachable so we're not hammering 1
        // request/5s forever when FrameCAD is closed.
        private const int HealthPollFastMs = 5000;
        private const int HealthPollSlowMs = 30000;

        // Set while a CheckConnection is in flight so the timer can't
        // start a second poll on top — concurrent polls could stomp
        // on _connected / _currentProjectPath from interleaved
        // continuations, and pile up if one is slow.
        private bool _polling;

        public void StartHealthPolling()
        {
            _healthTimer = new Timer { Interval = HealthPollFastMs };
            _healthTimer.Tick += async (s, e) =>
            {
                if (_polling) return;
                await CheckConnection();
            };
            _healthTimer.Start();
            _ = CheckConnection();
        }

        public void StopHealthPolling()
        {
            _healthTimer?.Stop();
            _healthTimer?.Dispose();
        }

        private async System.Threading.Tasks.Task CheckConnection()
        {
            if (_polling) return;
            _polling = true;
            var wasConnected = _connected;
            HealthResponse health = null;
            Exception error = null;
            try
            {
                health = await _api.GetHealthAsync();
            }
            catch (Exception ex)
            {
                error = ex;
            }

            if (error == null && health?.Running == true && health?.Project != null)
            {
                // Best-effort role fetch so the UI matches the desktop's
                // role tiers (students can't pick released/manufactured).
                // Failure is non-fatal — fall back to the previous value.
                try
                {
                    var coord = await _api.GetCoordStateAsync();
                    if (coord != null) _coordState = coord;
                }
                catch { /* keep previous role */ }

                await ProcessPendingCreates();
                await ProcessPendingExports();
            }

            SafeInvoke(() =>
            {
                if (error != null)
                {
                    _connected = false;
                    _dot.DotColor = CRed;
                    string label;
                    if (error is System.Net.Http.HttpRequestException)
                    {
                        // Connection refused / unreachable — almost always means the
                        // desktop app isn't running
                        label = "FrameCAD desktop app is not open";
                    }
                    else if (error is System.Threading.Tasks.TaskCanceledException)
                    {
                        label = "FrameCAD not responding";
                    }
                    else
                    {
                        var msg = error.InnerException?.Message ?? error.Message;
                        if (msg.Length > 60) msg = msg.Substring(0, 57) + "...";
                        label = "Error: " + msg;
                    }
                    _lblConnection.Text = label;
                    SetButtonStates(false, false);
                    return;
                }

                var isConnected = health?.Running == true;
                var hasProject = health?.Project != null;
                _connected = isConnected && hasProject;
                if (isConnected && hasProject)
                {
                    _dot.DotColor = CGreen;
                    _lblConnection.Text = health.Project.Name;
                    // Re-apply (don't reset) — keeps the file-state buttons
                    // alive across 5-second health ticks
                    ApplyButtonStates();
                    if (!string.IsNullOrEmpty(health.Project.Path) && _currentProjectPath != health.Project.Path)
                    {
                        _currentProjectPath = health.Project.Path;
                        OnProjectPathChanged?.Invoke(health.Project.Path);
                    }
                    if (!wasConnected && !string.IsNullOrEmpty(_currentFilePath))
                        UpdateForDocument(_currentFilePath);
                }
                else if (isConnected)
                {
                    _currentProjectPath = null;
                    _dot.DotColor = CYellow;
                    _lblConnection.Text = "No Project Open";
                    SetButtonStates(false, false);
                }
                else
                {
                    _dot.DotColor = CRed;
                    _lblConnection.Text = "Not Running";
                    SetButtonStates(false, false);
                }

                // Adjust poll cadence based on what we just observed —
                // fast when connected so file-state stays fresh, slow
                // when down so we're not spamming the network 720x/hour
                // while the desktop app is closed.
                if (_healthTimer != null && !_disposed)
                {
                    var nextInterval = (error == null && health?.Running == true)
                        ? HealthPollFastMs
                        : HealthPollSlowMs;
                    if (_healthTimer.Interval != nextInterval)
                        _healthTimer.Interval = nextInterval;
                }
                // Clear the in-flight flag inside the UI-thread block
                // so the next timer tick can't start a new poll until
                // this one's UI work has actually completed (SafeInvoke
                // uses BeginInvoke, so this runs on the UI thread, not
                // synchronously with the await above).
                _polling = false;
            });
        }

        private async System.Threading.Tasks.Task ProcessPendingCreates()
        {
            if (_processingPending) return;
            _processingPending = true;
            try
            {
                var pending = await _api.GetPendingCreatesAsync();
                if (pending == null) return;
                foreach (var p in pending)
                {
                    if (string.IsNullOrEmpty(p?.AbsolutePath)) continue;
                    var isAssembly = p.Type == "assembly";
                    // CheckConnection runs on the WinForms UI thread (Timer.Tick fires there and
                    // the continuation preserves the SynchronizationContext), so it's safe to
                    // call into the SolidWorks COM API directly here.
                    var error = OnCreateSolidWorksFile?.Invoke(p.AbsolutePath, isAssembly);
                    // Always mark done so a broken pending entry doesn't loop forever
                    try { await _api.MarkPendingDoneAsync(p.Id); } catch { }
                    if (error == null)
                    {
                        if (OnStageFile != null && !string.IsNullOrEmpty(p.RelativePath))
                        {
                            try { await OnStageFile(p.RelativePath); } catch { }
                        }
                        // Refresh the task pane for the new active doc — SolidWorks
                        // doesn't always fire ActiveDocChangeNotify for a doc that
                        // becomes active via NewPart/SaveAs, so the file would
                        // otherwise appear "Not tracked" until the user edits it
                        UpdateForDocument(p.AbsolutePath);
                        ShowMessage("Created " + (p.PartNumber ?? System.IO.Path.GetFileName(p.AbsolutePath)));
                    }
                    else
                    {
                        ShowMessage("Create failed: " + error, true);
                    }
                }
            }
            catch
            {
                // Ignore network/HTTP errors here; the next health tick will retry
            }
            finally
            {
                _processingPending = false;
            }
        }

        /// <summary>
        /// Drain the pending CAM export queue. Each task is the SolidWorks
        /// side of a release for a CNC/3D-print part: we SaveAs the source
        /// to .step / .stl alongside it, then ack /done so FrameCAD stages
        /// + commits the new file. Errors are reported back so the part
        /// stays in the "needs export" queue rather than getting silently
        /// dropped.
        /// </summary>
        private async System.Threading.Tasks.Task ProcessPendingExports()
        {
            if (_processingExports) return;
            _processingExports = true;
            try
            {
                var pending = await _api.GetPendingExportsAsync();
                if (pending == null) return;
                foreach (var p in pending)
                {
                    if (string.IsNullOrEmpty(p?.SourceAbsPath) || string.IsNullOrEmpty(p?.TargetAbsPath))
                    {
                        try { await _api.MarkExportDoneAsync(p?.Id, "Missing source or target path"); } catch { }
                        continue;
                    }
                    if (OnExportSolidWorksFile == null)
                    {
                        try { await _api.MarkExportDoneAsync(p.Id, "Export handler not wired"); } catch { }
                        continue;
                    }
                    var error = OnExportSolidWorksFile.Invoke(p.SourceAbsPath, p.TargetAbsPath, p.Format);
                    try
                    {
                        await _api.MarkExportDoneAsync(p.Id, error);
                    }
                    catch
                    {
                        // Ack failed; FrameCAD will see the task again next
                        // poll and reissue. Idempotent on its side.
                    }
                    if (error == null)
                    {
                        ShowMessage("Exported " + System.IO.Path.GetFileName(p.TargetAbsPath));
                    }
                    else
                    {
                        ShowMessage("Export failed: " + error, true);
                    }
                }
            }
            catch
            {
                // Network/HTTP errors: next health tick retries.
            }
            finally
            {
                _processingExports = false;
            }
        }

        // async void is required here because UpdateForDocument is
        // invoked synchronously from a SolidWorks event handler
        // (SwAddin.OnActiveDocChange). The full body is wrapped in a
        // top-level try/catch so any thrown exception can't escape to
        // become an unobserved fault and crash the SW host process.
        public async void UpdateForDocument(string absolutePath)
        {
            try
            {
                await UpdateForDocumentCore(absolutePath);
            }
            catch
            {
                // Last-resort safety net — every step inside Core
                // already has its own try/catch around IPC work; this
                // exists purely to swallow anything we missed (e.g.
                // SafeInvoke lambda throwing inside LayoutAll on a
                // disposed control) before it propagates up the COM
                // boundary and SIGSEGVs SolidWorks.
            }
        }

        private async System.Threading.Tasks.Task UpdateForDocumentCore(string absolutePath)
        {
            _currentFilePath = absolutePath;

            var isDrawing = !string.IsNullOrEmpty(absolutePath) &&
                absolutePath.EndsWith(".slddrw", StringComparison.OrdinalIgnoreCase);
            SafeInvoke(() => {
                if (_btnFillTitleBlock != null)
                    _btnFillTitleBlock.Visible = isDrawing;
                var fname = string.IsNullOrEmpty(absolutePath)
                    ? "" : System.IO.Path.GetFileName(absolutePath);
                ShowFileCard(fname, "", "", "Loading…", CSubtext, "");
                SetButtonStates(false, false);
                LayoutAll();
            });

            try
            {
                var file = await _api.GetFileAsync(absolutePath);
                if (_currentFilePath != absolutePath) return;
                SafeInvoke(() => {
                    UpdateFileDisplay(file, absolutePath);
                    UpdateNewerVersionBanner(file?.NewerOnRemote == true);
                });
            }
            catch
            {
                if (_currentFilePath != absolutePath) return;
                SafeInvoke(() =>
                {
                    ShowFileCard(System.IO.Path.GetFileName(absolutePath), "", "", "Not tracked", COverlay0, "");
                    SetButtonStates(false, false);
                    UpdateNewerVersionBanner(false);
                });
            }

            // Fetch metadata in parallel — release state + comments + material.
            // Best effort: if it fails (file not in parts.json), hide the panel.
            try
            {
                var meta = await _api.GetPartMetaAsync(absolutePath);
                if (_currentFilePath != absolutePath) return;
                SafeInvoke(() => UpdateMetaDisplay(meta));
            }
            catch
            {
                if (_currentFilePath != absolutePath) return;
                SafeInvoke(() => HideMetaPanel());
            }
        }

        private void UpdateNewerVersionBanner(bool newer)
        {
            if (_pnlNewerVersion == null) return;
            var changed = _pnlNewerVersion.Visible != newer;
            _pnlNewerVersion.Visible = newer;
            if (changed) LayoutAll();
        }

        public void ClearDocument()
        {
            _currentFilePath = null;
            _pnlFileCard.Visible = false;
            HideMetaPanel();
            UpdateNewerVersionBanner(false);
            if (_btnFillTitleBlock != null) _btnFillTitleBlock.Visible = false;
            SetButtonStates(false, false);
            LayoutAll();
        }

        private async System.Threading.Tasks.Task DoFillTitleBlock()
        {
            if (string.IsNullOrEmpty(_currentFilePath)) return;
            if (OnFillTitleBlock == null)
            {
                ShowMessage("SolidWorks API not available", true);
                return;
            }
            _btnFillTitleBlock.Enabled = false;
            try
            {
                var data = await _api.GetTitleBlockDataAsync(_currentFilePath);
                if (data == null)
                {
                    ShowMessage("Could not fetch title-block data from FrameCAD.", true);
                    return;
                }
                var props = new System.Collections.Generic.Dictionary<string, string>
                {
                    { "PartNumber", data.PartNumber ?? "" },
                    { "Description", data.Description ?? "" },
                    { "Material", data.Material ?? "" },
                    { "Mass", data.Mass ?? "" },
                    { "Designer", data.Designer ?? "" },
                    { "Date", data.Date ?? "" }
                };
                var written = OnFillTitleBlock(props);
                if (written > 0)
                {
                    ShowMessage($"Wrote {written} title-block field{(written == 1 ? "" : "s")}. " +
                        "Drawing template must reference \"PartNumber\", \"Description\", " +
                        "\"Material\", \"Mass\", \"Designer\", \"Date\" via $PRPSHEET / $PRP.",
                        false);
                }
                else
                {
                    ShowMessage("No title-block fields written — FrameCAD had no data for this drawing.", true);
                }
            }
            finally
            {
                _btnFillTitleBlock.Enabled = true;
            }
        }

        private void HideMetaPanel()
        {
            if (_pnlMeta == null) return;
            _pnlMeta.Visible = false;
            LayoutAll();
        }

        private void UpdateMetaDisplay(PartMetaDto meta)
        {
            if (_pnlMeta == null) return;
            if (meta == null)
            {
                _currentMeta = null;
                HideMetaPanel();
                return;
            }
            _currentMeta = meta;

            // Populate release-state combo without firing the change
            // handler (which would re-save the state we just loaded).
            _suppressReleaseChange = true;
            try
            {
                var state = meta.Release?.State ?? "draft";
                var idx = _cmbReleaseState.Items.IndexOf(state);
                _cmbReleaseState.SelectedIndex = idx >= 0 ? idx : 0;
            }
            finally
            {
                _suppressReleaseChange = false;
            }

            // Material + mass + cost rolled into one line so the panel
            // stays compact. Empty values get omitted entirely.
            var matBits = new System.Collections.Generic.List<string>();
            if (!string.IsNullOrWhiteSpace(meta.ManufacturingMaterial))
                matBits.Add(meta.ManufacturingMaterial);
            if (meta.Mass.HasValue)
                matBits.Add($"{meta.Mass.Value:0.##} lb");
            if (meta.Cost.HasValue)
                matBits.Add($"${meta.Cost.Value:0.##}");
            _lblMaterialValue.Text = matBits.Count == 0
                ? "(not set)"
                : string.Join(" · ", matBits);

            // Populate the manufacturing-method combo without firing
            // the change handler (same pattern as release state).
            _suppressMethodChange = true;
            try
            {
                var method = meta.ManufacturingMethod;
                if (string.IsNullOrEmpty(method))
                {
                    _cmbMfgMethod.SelectedIndex = 0; // "(not set)"
                }
                else
                {
                    var idx = _cmbMfgMethod.Items.IndexOf(method);
                    _cmbMfgMethod.SelectedIndex = idx >= 0 ? idx : 0;
                }
            }
            finally
            {
                _suppressMethodChange = false;
            }

            _lstComments.BeginUpdate();
            _lstComments.Items.Clear();
            if (meta.Comments != null && meta.Comments.Count > 0)
            {
                var ordered = meta.Comments
                    .Where(c => c != null)
                    .OrderByDescending(c => c.At ?? "")
                    .Take(8)
                    .ToList();
                foreach (var c in ordered)
                {
                    var text = (c.Text ?? "").Replace("\r", " ").Replace("\n", " ");
                    if (text.Length > 60) text = text.Substring(0, 57) + "...";
                    var author = string.IsNullOrEmpty(c.Author) ? "?" : c.Author;
                    _lstComments.Items.Add($"{author}: {text}");
                }
                // Footer link if the thread is longer than what we showed —
                // students can drill into the full thread without alt-tabbing
                // to FrameCAD.
                if (meta.Comments.Count > ordered.Count)
                {
                    _lstComments.Items.Add($"  ↗ View all {meta.Comments.Count} comments…");
                }
            }
            else
            {
                _lstComments.Items.Add("(no comments yet)");
            }
            _lstComments.EndUpdate();

            // Manufacturing notes: surface a single-line summary if set,
            // hidden otherwise. Server stores free-form text, can be long.
            if (_lblMfgNotes != null)
            {
                if (!string.IsNullOrWhiteSpace(meta.ManufacturingNotes))
                {
                    var notes = meta.ManufacturingNotes.Replace("\r", " ").Replace("\n", " ");
                    if (notes.Length > 100) notes = notes.Substring(0, 97) + "...";
                    _lblMfgNotes.Text = "Notes: " + notes;
                    _lblMfgNotes.Visible = true;
                    _toolTip.SetToolTip(_lblMfgNotes, meta.ManufacturingNotes);
                    if (_pnlMeta.Height != _metaHeightWithNotes)
                        _pnlMeta.Height = _metaHeightWithNotes;
                }
                else
                {
                    _lblMfgNotes.Visible = false;
                    if (_pnlMeta.Height != _metaBaseHeight)
                        _pnlMeta.Height = _metaBaseHeight;
                }
            }

            _pnlMeta.Visible = true;
            LayoutAll();
        }

        private async System.Threading.Tasks.Task DoSetReleaseState()
        {
            if (string.IsNullOrEmpty(_currentFilePath)) return;
            var state = _cmbReleaseState.SelectedItem?.ToString();
            if (string.IsNullOrEmpty(state)) return;

            // Role gate — mirror the desktop DetailsPanel rules: only
            // mentors / admins can mark released or manufactured.
            // Revert the combo and show a hint instead of silently
            // letting the API accept it (server is unauthenticated).
            if (!_coordState.IsMentor && (state == "released" || state == "manufactured"))
            {
                ShowMessage("Only mentors can mark a part " + state + ". Set it to in-review and ask a mentor to sign off.", true);
                // Revert by re-fetching meta and replaying through UpdateMetaDisplay,
                // which sets the combo via _suppressReleaseChange so no recursive save.
                try
                {
                    var fresh = await _api.GetPartMetaAsync(_currentFilePath);
                    SafeInvoke(() => UpdateMetaDisplay(fresh));
                }
                catch { /* best-effort revert */ }
                return;
            }

            // Manufactured needs operator initials — same attribution
            // model as the desktop shop-floor kiosk. Prompt once per
            // session; cached in _operatorInitials.
            string note = null;
            if (state == "manufactured")
            {
                var initials = PromptForOperatorInitials();
                if (string.IsNullOrEmpty(initials))
                {
                    // User cancelled — revert combo without saving.
                    try
                    {
                        var fresh = await _api.GetPartMetaAsync(_currentFilePath);
                        SafeInvoke(() => UpdateMetaDisplay(fresh));
                    }
                    catch { }
                    return;
                }
                _operatorInitials = initials;
                note = "Finished by " + initials;
            }

            var result = await _api.SetReleaseStateAsync(_currentFilePath, state, note);
            if (result?.Success == true)
            {
                ShowMessage($"Release state set to {state}.", false);
            }
            else
            {
                ShowMessage(result?.Error ?? "Could not set release state", true);
            }
        }

        /// <summary>
        /// Fired when the user double-clicks a row in the comments list.
        /// If the row is the "View all…" footer, opens a modal showing
        /// every comment in chronological order. Other rows are no-op.
        /// </summary>
        private void OnCommentsItemActivated()
        {
            if (_currentMeta?.Comments == null || _currentMeta.Comments.Count == 0) return;
            var sel = _lstComments.SelectedItem as string;
            if (sel == null) return;
            // The footer row starts with the arrow glyph we set in UpdateMetaDisplay
            if (!sel.StartsWith("  ↗")) return;
            ShowAllCommentsDialog(_currentMeta.Comments);
        }

        private void ShowAllCommentsDialog(System.Collections.Generic.List<PartCommentDto> comments)
        {
            using (var dlg = new Form
            {
                Text = "Comments — " + (System.IO.Path.GetFileName(_currentFilePath) ?? ""),
                StartPosition = FormStartPosition.CenterParent,
                ClientSize = new Size(520, 420),
                BackColor = CBase,
                ForeColor = CText,
                MinimizeBox = false,
                MaximizeBox = true,
                FormBorderStyle = FormBorderStyle.Sizable
            })
            {
                var txt = new TextBox
                {
                    Multiline = true,
                    ReadOnly = true,
                    ScrollBars = ScrollBars.Vertical,
                    Dock = DockStyle.Fill,
                    BackColor = CMantle,
                    ForeColor = CText,
                    Font = new Font("Segoe UI", 9.5f),
                    BorderStyle = BorderStyle.None,
                    WordWrap = true
                };
                // Chronological (oldest first) so threading reads naturally
                var sb = new System.Text.StringBuilder();
                foreach (var c in comments.OrderBy(x => x?.At ?? ""))
                {
                    if (c == null) continue;
                    sb.Append(string.IsNullOrEmpty(c.Author) ? "?" : c.Author);
                    if (!string.IsNullOrEmpty(c.At)) sb.Append(" · ").Append(c.At);
                    sb.AppendLine();
                    sb.AppendLine(c.Text ?? "");
                    sb.AppendLine();
                }
                txt.Text = sb.ToString();
                dlg.Controls.Add(txt);
                dlg.ShowDialog(this);
            }
        }

        /// <summary>
        /// Modal prompt for operator initials when marking a part
        /// manufactured. Pre-fills with the last value entered this
        /// session so a single operator working through a queue
        /// doesn't keep re-typing. Returns null on cancel.
        /// </summary>
        private string PromptForOperatorInitials()
        {
            using (var dlg = new Form
            {
                Text = "Mark as Manufactured",
                StartPosition = FormStartPosition.CenterParent,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                MinimizeBox = false,
                MaximizeBox = false,
                ClientSize = new Size(320, 140),
                BackColor = CBase,
                ForeColor = CText
            })
            {
                var lbl = new Label
                {
                    Text = "Enter your initials so the team knows\nwho finished this part:",
                    Location = new Point(16, 14),
                    Size = new Size(290, 36),
                    ForeColor = CText
                };
                var txt = new TextBox
                {
                    Text = _operatorInitials ?? "",
                    Location = new Point(16, 58),
                    Size = new Size(120, 24),
                    MaxLength = 6,
                    CharacterCasing = CharacterCasing.Upper,
                    Font = new Font("Consolas", 11f, FontStyle.Bold),
                    BackColor = CSurface0,
                    ForeColor = CText,
                    BorderStyle = BorderStyle.FixedSingle
                };
                var ok = new Button
                {
                    Text = "Confirm",
                    DialogResult = DialogResult.OK,
                    Location = new Point(16, 96),
                    Size = new Size(90, 28),
                    FlatStyle = FlatStyle.Flat,
                    BackColor = CBlue,
                    ForeColor = CBase
                };
                ok.FlatAppearance.BorderSize = 0;
                var cancel = new Button
                {
                    Text = "Cancel",
                    DialogResult = DialogResult.Cancel,
                    Location = new Point(112, 96),
                    Size = new Size(90, 28),
                    FlatStyle = FlatStyle.Flat,
                    BackColor = CSurface1,
                    ForeColor = CText
                };
                cancel.FlatAppearance.BorderSize = 0;
                dlg.Controls.AddRange(new Control[] { lbl, txt, ok, cancel });
                dlg.AcceptButton = ok;
                dlg.CancelButton = cancel;
                if (dlg.ShowDialog(this) != DialogResult.OK) return null;
                var raw = (txt.Text ?? "").Trim();
                // Normalise: alphanumeric + dot only, uppercased, ≤6 chars.
                var sb = new System.Text.StringBuilder();
                foreach (var ch in raw.ToUpperInvariant())
                {
                    if (char.IsLetterOrDigit(ch) || ch == '.') sb.Append(ch);
                    if (sb.Length >= 6) break;
                }
                return sb.Length == 0 ? null : sb.ToString();
            }
        }

        private async System.Threading.Tasks.Task DoSetMfgMethod()
        {
            if (string.IsNullOrEmpty(_currentFilePath)) return;
            var selected = _cmbMfgMethod.SelectedItem?.ToString();
            // "(not set)" — first item — clears the field via null payload.
            var method = (selected == "(not set)" || string.IsNullOrEmpty(selected)) ? null : selected;

            var result = await _api.SetManufacturingMethodAsync(_currentFilePath, method);
            if (result?.Success == true)
            {
                ShowMessage(method == null
                    ? "Manufacturing method cleared."
                    : $"Manufacturing method set to {method}.", false);
            }
            else
            {
                ShowMessage(result?.Error ?? "Could not set manufacturing method", true);
            }
        }

        private async System.Threading.Tasks.Task DoUseSwMaterial()
        {
            if (string.IsNullOrEmpty(_currentFilePath)) return;
            var swMaterial = OnGetActiveDocMaterial?.Invoke() ?? "";
            if (string.IsNullOrWhiteSpace(swMaterial))
            {
                ShowMessage("No material set on the active SolidWorks document.", true);
                return;
            }

            _btnUseSwMaterial.Enabled = false;
            try
            {
                var result = await _api.SetManufacturingMaterialAsync(_currentFilePath, swMaterial);
                if (result?.Success == true)
                {
                    SafeInvoke(() => _lblMaterialValue.Text = swMaterial);
                    ShowMessage($"Material set to \"{swMaterial}\".", false);
                }
                else
                {
                    ShowMessage(result?.Error ?? "Could not set material", true);
                }
            }
            finally
            {
                _btnUseSwMaterial.Enabled = true;
            }
        }

        private async System.Threading.Tasks.Task DoAddComment()
        {
            if (string.IsNullOrEmpty(_currentFilePath)) return;
            var text = _txtComment.Text?.Trim();
            if (string.IsNullOrEmpty(text)) return;

            _btnAddComment.Enabled = false;
            try
            {
                var result = await _api.AddCommentAsync(_currentFilePath, text);
                if (result?.Success == true)
                {
                    _txtComment.Text = "";
                    // Refresh comments list from server so we see what the
                    // server actually persisted (with author + timestamp)
                    var fresh = await _api.GetPartMetaAsync(_currentFilePath);
                    SafeInvoke(() => UpdateMetaDisplay(fresh));
                }
                else
                {
                    ShowMessage(result?.Error ?? "Could not add comment", true);
                }
            }
            finally
            {
                _btnAddComment.Enabled = true;
            }
        }

        private void ShowFileCard(string name, string partNum, string desc, string status, Color statusColor, string lockedBy)
        {
            _pnlFileCard.Visible = true;
            _lblFileName.Text = name ?? "";
            _lblPartNumber.Text = partNum ?? "";
            _lblPartNumber.Visible = !string.IsNullOrEmpty(partNum);
            _lblDescription.Text = desc ?? "";
            _lblDescription.Visible = !string.IsNullOrEmpty(desc);
            _lblStatus.Text = status;
            _lblStatus.ForeColor = statusColor;
            _lblLockedBy.Text = lockedBy ?? "";
            _lblLockedBy.Visible = !string.IsNullOrEmpty(lockedBy);

            // Rename guard: FrameCAD creates files pre-named with their
            // part number (e.g. "26-2129-01-005.sldprt"). If the file name
            // doesn't contain its assigned part number, someone Save-As-d
            // it to a different name and parts.json may no longer track
            // the new name. Surface this passively in the card.
            var renameMismatch = false;
            if (!string.IsNullOrEmpty(partNum) && !string.IsNullOrEmpty(name))
            {
                var nameWithoutExt = System.IO.Path.GetFileNameWithoutExtension(name) ?? "";
                if (nameWithoutExt.IndexOf(partNum, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    renameMismatch = true;
                }
            }
            if (_lblRenameWarning != null)
            {
                _lblRenameWarning.Text = renameMismatch
                    ? "⚠ Filename doesn't contain the part number — may break tracking"
                    : "";
                _lblRenameWarning.Visible = renameMismatch;
            }

            LayoutAll();
        }

        private void UpdateFileDisplay(FileStatus file, string path)
        {
            if (file == null)
            {
                ShowFileCard(System.IO.Path.GetFileName(path), "", "", "Not tracked", COverlay0, "");
                SetButtonStates(false, false);
                return;
            }

            string statusText;
            Color statusColor;
            switch (file.State)
            {
                case "synced":
                    statusText = "Up to date";
                    statusColor = CGreen;
                    break;
                case "modified":
                    statusText = "Modified";
                    statusColor = CYellow;
                    break;
                case "untracked":
                    statusText = "New";
                    statusColor = COverlay0;
                    break;
                case "locked-by-you":
                    statusText = "Checked out by you";
                    statusColor = CBlue;
                    break;
                case "locked-by-other":
                    statusText = "Locked";
                    statusColor = CRed;
                    break;
                default:
                    statusText = file.State;
                    statusColor = CSubtext;
                    break;
            }

            var lockedText = !string.IsNullOrEmpty(file.LockedBy) ? file.LockedBy : "";
            ShowFileCard(file.Name, file.PartNumber, file.PartDescription, statusText, statusColor, lockedText);

            var canCheckOut = file.State != "locked-by-you" && file.State != "locked-by-other";
            var canCheckIn = file.State == "locked-by-you";
            SetButtonStates(canCheckOut, canCheckIn);
        }

        private void ShowMessage(string text, bool isError = false)
        {
            _lblMessage.Text = text;
            _lblMessage.ForeColor = isError ? CRed : CGreen;
            _messageClearTimer?.Stop();
            _messageClearTimer?.Dispose();
            _messageClearTimer = null;
            // Errors stay visible until the next ShowMessage — students
            // were missing failure feedback that vanished in 8s. Only
            // auto-clear success toasts; the next message naturally
            // replaces any lingering error.
            if (isError) return;
            // Capture the timer in a local so the closure operates on
            // *this* timer, not whatever's in _messageClearTimer when
            // the tick fires. Without this, a queued tick from an
            // earlier ShowMessage could stop the new timer and clear
            // the new message prematurely.
            var thisTimer = new Timer { Interval = 8000 };
            thisTimer.Tick += (s, e) =>
            {
                thisTimer.Stop();
                thisTimer.Dispose();
                if (!_disposed && IsHandleCreated && !string.IsNullOrEmpty(_lblMessage.Text))
                {
                    _lblMessage.Text = "";
                }
            };
            _messageClearTimer = thisTimer;
            thisTimer.Start();
        }

        private System.Collections.Generic.List<string> AssemblyTargets()
        {
            // When the active doc is an assembly, also operate on every child
            // component file. Returns the parent first, then any children.
            var targets = new System.Collections.Generic.List<string> { _currentFilePath };
            var ext = System.IO.Path.GetExtension(_currentFilePath).ToLowerInvariant();
            if (ext == ".sldasm" && OnGetAssemblyChildren != null)
            {
                try
                {
                    var children = OnGetAssemblyChildren(_currentFilePath);
                    if (children != null)
                    {
                        foreach (var c in children)
                        {
                            if (!string.IsNullOrEmpty(c) &&
                                !targets.Contains(c, StringComparer.OrdinalIgnoreCase))
                                targets.Add(c);
                        }
                    }
                }
                catch { /* fall back to single-file action */ }
            }
            return targets;
        }

        private async System.Threading.Tasks.Task DoCheckOut()
        {
            if (string.IsNullOrEmpty(_currentFilePath) || _busy) return;
            _busy = true;
            SetButtonStates(false, false);
            ShowMessage("Checking out…");
            try
            {
                var targets = AssemblyTargets();
                int ok = 0, fail = 0;
                string lastError = null;
                foreach (var p in targets)
                {
                    try
                    {
                        var result = await _api.CheckOutAsync(p);
                        if (result != null && result.Success) ok++;
                        else { fail++; if (result?.Error != null) lastError = result.Error; }
                    }
                    catch (Exception ex) { fail++; lastError = ex.Message; }
                }
                SafeInvoke(() =>
                {
                    if (targets.Count == 1)
                    {
                        if (ok == 1) ShowMessage("Checked out");
                        else ShowMessage(lastError ?? "Check out failed", true);
                    }
                    else
                    {
                        ShowMessage($"Checked out {ok} of {targets.Count} (assembly + children)",
                            fail > 0);
                    }
                });
                UpdateForDocument(_currentFilePath);
            }
            catch (Exception ex) { SafeInvoke(() => ShowMessage(ex.Message, true)); }
            finally { _busy = false; }
        }

        private async System.Threading.Tasks.Task DoCheckIn()
        {
            if (string.IsNullOrEmpty(_currentFilePath) || _busy) return;
            // Cascade preview: if this is an assembly, the children
            // get checked in too. Confirm with the user so it can't
            // happen by accident — easy to fat-finger Check In and
            // release 30 sibling locks unintentionally.
            var targets = AssemblyTargets();
            if (targets.Count > 1)
            {
                var confirm = MessageBox.Show(this,
                    $"This will release the lock on the assembly AND {targets.Count - 1} child file(s).\n\n" +
                    "Continue?",
                    "Check In Assembly",
                    MessageBoxButtons.OKCancel,
                    MessageBoxIcon.Question,
                    MessageBoxDefaultButton.Button1);
                if (confirm != DialogResult.OK) return;
            }
            _busy = true;
            SetButtonStates(false, false);
            ShowMessage("Checking in…");
            try
            {
                int ok = 0, fail = 0;
                string lastError = null;
                foreach (var p in targets)
                {
                    try
                    {
                        var result = await _api.CheckInAsync(p);
                        if (result != null && result.Success) ok++;
                        else { fail++; if (result?.Error != null) lastError = result.Error; }
                    }
                    catch (Exception ex) { fail++; lastError = ex.Message; }
                }
                SafeInvoke(() =>
                {
                    if (targets.Count == 1)
                    {
                        if (ok == 1) ShowMessage("Checked in");
                        else ShowMessage(lastError ?? "Check in failed", true);
                    }
                    else
                    {
                        ShowMessage($"Checked in {ok} of {targets.Count} (assembly + children)",
                            fail > 0);
                    }
                });
                UpdateForDocument(_currentFilePath);
            }
            catch (Exception ex) { SafeInvoke(() => ShowMessage(ex.Message, true)); }
            finally { _busy = false; }
        }

        private async System.Threading.Tasks.Task DoSync()
        {
            if (_busy) return;
            _busy = true;
            SetButtonStates(false, false);
            ShowMessage("Downloading…");
            try
            {
                var result = await _api.SyncAsync();
                SafeInvoke(() =>
                {
                    if (result.Success) ShowMessage($"Downloaded ({result.FilesUpdated} updated)");
                    else ShowMessage(result.Error ?? "Download failed", true);
                });
                if (!string.IsNullOrEmpty(_currentFilePath))
                    UpdateForDocument(_currentFilePath);
            }
            catch (Exception ex) { SafeInvoke(() => ShowMessage(ex.Message, true)); }
            finally { _busy = false; }
        }

        private async System.Threading.Tasks.Task DoPublish()
        {
            if (_busy) return;
            using (var dialog = new PublishMessageDialog())
            {
                if (dialog.ShowDialog() != DialogResult.OK) return;
                // Empty message is OK — FrameCAD generates a random 3-word label
                var message = dialog.CommitMessage ?? "";

                _busy = true;
                SetButtonStates(false, false);
                ShowMessage("Uploading…");
                try
                {
                    var result = await _api.PublishAsync(message);
                    SafeInvoke(() =>
                    {
                        if (result.Success) ShowMessage("Uploaded");
                        else ShowMessage(result.Error ?? "Upload failed", true);
                    });
                }
                catch (Exception ex) { SafeInvoke(() => ShowMessage(ex.Message, true)); }
                finally { _busy = false; }
            }
        }

        private async System.Threading.Tasks.Task DoNewPart()
        {
            if (_busy) return;
            using (var dialog = new NewPartDialog())
            {
                if (dialog.ShowDialog() != DialogResult.OK) return;
                _busy = true;
                SetButtonStates(false, false);
                try
                {
                    var desc = string.IsNullOrWhiteSpace(dialog.Description) ? null : dialog.Description;
                    if (dialog.SelectedType == NewItemType.Folder)
                    {
                        var name = dialog.ItemName;
                        if (string.IsNullOrWhiteSpace(name))
                        {
                            ShowMessage("Folder name is required", true);
                            return;
                        }
                        var result = await _api.CreateSubsystemAsync(name);
                        if (result.Success) ShowMessage($"Created {result.FolderPath}");
                        else ShowMessage(result.Error ?? "Failed", true);
                    }
                    else if (dialog.SelectedType == NewItemType.Assembly)
                    {
                        var name = dialog.ItemName;
                        if (string.IsNullOrWhiteSpace(name))
                        {
                            ShowMessage("Assembly name is required", true);
                            return;
                        }
                        var result = await _api.CreateNewAssemblyAsync(name, "", desc);
                        if (!result.Success)
                        {
                            ShowMessage(result.Error ?? "Failed", true);
                        }
                        else
                        {
                            var abs = _api.ToAbsolutePath(result.FilePath);
                            var error = OnCreateSolidWorksFile?.Invoke(abs, true);
                            if (error == null)
                            {
                                if (OnStageFile != null)
                                {
                                    try { await OnStageFile(result.FilePath); } catch { }
                                }
                                UpdateForDocument(abs);
                                ShowMessage($"Created {result.PartNumber}");
                            }
                            else
                            {
                                ShowMessage($"Reserved {result.PartNumber} - {error}", true);
                            }
                        }
                    }
                    else
                    {
                        var result = await _api.CreateNewPartAsync("", desc);
                        if (!result.Success)
                        {
                            ShowMessage(result.Error ?? "Failed", true);
                        }
                        else
                        {
                            var abs = _api.ToAbsolutePath(result.FilePath);
                            var error = OnCreateSolidWorksFile?.Invoke(abs, false);
                            if (error == null)
                            {
                                if (OnStageFile != null)
                                {
                                    try { await OnStageFile(result.FilePath); } catch { }
                                }
                                UpdateForDocument(abs);
                                ShowMessage($"Created {result.PartNumber}");
                            }
                            else
                            {
                                ShowMessage($"Reserved {result.PartNumber} - {error}", true);
                            }
                        }
                    }
                }
                catch (Exception ex) { SafeInvoke(() => ShowMessage(ex.Message, true)); }
                finally { _busy = false; ApplyButtonStates(); }
            }
        }

        private void DoOpenApp()
        {
            // Prevent spam-clicks from fork-bombing multiple FrameCAD
            // processes while the first launch is still in flight.
            // Disable the button + set the busy flag; reset both in
            // finally so a thrown exception doesn't leave the button
            // stuck disabled.
            if (_busy) return;
            _busy = true;
            _btnOpenApp.Enabled = false;
            try
            {
                // If FrameCAD is already running, just bring its window
                // to the foreground.
                var existing = System.Diagnostics.Process.GetProcessesByName("FrameCAD");
                try
                {
                    foreach (var proc in existing)
                    {
                        var hwnd = proc.MainWindowHandle;
                        if (hwnd != IntPtr.Zero)
                        {
                            if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
                            SetForegroundWindow(hwnd);
                            return;
                        }
                    }
                }
                finally
                {
                    foreach (var proc in existing) proc.Dispose();
                }

                string target = LocateFrameCADExe();
                if (target != null)
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo { FileName = target, UseShellExecute = true });
                else
                    ShowMessage("FrameCAD not found — please reinstall or open it manually first.", true);
            }
            finally
            {
                _busy = false;
                _btnOpenApp.Enabled = true;
            }
        }

        /// <summary>
        /// Find the installed FrameCAD.exe across every layout we've seen:
        /// 1. Windows uninstall registry (NSIS writes InstallLocation here on install — most
        ///    reliable, works for custom install dirs the user picked at install time).
        /// 2. Hard-coded fallback paths for the default per-machine and per-user installs.
        /// 3. Directory walk of Program Files / LocalAppData\Programs looking for any
        ///    "framecad"-named subfolder (case-insensitive) containing FrameCAD.exe.
        /// Returns null if nothing matches.
        /// </summary>
        private static string LocateFrameCADExe()
        {
            // ── 1. Registry ──────────────────────────────────────────────
            // electron-builder NSIS writes the uninstall entry under the
            // appId (com.trentcad.app, kept for v1.0.x → v1.1.x update
            // chain). Per-machine installs land in HKLM; per-user in HKCU.
            // On 64-bit Windows the 64-bit NSIS template writes to the
            // native key, but check WOW6432Node too for older 32-bit builds.
            string[] registryRoots = new[] {
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\com.trentcad.app",
                @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\com.trentcad.app",
            };
            foreach (var subPath in registryRoots)
            {
                foreach (var root in new[] { Microsoft.Win32.Registry.LocalMachine, Microsoft.Win32.Registry.CurrentUser })
                {
                    string fromRegistry = TryRegistryInstallLocation(root, subPath);
                    if (fromRegistry != null) return fromRegistry;
                }
            }

            // ── 2. Hard-coded fallback paths ─────────────────────────────
            // Order matters: check fresh installs first, then legacy
            // TrentCAD layouts that v1.0.x users may have upgraded in place.
            var localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var progFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            var candidates = new[] {
                System.IO.Path.Combine(localData, "Programs", "framecad", "FrameCAD.exe"),
                System.IO.Path.Combine(localData, "Programs", "FrameCAD", "FrameCAD.exe"),
                System.IO.Path.Combine(progFiles, "FrameCAD", "FrameCAD.exe"),
                System.IO.Path.Combine(progFilesX86, "FrameCAD", "FrameCAD.exe"),
                System.IO.Path.Combine(localData, "Programs", "trentcad", "FrameCAD.exe"),
                System.IO.Path.Combine(localData, "Programs", "trentcad", "TrentCAD.exe"),
                System.IO.Path.Combine(progFiles, "TrentCAD", "TrentCAD.exe"),
                System.IO.Path.Combine(progFilesX86, "TrentCAD", "TrentCAD.exe"),
            };
            foreach (var c in candidates)
            {
                if (System.IO.File.Exists(c)) return c;
            }

            // ── 3. Directory walk ────────────────────────────────────────
            // Final fallback: scan one level deep under each Programs root
            // for any folder whose name contains "framecad" (case-insensitive)
            // and pick the first FrameCAD.exe / TrentCAD.exe inside. Catches
            // version-suffixed dirs, capitalisation oddities, and users who
            // installed to a custom-named subdirectory.
            var roots = new[] {
                System.IO.Path.Combine(localData, "Programs"),
                progFiles,
                progFilesX86,
            };
            foreach (var root in roots)
            {
                if (string.IsNullOrEmpty(root) || !System.IO.Directory.Exists(root)) continue;
                try
                {
                    foreach (var dir in System.IO.Directory.GetDirectories(root))
                    {
                        var name = System.IO.Path.GetFileName(dir);
                        // Path.GetFileName can return null on degenerate inputs;
                        // skip those rather than NRE'ing on .IndexOf.
                        if (string.IsNullOrEmpty(name)) continue;
                        if (name.IndexOf("framecad", StringComparison.OrdinalIgnoreCase) < 0 &&
                            name.IndexOf("trentcad", StringComparison.OrdinalIgnoreCase) < 0) continue;
                        foreach (var exeName in new[] { "FrameCAD.exe", "TrentCAD.exe" })
                        {
                            var exe = System.IO.Path.Combine(dir, exeName);
                            if (System.IO.File.Exists(exe)) return exe;
                        }
                    }
                }
                catch { /* permission denied on a Programs subdir — skip */ }
            }

            return null;
        }

        private static string TryRegistryInstallLocation(Microsoft.Win32.RegistryKey root, string subKeyPath)
        {
            try
            {
                using (var key = root.OpenSubKey(subKeyPath))
                {
                    if (key == null) return null;
                    var location = key.GetValue("InstallLocation") as string;
                    if (string.IsNullOrEmpty(location)) return null;
                    var exe = System.IO.Path.Combine(location, "FrameCAD.exe");
                    if (System.IO.File.Exists(exe)) return exe;
                    var legacyExe = System.IO.Path.Combine(location, "TrentCAD.exe");
                    if (System.IO.File.Exists(legacyExe)) return legacyExe;
                    return null;
                }
            }
            catch { return null; }
        }

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        private const int SW_RESTORE = 9;
    }

    internal class BufferedPanel : Panel
    {
        public BufferedPanel()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint, true);
        }
    }

    internal class StatusDot : Control
    {
        private Color _color = Color.Gray;
        public Color DotColor
        {
            get => _color;
            set { _color = value; Invalidate(); }
        }

        public StatusDot()
        {
            SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.OptimizedDoubleBuffer, true);
            Size = new Size(10, 10);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var brush = new SolidBrush(_color))
                e.Graphics.FillEllipse(brush, 1, 1, Width - 2, Height - 2);
        }
    }
}
