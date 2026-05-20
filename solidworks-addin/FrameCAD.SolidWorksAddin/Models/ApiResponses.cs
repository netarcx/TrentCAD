using System.Collections.Generic;
using Newtonsoft.Json;

namespace FrameCAD.SolidWorksAddin.Models
{
    public class PartCommentDto
    {
        [JsonProperty("id")]
        public string Id { get; set; }

        [JsonProperty("author")]
        public string Author { get; set; }

        [JsonProperty("text")]
        public string Text { get; set; }

        [JsonProperty("at")]
        public string At { get; set; }
    }

    public class PartReleaseInfoDto
    {
        [JsonProperty("state")]
        public string State { get; set; }

        [JsonProperty("by")]
        public string By { get; set; }

        [JsonProperty("at")]
        public string At { get; set; }

        [JsonProperty("note")]
        public string Note { get; set; }
    }

    /// <summary>
    /// Bundle of values the drawing title-block fill button writes to SW
    /// custom properties. Server-side composition pulls part number from
    /// the parts manifest, mass/material from the linked part's meta,
    /// and designer from `git config user.name`.
    /// </summary>
    public class TitleBlockDataDto
    {
        [JsonProperty("partNumber")]
        public string PartNumber { get; set; }

        [JsonProperty("description")]
        public string Description { get; set; }

        [JsonProperty("material")]
        public string Material { get; set; }

        [JsonProperty("mass")]
        public string Mass { get; set; }

        [JsonProperty("designer")]
        public string Designer { get; set; }

        [JsonProperty("date")]
        public string Date { get; set; }
    }

    public class PartMetaDto
    {
        [JsonProperty("release")]
        public PartReleaseInfoDto Release { get; set; }

        [JsonProperty("comments")]
        public List<PartCommentDto> Comments { get; set; }

        [JsonProperty("manufacturingNotes")]
        public string ManufacturingNotes { get; set; }

        [JsonProperty("mass")]
        public double? Mass { get; set; }

        [JsonProperty("cost")]
        public double? Cost { get; set; }

        [JsonProperty("manufacturingMethod")]
        public string ManufacturingMethod { get; set; }

        [JsonProperty("manufacturingMaterial")]
        public string ManufacturingMaterial { get; set; }
    }

    public class HealthResponse
    {
        [JsonProperty("running")]
        public bool Running { get; set; }

        [JsonProperty("project")]
        public ProjectInfo Project { get; set; }
    }

    public class ProjectInfo
    {
        [JsonProperty("name")]
        public string Name { get; set; }

        [JsonProperty("path")]
        public string Path { get; set; }

        [JsonProperty("remote")]
        public string Remote { get; set; }
    }

    public class ApiResult
    {
        [JsonProperty("success")]
        public bool Success { get; set; }

        [JsonProperty("error")]
        public string Error { get; set; }
    }

    public class SyncResult
    {
        [JsonProperty("success")]
        public bool Success { get; set; }

        [JsonProperty("filesUpdated")]
        public int FilesUpdated { get; set; }

        [JsonProperty("error")]
        public string Error { get; set; }
    }

    public class PublishResult
    {
        [JsonProperty("success")]
        public bool Success { get; set; }

        [JsonProperty("hash")]
        public string Hash { get; set; }

        [JsonProperty("error")]
        public string Error { get; set; }
    }

    public class CreatePartResult
    {
        [JsonProperty("success")]
        public bool Success { get; set; }

        [JsonProperty("partNumber")]
        public string PartNumber { get; set; }

        [JsonProperty("filePath")]
        public string FilePath { get; set; }

        [JsonProperty("error")]
        public string Error { get; set; }
    }

    public class CreateSubsystemResult
    {
        [JsonProperty("success")]
        public bool Success { get; set; }

        [JsonProperty("folderPath")]
        public string FolderPath { get; set; }

        [JsonProperty("error")]
        public string Error { get; set; }
    }

    public class PendingCreate
    {
        [JsonProperty("id")]
        public string Id { get; set; }

        [JsonProperty("type")]
        public string Type { get; set; }

        [JsonProperty("relativePath")]
        public string RelativePath { get; set; }

        [JsonProperty("absolutePath")]
        public string AbsolutePath { get; set; }

        [JsonProperty("partNumber")]
        public string PartNumber { get; set; }
    }

    /// <summary>
    /// One pending CAM export task. FrameCAD enqueues these when a CNC
    /// or 3D-print part is released; the add-in performs the SaveAs
    /// against the resolved target path and posts /done.
    /// </summary>
    public class PendingExport
    {
        [JsonProperty("id")]
        public string Id { get; set; }

        [JsonProperty("sourceRelPath")]
        public string SourceRelPath { get; set; }

        [JsonProperty("sourceAbsPath")]
        public string SourceAbsPath { get; set; }

        [JsonProperty("targetRelPath")]
        public string TargetRelPath { get; set; }

        [JsonProperty("targetAbsPath")]
        public string TargetAbsPath { get; set; }

        /// <summary>"step" or "stl".</summary>
        [JsonProperty("format")]
        public string Format { get; set; }

        [JsonProperty("enqueuedAt")]
        public long EnqueuedAt { get; set; }
    }

    public class LockInfo
    {
        [JsonProperty("path")]
        public string Path { get; set; }

        [JsonProperty("owner")]
        public string Owner { get; set; }

        [JsonProperty("id")]
        public string Id { get; set; }
    }

    /// <summary>
    /// Minimal coordination-repo state for UI gating in the add-in.
    /// Mirrors what /api/coord-state returns — intentionally NOT the
    /// full members.json (we don't want to leak the team roster
    /// through the local REST surface).
    /// </summary>
    public class CoordStateDto
    {
        /// <summary>Whether a coordination repo is connected at all.</summary>
        [JsonProperty("configured")]
        public bool Configured { get; set; }

        /// <summary>"admin", "mentor", "student", or null when unknown / standalone.</summary>
        [JsonProperty("role")]
        public string Role { get; set; }

        [JsonProperty("isMember")]
        public bool IsMember { get; set; }

        /// <summary>True if the user can sign off on releases / mark manufactured / force-release locks.</summary>
        public bool IsMentor =>
            !Configured || Role == "admin" || Role == "mentor";

        public bool IsAdmin =>
            !Configured || Role == "admin";
    }
}
