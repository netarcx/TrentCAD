using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Threading;
using Newtonsoft.Json;
using System.Threading.Tasks;
using FrameCAD.SolidWorksAddin.Models;

namespace FrameCAD.SolidWorksAddin
{
    public class FrameCadApiClient
    {
        // Global HttpClient timeout is disabled — each call sets its
        // own deadline via CancellationTokenSource. This is the only
        // way to give long-running ops (publish, sync of big
        // assemblies) more than the short timeout used for everything
        // else. Setting HttpClient.Timeout is global; HttpClient
        // applies min(globalTimeout, perCallTokenDeadline) so without
        // this you can't ever wait longer than the global.
        private static readonly HttpClient Client = new HttpClient(
            new HttpClientHandler { UseProxy = false, Proxy = null, UseDefaultCredentials = false })
        {
            Timeout = Timeout.InfiniteTimeSpan
        };

        // Default deadline for snappy ops (status, file lookup, meta).
        // If FrameCAD is unresponsive past this, surface the failure
        // rather than hang the task pane.
        private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(30);

        // Long-running ops that upload/download from the team's Google
        // Shared Drive. Bigger robot assemblies routinely take >1 min on
        // a slow uplink; 10 min is generous but bounded so a wedged
        // server doesn't hang the UI forever.
        private static readonly TimeSpan LongTimeout = TimeSpan.FromMinutes(10);

        private readonly string _baseUrl;
        private string _projectRoot;

        public FrameCadApiClient(int port = 42129)
        {
            _baseUrl = $"http://127.0.0.1:{port}";
        }

        public string ToRelativePath(string absolutePath)
        {
            if (string.IsNullOrEmpty(_projectRoot) || string.IsNullOrEmpty(absolutePath))
                return absolutePath;

            var normalized = absolutePath.Replace("\\", "/");
            var root = _projectRoot.Replace("\\", "/").TrimEnd('/') + "/";

            if (normalized.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                return normalized.Substring(root.Length);

            return absolutePath;
        }

        public string ToAbsolutePath(string relativePath)
        {
            if (string.IsNullOrEmpty(_projectRoot) || string.IsNullOrEmpty(relativePath))
                return relativePath;
            return System.IO.Path.Combine(
                _projectRoot,
                relativePath.Replace("/", System.IO.Path.DirectorySeparatorChar.ToString()));
        }

        // --- HTTP helpers ---------------------------------------------------

        private static CancellationTokenSource NewDeadline(TimeSpan timeout) => new CancellationTokenSource(timeout);

        private async Task<HttpResponseMessage> GetAsync(string path, TimeSpan? timeout = null)
        {
            using (var cts = NewDeadline(timeout ?? DefaultTimeout))
            {
                return await Client.GetAsync($"{_baseUrl}{path}", cts.Token);
            }
        }

        private async Task<HttpResponseMessage> PostJsonAsync(string path, object body, TimeSpan? timeout = null)
        {
            var json = body == null ? "{}" : JsonConvert.SerializeObject(body);
            using (var content = new StringContent(json, Encoding.UTF8, "application/json"))
            using (var cts = NewDeadline(timeout ?? DefaultTimeout))
            {
                return await Client.PostAsync($"{_baseUrl}{path}", content, cts.Token);
            }
        }

        // --- API surface -----------------------------------------------------

        public async Task<HealthResponse> GetHealthAsync()
        {
            var response = await GetAsync("/api/health");
            response.EnsureSuccessStatusCode();
            var json = await response.Content.ReadAsStringAsync();
            var health = JsonConvert.DeserializeObject<HealthResponse>(json);

            if (health?.Project?.Path != null)
                _projectRoot = health.Project.Path;

            return health;
        }

        public async Task<bool> IsConnectedAsync()
        {
            try
            {
                var health = await GetHealthAsync();
                return health?.Running == true;
            }
            catch
            {
                return false;
            }
        }

        public async Task<FileStatus> GetFileAsync(string absolutePath)
        {
            var relativePath = ToRelativePath(absolutePath);
            var encoded = Uri.EscapeDataString(relativePath);
            var response = await GetAsync($"/api/file?path={encoded}");

            if (!response.IsSuccessStatusCode)
                return null;

            var json = await response.Content.ReadAsStringAsync();
            return JsonConvert.DeserializeObject<FileStatus>(json);
        }

        public async Task<ApiResult> CheckOutAsync(string absolutePath)
        {
            var relativePath = ToRelativePath(absolutePath);
            var response = await PostJsonAsync("/api/checkout", new { path = relativePath });
            var json = await response.Content.ReadAsStringAsync();
            return JsonConvert.DeserializeObject<ApiResult>(json);
        }

        public async Task<ApiResult> CheckInAsync(string absolutePath)
        {
            var relativePath = ToRelativePath(absolutePath);
            var response = await PostJsonAsync("/api/checkin", new { path = relativePath });
            var json = await response.Content.ReadAsStringAsync();
            return JsonConvert.DeserializeObject<ApiResult>(json);
        }

        /// <summary>
        /// Ask FrameCAD to start tracking a newly-created file before the user's
        /// first publish. Best-effort — caller swallows errors because the file
        /// will still surface as "untracked" in the next status refresh. (On the
        /// Drive backend the server has no staging index, so this is a cheap
        /// acknowledgement; kept for forward-compatibility.)
        /// </summary>
        public async Task<ApiResult> StageAsync(string relativePath)
        {
            var response = await PostJsonAsync("/api/stage", new { path = relativePath });
            if (!response.IsSuccessStatusCode)
                return new ApiResult { Success = false, Error = $"HTTP {(int)response.StatusCode}" };
            var json = await response.Content.ReadAsStringAsync();
            return JsonConvert.DeserializeObject<ApiResult>(json)
                ?? new ApiResult { Success = false, Error = "Empty response" };
        }

        /// <summary>
        /// Report a SolidWorks-native rename / Save-As (absolute paths) so the
        /// FrameCAD manifest + metadata move BY IDENTITY. The desktop decides
        /// copy-vs-rename (old file still on disk = copy → no move). Resolves the
        /// project root via /api/health first if it isn't known yet, because this
        /// client is often freshly constructed off a save-event with no prior call.
        /// </summary>
        public async Task<ApiResult> RenameAsync(string oldAbsolutePath, string newAbsolutePath)
        {
            if (string.IsNullOrEmpty(_projectRoot))
            {
                try { await GetHealthAsync(); } catch { /* fall back to abs paths */ }
            }
            var oldRel = ToRelativePath(oldAbsolutePath);
            var newRel = ToRelativePath(newAbsolutePath);
            var response = await PostJsonAsync("/api/rename", new { oldPath = oldRel, newPath = newRel });
            if (!response.IsSuccessStatusCode)
                return new ApiResult { Success = false, Error = $"HTTP {(int)response.StatusCode}" };
            var json = await response.Content.ReadAsStringAsync();
            return JsonConvert.DeserializeObject<ApiResult>(json)
                ?? new ApiResult { Success = false, Error = "Empty response" };
        }

        /// <summary>
        /// Part numbers assigned offline that a teammate had already taken (the
        /// desktop's reconcile pass surfaces these). The add-in shows them and
        /// guides a references-preserving SolidWorks rename to the suggested
        /// number. Returns an empty list when unreachable.
        /// </summary>
        public async Task<List<NumberConflict>> GetNumberConflictsAsync()
        {
            var response = await GetAsync("/api/number-conflicts");
            if (!response.IsSuccessStatusCode) return new List<NumberConflict>();
            var json = await response.Content.ReadAsStringAsync();
            var result = JsonConvert.DeserializeObject<NumberConflictsResponse>(json);
            return result?.Conflicts ?? new List<NumberConflict>();
        }

        public async Task<SyncResult> SyncAsync()
        {
            // Long timeout — pulling a big assembly down from the team's
            // Shared Drive can take minutes on a slow link.
            var response = await PostJsonAsync("/api/sync", new { }, LongTimeout);
            var json = await response.Content.ReadAsStringAsync();
            // Coalesce: an empty/non-JSON body (e.g. a bare HTTP 500 with no
            // payload) deserializes to null, and the caller dereferences
            // .Success — an NRE that masks the real server error.
            return JsonConvert.DeserializeObject<SyncResult>(json)
                ?? new SyncResult { Success = false, Error = $"Sync failed (HTTP {(int)response.StatusCode})" };
        }

        public async Task<PublishResult> PublishAsync(string message)
        {
            // Long timeout — same reason as sync, but worse: publish uploads
            // changed files to the Shared Drive. A 10s ceiling would let the
            // server happily complete while the add-in shows a misleading
            // "Upload failed" toast.
            var response = await PostJsonAsync("/api/publish", new { message }, LongTimeout);
            var json = await response.Content.ReadAsStringAsync();
            return JsonConvert.DeserializeObject<PublishResult>(json)
                ?? new PublishResult { Success = false, Error = $"Publish failed (HTTP {(int)response.StatusCode})" };
        }

        public async Task<CreatePartResult> CreateNewPartAsync(string folder = "", string description = null)
        {
            var obj = new Dictionary<string, string> { { "folder", folder } };
            if (description != null) obj["description"] = description;
            var response = await PostJsonAsync("/api/parts/new-part", obj);
            var json = await response.Content.ReadAsStringAsync();
            // Coalesce like Sync/Publish — an empty/non-JSON error body would
            // otherwise return null and NRE in the caller's .Success check.
            return JsonConvert.DeserializeObject<CreatePartResult>(json)
                ?? new CreatePartResult { Success = false, Error = $"Create failed (HTTP {(int)response.StatusCode})" };
        }

        public async Task<CreatePartResult> CreateNewAssemblyAsync(string name, string parentFolder = "", string description = null)
        {
            var obj = new Dictionary<string, string> { { "name", name }, { "parentFolder", parentFolder } };
            if (description != null) obj["description"] = description;
            var response = await PostJsonAsync("/api/parts/new-assembly", obj);
            var json = await response.Content.ReadAsStringAsync();
            return JsonConvert.DeserializeObject<CreatePartResult>(json)
                ?? new CreatePartResult { Success = false, Error = $"Create failed (HTTP {(int)response.StatusCode})" };
        }

        public async Task<CreateSubsystemResult> CreateSubsystemAsync(string name, string parentFolder = "")
        {
            var obj = new Dictionary<string, string> { { "name", name }, { "parentFolder", parentFolder } };
            var response = await PostJsonAsync("/api/parts/new-subsystem", obj);
            var json = await response.Content.ReadAsStringAsync();
            return JsonConvert.DeserializeObject<CreateSubsystemResult>(json)
                ?? new CreateSubsystemResult { Success = false, Error = $"Create failed (HTTP {(int)response.StatusCode})" };
        }

        public async Task<List<PendingCreate>> GetPendingCreatesAsync()
        {
            var response = await GetAsync("/api/pending-creates");
            response.EnsureSuccessStatusCode();
            var json = await response.Content.ReadAsStringAsync();
            return JsonConvert.DeserializeObject<List<PendingCreate>>(json);
        }

        public async Task MarkPendingDoneAsync(string id, string error = null)
        {
            // Mirror MarkExportDoneAsync: passing `error` lets the desktop keep
            // the create QUEUED for a bounded number of retries instead of
            // silently orphaning the reserved part number when the file couldn't
            // be created (e.g. no default part template configured).
            // EnsureSuccessStatusCode so a 5xx surfaces instead of silently
            // looking like success — caller can retry / log.
            object payload = error == null ? (object)new { id } : new { id, error };
            var response = await PostJsonAsync("/api/pending-creates/done", payload);
            response.EnsureSuccessStatusCode();
        }

        public async Task<List<PendingExport>> GetPendingExportsAsync()
        {
            var response = await GetAsync("/api/pending-exports");
            response.EnsureSuccessStatusCode();
            var json = await response.Content.ReadAsStringAsync();
            return JsonConvert.DeserializeObject<List<PendingExport>>(json);
        }

        public async Task MarkExportDoneAsync(string id, string error = null)
        {
            object payload = error == null ? (object)new { id } : new { id, error };
            var response = await PostJsonAsync("/api/pending-exports/done", payload);
            response.EnsureSuccessStatusCode();
        }

        public async Task<List<LockInfo>> GetLocksAsync()
        {
            var response = await GetAsync("/api/locks");
            response.EnsureSuccessStatusCode();
            var json = await response.Content.ReadAsStringAsync();
            return JsonConvert.DeserializeObject<List<LockInfo>>(json);
        }

        /// <summary>
        /// Bring the FrameCAD main window to the foreground.
        /// </summary>
        public async Task<ApiResult> FocusFrameCadAsync()
        {
            try
            {
                var response = await PostJsonAsync("/api/focus", new { });
                var json = await response.Content.ReadAsStringAsync();
                return JsonConvert.DeserializeObject<ApiResult>(json) ?? new ApiResult { Success = false, Error = "Empty response" };
            }
            catch (Exception ex)
            {
                return new ApiResult { Success = false, Error = ex.Message };
            }
        }

        /// <summary>
        /// Fetch the per-part metadata blob (release state, comments, mass, cost, etc.)
        /// for the file at the given absolute path. Returns null if no metadata exists.
        /// </summary>
        public async Task<PartMetaDto> GetPartMetaAsync(string absolutePath)
        {
            var relativePath = ToRelativePath(absolutePath);
            var encoded = Uri.EscapeDataString(relativePath);
            try
            {
                var response = await GetAsync($"/api/meta?path={encoded}");
                if (!response.IsSuccessStatusCode) return null;
                var json = await response.Content.ReadAsStringAsync();
                return JsonConvert.DeserializeObject<PartMetaDto>(json);
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// Set the part's release state (draft / in-review / released / manufactured).
        /// Optional `note` carries operator initials or sign-off text — used by
        /// the shop-floor "mark manufactured" flow to record who finished a part.
        /// </summary>
        public async Task<ApiResult> SetReleaseStateAsync(string absolutePath, string state, string note = null)
        {
            var relativePath = ToRelativePath(absolutePath);
            object payload = note == null
                ? (object)new { path = relativePath, state }
                : new { path = relativePath, state, note };
            try
            {
                var response = await PostJsonAsync("/api/release-state", payload);
                var json = await response.Content.ReadAsStringAsync();
                return JsonConvert.DeserializeObject<ApiResult>(json) ?? new ApiResult { Success = false, Error = "Empty response" };
            }
            catch (Exception ex)
            {
                return new ApiResult { Success = false, Error = ex.Message };
            }
        }

        /// <summary>
        /// Fetch the bundle of values to fill into a drawing's title
        /// block (part number, description, material, mass, designer,
        /// date). Returns null on any failure.
        /// </summary>
        public async Task<TitleBlockDataDto> GetTitleBlockDataAsync(string absolutePath)
        {
            var relativePath = ToRelativePath(absolutePath);
            var encoded = Uri.EscapeDataString(relativePath);
            try
            {
                var response = await GetAsync($"/api/title-block-data?path={encoded}");
                if (!response.IsSuccessStatusCode) return null;
                var json = await response.Content.ReadAsStringAsync();
                return JsonConvert.DeserializeObject<TitleBlockDataDto>(json);
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// Push a SolidWorks-computed mass (in pounds) for the given file.
        /// Used by the SW add-in's FileSavePostNotify hook so the user
        /// doesn't have to manually type mass into FrameCAD every save.
        /// </summary>
        public async Task<ApiResult> SetPartMassAutoAsync(string absolutePath, double massPounds)
        {
            var relativePath = ToRelativePath(absolutePath);
            try
            {
                var response = await PostJsonAsync("/api/part-mass-auto", new { path = relativePath, mass = massPounds });
                var json = await response.Content.ReadAsStringAsync();
                return JsonConvert.DeserializeObject<ApiResult>(json) ?? new ApiResult { Success = false, Error = "Empty response" };
            }
            catch (Exception ex)
            {
                return new ApiResult { Success = false, Error = ex.Message };
            }
        }

        /// <summary>
        /// Set the part's manufacturing material in FrameCAD metadata.
        /// </summary>
        public async Task<ApiResult> SetManufacturingMaterialAsync(string absolutePath, string material)
        {
            var relativePath = ToRelativePath(absolutePath);
            try
            {
                var response = await PostJsonAsync("/api/material", new { path = relativePath, material });
                var json = await response.Content.ReadAsStringAsync();
                return JsonConvert.DeserializeObject<ApiResult>(json) ?? new ApiResult { Success = false, Error = "Empty response" };
            }
            catch (Exception ex)
            {
                return new ApiResult { Success = false, Error = ex.Message };
            }
        }

        /// <summary>
        /// Set the part's manufacturing method (print/cnc/manual/other).
        /// Pass null or empty to clear. Required so released parts show up
        /// on the correct tab of FrameCAD's manufacturing queue.
        /// </summary>
        public async Task<ApiResult> SetManufacturingMethodAsync(string absolutePath, string method)
        {
            var relativePath = ToRelativePath(absolutePath);
            try
            {
                // method = null sends `{ path, method: null }` so the server clears the field.
                var response = await PostJsonAsync("/api/manufacturing-method", new { path = relativePath, method });
                var json = await response.Content.ReadAsStringAsync();
                return JsonConvert.DeserializeObject<ApiResult>(json) ?? new ApiResult { Success = false, Error = "Empty response" };
            }
            catch (Exception ex)
            {
                return new ApiResult { Success = false, Error = ex.Message };
            }
        }

        /// <summary>
        /// Append a comment to the part's metadata. Author is resolved
        /// server-side from the enrolled team-server member name.
        /// </summary>
        public async Task<ApiResult> AddCommentAsync(string absolutePath, string text)
        {
            var relativePath = ToRelativePath(absolutePath);
            try
            {
                var response = await PostJsonAsync("/api/comments", new { path = relativePath, text });
                var json = await response.Content.ReadAsStringAsync();
                return JsonConvert.DeserializeObject<ApiResult>(json) ?? new ApiResult { Success = false, Error = "Empty response" };
            }
            catch (Exception ex)
            {
                return new ApiResult { Success = false, Error = ex.Message };
            }
        }

        /// <summary>
        /// Fetch the current user's team-server role so the add-in can gate
        /// UI elements (e.g. hide released/manufactured release pills for
        /// students) to match the desktop's role tiers. Returns null on any
        /// failure — caller should treat that as "unknown role" and fall back
        /// to allowing everything, since standalone mode (not enrolled with a
        /// team server) genuinely has no roles.
        /// </summary>
        public async Task<CoordStateDto> GetCoordStateAsync()
        {
            try
            {
                var response = await GetAsync("/api/coord-state");
                if (!response.IsSuccessStatusCode) return null;
                var json = await response.Content.ReadAsStringAsync();
                return JsonConvert.DeserializeObject<CoordStateDto>(json);
            }
            catch
            {
                return null;
            }
        }
    }
}
