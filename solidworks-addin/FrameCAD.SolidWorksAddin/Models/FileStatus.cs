using System.Collections.Generic;
using Newtonsoft.Json;

namespace FrameCAD.SolidWorksAddin.Models
{
    public class FileStatus
    {
        [JsonProperty("path")]
        public string Path { get; set; } = "";

        [JsonProperty("name")]
        public string Name { get; set; } = "";

        [JsonProperty("isDirectory")]
        public bool IsDirectory { get; set; }

        [JsonProperty("state")]
        public string State { get; set; } = "synced";

        [JsonProperty("lockedBy")]
        public string LockedBy { get; set; }

        [JsonProperty("partNumber")]
        public string PartNumber { get; set; }

        [JsonProperty("partDescription")]
        public string PartDescription { get; set; }

        /// <summary>
        /// VESTIGIAL — the Drive backend currently has no cheap per-file
        /// freshness probe, so /api/file always returns false here and the
        /// task pane's "newer version available" banner never fires. Kept as a
        /// reserved hook for a future Drive modifiedTime/md5 check; do not rely
        /// on it. (It once meant "origin has a commit newer than HEAD for this
        /// file" on the old Git backend.)
        /// </summary>
        [JsonProperty("newerOnRemote")]
        public bool NewerOnRemote { get; set; }

        [JsonProperty("children")]
        public List<FileStatus> Children { get; set; }
    }
}
