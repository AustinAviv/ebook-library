using System.Text.Json.Serialization;

namespace WikiLibrary.Models;

public class BookSubmission
{
    [JsonPropertyName("id")]
    public long Id { get; set; }

    [JsonPropertyName("title")]
    public string Title { get; set; } = "";

    [JsonPropertyName("author")]
    public string? Author { get; set; }

    [JsonPropertyName("description")]
    public string? Description { get; set; }

    [JsonPropertyName("category")]
    public string? Category { get; set; }

    [JsonPropertyName("year")]
    public int Year { get; set; }

    [JsonPropertyName("language")]
    public string? Language { get; set; } = "English";

    [JsonPropertyName("pages")]
    public int Pages { get; set; }

    [JsonPropertyName("file_size")]
    public long FileSize { get; set; }

    [JsonPropertyName("file_path")]
    public string FilePath { get; set; } = "";

    [JsonPropertyName("public_url")]
    public string PublicUrl { get; set; } = "";

    [JsonPropertyName("status")]
    public string Status { get; set; } = "pending"; // "pending", "accepted", "rejected"

    [JsonPropertyName("rejection_reason")]
    public string? RejectionReason { get; set; }

    [JsonPropertyName("submitted_by")]
    public string? SubmittedBy { get; set; }

    [JsonPropertyName("submitter_name")]
    public string? SubmitterName { get; set; }

    [JsonPropertyName("submitter_email")]
    public string? SubmitterEmail { get; set; }

    [JsonPropertyName("created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    [JsonPropertyName("reviewed_at")]
    public DateTime? ReviewedAt { get; set; }

    [JsonPropertyName("reviewed_by")]
    public string? ReviewedBy { get; set; }

    public bool IsPending => string.Equals(Status, "pending", StringComparison.OrdinalIgnoreCase);
    public bool IsAccepted => string.Equals(Status, "accepted", StringComparison.OrdinalIgnoreCase);
    public bool IsRejected => string.Equals(Status, "rejected", StringComparison.OrdinalIgnoreCase);

    public string StatusBadgeClass => Status switch
    {
        "accepted" => "badge-status-accepted",
        "rejected" => "badge-status-rejected",
        _ => "badge-status-pending"
    };

    public string StatusDisplayName => Status switch
    {
        "accepted" => "Accepted & Published",
        "rejected" => "Rejected",
        _ => "Pending Review"
    };

    public string FileSizeText
    {
        get
        {
            if (FileSize <= 0) return "-";
            double mb = FileSize / (1024.0 * 1024.0);
            if (mb >= 1.0)
                return $"{mb:F1} MB";
            double kb = FileSize / 1024.0;
            return $"{kb:F0} KB";
        }
    }
}
