using System.Text.Json.Serialization;

namespace WikiLibrary.Models;

public class SupabaseUser
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("email")]
    public string Email { get; set; } = "";

    public bool IsOwner => !string.IsNullOrWhiteSpace(Email) &&
                           string.Equals(Email.Trim(), "abhikr6714@gmail.com", StringComparison.OrdinalIgnoreCase);
}

public class SupabaseAuthResult
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("user")]
    public SupabaseUser? User { get; set; }

    [JsonPropertyName("session")]
    public bool HasSession { get; set; }
}

public class FileUploadResult
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("filePath")]
    public string? FilePath { get; set; }

    [JsonPropertyName("publicUrl")]
    public string? PublicUrl { get; set; }

    [JsonPropertyName("fileSize")]
    public long FileSize { get; set; }
}

public class SubmissionOperationResult
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("submission")]
    public BookSubmission? Submission { get; set; }
}
